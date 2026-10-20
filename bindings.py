"""Session-to-topic bindings: the index that files non-adapter sessions under topics.

Bindings are high-churn, session-scoped and unbounded, so they live in a plugin-private SQLite store under the profile's plugin-data dir, not in config.yaml: the registry (topic_store.py) is the low-churn half and stays there. Clients never see the index: the REST surface resolves a thread's topic server-side (GET /threads), so a binding is written once by POST /threads/bind and read back only through that resolution. A binding is therefore visible to every client the moment it lands, with no sync frames and no stamp to gate on.

Keys are lineage roots (the durable id that survives compression), so a mid-thread rotation never orphans a binding. Bindings to a topic that no longer exists are pruned when the registry changes; bindings to a session that no longer exists are swept opportunistically on the write paths, once the index is big enough for the check to matter.

The gateway process and the serve process both mount the plugin's REST surface; both open this store. SQLite with WAL and a busy timeout keeps the two honest, and per-operation connections keep the code free of thread-affinity assumptions.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time
from collections.abc import Iterable, Mapping
from contextlib import closing
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# A binding key is a session's lineage root, the id shape state.db mints; loose on purpose, the store does not re-derive session ids.
_ROOT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DB_NAME = "bindings.db"
# Below this index size a dead-root sweep is not worth the per-root session lookups; above it, the sweep runs on every bind and unbind.
_SWEEP_THRESHOLD = 200


class BindingError(ValueError):
    """A binding request that cannot be stored, carrying the reason to send back."""


def data_dir() -> Path:
    """The plugin's private data dir: ``<hermes home>/plugin-data/topoi``."""
    from hermes_constants import get_hermes_home

    path = get_hermes_home() / "plugin-data" / "topoi"
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    return data_dir() / _DB_NAME


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=5.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS bindings ("
        " lineage_root TEXT PRIMARY KEY,"
        " topic_id TEXT NOT NULL,"
        " updated_at INTEGER NOT NULL)"
    )
    return conn


def _apply(statements: list[tuple[str, tuple]]) -> int:
    """Run write statements in one short transaction and return the row-change count; the store is small, so per-operation connections stay cheap and keep the two mounting processes from sharing a handle."""
    with closing(_connect()) as conn, conn:
        before = conn.total_changes
        for sql, params in statements:
            conn.execute(sql, params)
        return conn.total_changes - before


def _read_all(sql: str, params: tuple = ()) -> list[tuple]:
    with closing(_connect()) as conn:
        return conn.execute(sql, params).fetchall()


def set_binding(root: str, topic_id: str) -> None:
    """Store one session-to-topic binding, replacing any previous topic for that root.

    The topic's liveness is the caller's check (the registry owns it); this stores the shapes.
    """
    key = str(root or "").strip()
    if not _ROOT_RE.match(key):
        raise BindingError(f"bad session id: {root or '<empty>'}")
    topic = str(topic_id or "").strip()
    if not topic:
        raise BindingError("topic_id is required")
    _apply(
        [
            (
                (
                    "INSERT INTO bindings (lineage_root, topic_id, updated_at) VALUES (?, ?, ?)"
                    " ON CONFLICT(lineage_root) DO UPDATE SET topic_id = excluded.topic_id,"
                    " updated_at = excluded.updated_at"
                ),
                (key, topic, int(time.time() * 1000)),
            )
        ]
    )


def get_binding(root: str) -> str | None:
    """One root's topic, or ``None`` when it was never filed.

    A targeted read, so the bind guard can check a single root instead of loading the whole map.
    """
    rows = _read_all(
        "SELECT topic_id FROM bindings WHERE lineage_root = ?",
        (str(root or "").strip(),),
    )
    return str(rows[0][0]) if rows else None


def clear_binding(root: str) -> None:
    """Remove one binding; a no-op when it was never bound."""
    _apply(
        [("DELETE FROM bindings WHERE lineage_root = ?", (str(root or "").strip(),))]
    )


def mapping() -> dict[str, str]:
    """Every binding, root -> topic. One indexed table read; the listing resolves against it."""
    rows = _read_all("SELECT lineage_root, topic_id FROM bindings")
    return {str(root): str(topic) for root, topic in rows}


def prune_to(topics: Iterable[str]) -> int:
    """Drop bindings whose topic is not in the live set (a topic was deleted or renamed away). Returns the dropped count."""
    live = {str(topic) for topic in topics}
    dead = [root for root, topic in mapping().items() if topic not in live]
    if not dead:
        return 0
    _apply([("DELETE FROM bindings WHERE lineage_root = ?", (root,)) for root in dead])
    logger.info(
        "[topoi] pruned %d binding(s) to topics no longer in the registry", len(dead)
    )
    return len(dead)


def drop_roots(roots: Iterable[str]) -> int:
    """Drop bindings for sessions that no longer exist; returns the dropped count."""
    dead = [str(root) for root in roots if str(root)]
    if not dead:
        return 0
    _apply([("DELETE FROM bindings WHERE lineage_root = ?", (root,)) for root in dead])
    return len(dead)


def sweep_dead_roots(exists) -> int:
    """Drop every binding whose root ``exists(root)`` reports gone.

    The caller owns the session-store probe (the store never imports it); the sweep runs only on write paths and only once the index is past the threshold, so a hot listing never pays for it.
    """
    bindings = mapping()
    if len(bindings) < _SWEEP_THRESHOLD:
        return 0
    dead = [root for root in bindings if not exists(root)]
    dropped = drop_roots(dead)
    if dropped:
        logger.info(
            "[topoi] swept %d binding(s) to sessions no longer in the store", dropped
        )
    return dropped


def adopt_config_block(block: Any) -> int:
    """One-time migration: import a legacy config-level bindings block into the store.

    INSERT OR IGNORE, so whatever the store already holds wins; a config block can only be older. Returns the adopted count.
    """
    if not isinstance(block, Mapping):
        return 0
    statements: list[tuple[str, tuple]] = []
    now = int(time.time() * 1000)
    for root, topic in block.items():
        key = str(root or "").strip()
        value = str(topic or "").strip()
        if _ROOT_RE.match(key) and value:
            statements.append(
                (
                    (
                        "INSERT OR IGNORE INTO bindings (lineage_root, topic_id, updated_at)"
                        " VALUES (?, ?, ?)"
                    ),
                    (key, value, now),
                )
            )
    if not statements:
        return 0
    adopted = _apply(statements)
    if adopted:
        logger.info(
            "[topoi] adopted %d binding(s) from the legacy config block", adopted
        )
    return adopted
