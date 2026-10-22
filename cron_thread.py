"""Cron threads: the pairing between a scheduled run and the thread session it seeded.

The core mints a thread id at delivery time and seeds a ``source: topoi`` session for it, but neither row names the other: the seeded session carries no job id and the run session carries no thread id. This store is that pairing, one row per confirmed delivery that carried both. It answers exactly three questions: is this thread a cron result or an app-minted chat, which job seeded it (so the row can be titled and the run withheld behind it), and can a reply land in it.

No stamp and no message id: a seed's own session row carries ``started_at``, which is what the run's window match reads, and nothing consumes a delivery message id.

Same shape as the binding store: high-churn, plugin-private, SQLite under ``<hermes home>/plugin-data/topoi``, per-operation connections, WAL and a busy timeout because the gateway process writes it while whichever process serves the REST surface reads it.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from contextlib import closing
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_NAME = "cron_thread.db"

# A run session's id: ``cron_<job id>_<YYYYmmdd_HHMMSS>`` (cron/scheduler.py::run_job).
_RUN_RE = re.compile(r"^cron_(?P<job>.+)_\d{8}_\d{6}$")

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS deliveries ("
    " thread_id TEXT PRIMARY KEY,"
    " topic_id TEXT NOT NULL,"
    " job_id TEXT NOT NULL)"
)


class DeliveryError(ValueError):
    """A delivery row that cannot be stored, carrying the reason."""


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
    conn.execute(_SCHEMA)
    conn.execute("CREATE INDEX IF NOT EXISTS deliveries_by_job ON deliveries (job_id)")
    return conn


def _write(sql: str, params: tuple = ()) -> int:
    """Run one write in its own short transaction and return the row-change count."""
    with closing(_connect()) as conn, conn:
        before = conn.total_changes
        conn.execute(sql, params)
        return conn.total_changes - before


def _read(sql: str, params: tuple = ()) -> list[tuple]:
    with closing(_connect()) as conn:
        return conn.execute(sql, params).fetchall()


def run_job_id(session_id: str) -> str | None:
    """The job id a run session id names, or None when the row is not a run."""
    match = _RUN_RE.match(str(session_id or "").strip())
    return match.group("job") if match else None


def record_delivery(*, topic_id: str, thread_id: str, job_id: str) -> None:
    """Store one delivered run thread, replacing any earlier row for that thread id.

    Shapes only: whether a delivery deserved a thread is the core's decision, and whether its seed actually landed is the listing's second proof, not this store's.
    """
    topic = str(topic_id or "").strip()
    thread = str(thread_id or "").strip()
    job = str(job_id or "").strip()
    if not topic or not thread or not job:
        raise DeliveryError("topic_id, thread_id and job_id are required")
    _write(
        "INSERT INTO deliveries (thread_id, topic_id, job_id) VALUES (?, ?, ?)"
        " ON CONFLICT(thread_id) DO UPDATE SET topic_id = excluded.topic_id,"
        " job_id = excluded.job_id",
        (thread, topic, job),
    )


def jobs_by_thread() -> dict[str, str]:
    """Every delivered thread's job id, thread -> job, from one table read."""
    return {
        str(thread): str(job)
        for thread, job in _read("SELECT thread_id, job_id FROM deliveries")
    }
