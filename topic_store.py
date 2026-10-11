"""Topic registry store: the topics a client shows, persisted in ``config.yaml``.

The gateway owns the one copy of the registry (``platforms.topoi.topics``), so every client that connects sees the same topics, names, order and home, and an edit made on one client reaches the others over REST (``PUT /topics``) with a ``plugin.topoi.topics.changed`` event. The block is deliberately the only home for this state: topics are low-churn (a rename, an archive, a drag), and a config block survives both the gateway and the clients.

Session-to-topic bindings do NOT live here: they are high-churn and unbounded, so they live in the plugin-private store (``bindings.py``) and are resolved server-side by the REST layer. See CONTRACT.md section 3.

Shape (CONTRACT.md section 2)::

    platforms:
      topoi:
        topics:
          updated_at: 1791372109923
          home_id: t_system
          entries:
            - {id: t_general, name: General}
            - {id: t_work, name: Work, archived: true}

``updated_at`` is epoch milliseconds of the last stored write, nudged to stay strictly increasing if the clock stalls or steps back; ``home_id`` is the home topic the app highlights, and moving it also rewrites the framework's ``home_channel`` so the delivery home a cron job targets never drifts from the home the app shows.

The pre-rename spellings (``items`` / ``revision``) are retired: only ``entries`` / ``updated_at`` are read. A state still carrying the old names is ignored (and logged once), never half-read.

Deleted topics are NOT tracked: only an empty topic can be deleted, so a tombstone list would only guard an id reuse that cannot resurrect anything, and the next registry write drops any leftover ``deleted`` key from the block on its own.

"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)

PLATFORM_NAME = "topoi"
DEFAULT_HOME_ID = "t_system"
DEFAULT_HOME_NAME = "System"

# CONTRACT.md section 2: an id outside this shape never becomes a topic, whatever wrote it.
_TOPIC_RE = re.compile(r"^t_[a-z0-9_]+$")
# The registry is a registry, not a data channel: a client cannot fill config.yaml.
MAX_ENTRIES = 500
MAX_NAME_CHARS = 120

# The retired pre-rename spellings; seeing them means an un-migrated block or a stale client, which is worth one log line rather than a silent empty registry.
_RETIRED_KEYS = ("items", "revision")
_warned_retired_keys = False


class TopicError(ValueError):
    """A client-sent registry that cannot be stored, carrying the reason to send back."""


def default_state() -> dict[str, Any]:
    """The registry of a gateway that has never stored one: just the home topic."""
    return {
        "updated_at": 0,
        "home_id": DEFAULT_HOME_ID,
        "entries": [{"id": DEFAULT_HOME_ID, "name": DEFAULT_HOME_NAME}],
    }


def is_topic_id(raw: Any) -> bool:
    """True for a string in the topic id shape, whatever wrote it."""
    return bool(_valid_id(raw))


def _valid_id(raw: Any) -> str:
    topic_id = str(raw or "").strip()
    return topic_id if _TOPIC_RE.match(topic_id) else ""


def _clean_name(raw: Any, fallback: str) -> str:
    name = " ".join(str(raw or "").split())
    return name[:MAX_NAME_CHARS] if name else fallback


def _stamp(raw: Any) -> int:
    """Epoch milliseconds for a write, at least one past the stored stamp: a stalled or backwards clock must never make a newer registry look older."""
    previous = 0
    if isinstance(raw, Mapping):
        stored = raw.get("updated_at")
        if isinstance(stored, int) and not isinstance(stored, bool) and stored > 0:
            previous = stored
    return max(int(time.time() * 1000), previous + 1)


def _warn_retired_keys(block: Mapping[str, Any]) -> None:
    """Say once that a state still uses the retired names, so an un-migrated block never reads as an empty registry without a reason in the log."""
    global _warned_retired_keys
    if (
        _warned_retired_keys
        or "entries" in block
        or not any(k in block for k in _RETIRED_KEYS)
    ):
        return
    _warned_retired_keys = True
    logger.warning(
        "[topoi] topic registry uses the retired %s keys; only %s are read now, so this state is ignored",
        " / ".join(_RETIRED_KEYS),
        "entries / updated_at",
    )


def _section(config: Any) -> Mapping[str, Any]:
    """The ``platforms.topoi`` mapping of a loaded config; empty when it is missing or malformed."""
    platforms = config.get("platforms") if isinstance(config, Mapping) else None
    section = platforms.get(PLATFORM_NAME) if isinstance(platforms, Mapping) else None
    return section if isinstance(section, Mapping) else {}


def normalize_state(raw: Any) -> dict[str, Any]:
    """Coerce a stored or client-sent registry into the stored shape: invalid members are dropped, not trusted."""
    block = raw if isinstance(raw, Mapping) else {}
    _warn_retired_keys(block)
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in block.get("entries") or []:
        if not isinstance(entry, Mapping):
            continue
        topic_id = _valid_id(entry.get("id"))
        if not topic_id or topic_id in seen:
            continue
        seen.add(topic_id)
        item: dict[str, Any] = {
            "id": topic_id,
            "name": _clean_name(entry.get("name"), topic_id),
        }
        if entry.get("archived") is True:
            item["archived"] = True
        entries.append(item)
        if len(entries) >= MAX_ENTRIES:
            break
    stamp = block.get("updated_at")
    return {
        "updated_at": stamp
        if isinstance(stamp, int) and not isinstance(stamp, bool) and stamp >= 0
        else 0,
        "home_id": _valid_id(block.get("home_id")) or DEFAULT_HOME_ID,
        "entries": entries,
    }


def validate_state(raw: Any) -> dict[str, Any]:
    """The registry a client asked to store, or a ``TopicError`` saying what is wrong with it.

    Structural problems are refused loudly: a client that sends a bad id or repeats one has a bug worth seeing. A blank or over-long name is cleaned instead (the name is display text, not a key). A ``deleted`` list is ignored rather than refused, so a client still carrying the retired tombstone tracking keeps working; the next stored write drops the key either way.
    """
    if not isinstance(raw, Mapping):
        raise TopicError("topics.set requires a state object")
    raw_entries = raw.get("entries")
    if not isinstance(raw_entries, list):
        raise TopicError("state.entries must be a list")
    if len(raw_entries) > MAX_ENTRIES:
        raise TopicError(f"state.entries holds more than {MAX_ENTRIES} topics")
    ids: set[str] = set()
    for index, entry in enumerate(raw_entries):
        if not isinstance(entry, Mapping):
            raise TopicError(f"state.entries[{index}] must be an object")
        topic_id = str(entry.get("id") or "").strip()
        if not _TOPIC_RE.match(topic_id):
            raise TopicError(
                f"state.entries[{index}].id violates the topic id shape: {topic_id or '<empty>'}"
            )
        if topic_id in ids:
            raise TopicError(f"state.entries repeats the topic id {topic_id}")
        ids.add(topic_id)
    home_id = str(raw.get("home_id") or "").strip()
    if not _TOPIC_RE.match(home_id):
        raise TopicError(
            f"state.home_id violates the topic id shape: {home_id or '<empty>'}"
        )
    return normalize_state(raw)


def load_state() -> dict[str, Any]:
    """The stored registry, or the default one when nothing is stored yet.

    Reads through the core's config cache, so an operator edit to the block is picked up without a restart. With no block stored, the home topic is the gateway's configured one, which keeps the app's home and the delivery home on the same value from the first connect.
    """
    try:
        from hermes_cli.config import load_config_readonly

        section = _section(load_config_readonly())
    except (
        Exception
    ):  # a config read failure must not take the REST surface down with it
        logger.debug("[topoi] topic store read failed", exc_info=True)
        return default_state()
    block = section.get("topics")
    home, name = _configured_home(section)
    if not isinstance(block, Mapping):
        # No stored registry yet: seed the home topic the gateway is configured with, so the app's home and the delivery home start on one value.
        return {
            "updated_at": 0,
            "home_id": home,
            "entries": [{"id": home, "name": name}],
        }
    state = normalize_state(block)
    if not _valid_id(block.get("home_id")):
        # A registry with no usable home behaves like one that never named a home: the gateway's own wins.
        state["home_id"] = home
    return state


def legacy_bindings() -> Mapping[str, Any]:
    """A pre-store ``bindings`` block still sitting in the config, for one-time adoption into the plugin store; empty when there is none.

    The key is never read as registry state, and any registry write replaces the whole block, so the key disappears on the next write whether or not anyone adopts it.
    """
    try:
        from hermes_cli.config import load_config_readonly

        block = _section(load_config_readonly()).get("topics")
    except Exception:  # an unreadable config must not fail the adoption attempt
        logger.debug("[topoi] topic store read failed", exc_info=True)
        return {}
    if not isinstance(block, Mapping):
        return {}
    raw = block.get("bindings")
    return raw if isinstance(raw, Mapping) else {}


def _configured_home(section: Mapping[str, Any]) -> tuple[str, str]:
    """The gateway's own home topic and its label: the framework's ``home_channel`` projection.

    The projection is the only configured-home key now (the retired ``home_topic`` / env pair
    is gone), so an unset registry seeds from it and the app's home and the delivery home
    agree from the first read.
    """
    channel = _home_channel(section)
    home = _valid_id(channel.get("chat_id")) or DEFAULT_HOME_ID
    name = _clean_name(
        channel.get("name"),
        DEFAULT_HOME_NAME if home == DEFAULT_HOME_ID else home,
    )
    return home, name


def home_id() -> str:
    """The stored home topic id, or "" while no registry is stored (the caller keeps its own config/env home)."""
    try:
        from hermes_cli.config import load_config_readonly

        block = _section(load_config_readonly()).get("topics")
    except Exception:  # an unreadable config must not silently move deliveries
        logger.debug("[topoi] topic store read failed", exc_info=True)
        return ""
    if not isinstance(block, Mapping):
        return ""
    return _valid_id(block.get("home_id"))


def _home_channel(section: Mapping[str, Any]) -> Mapping[str, Any]:
    channel = section.get("home_channel")
    return channel if isinstance(channel, Mapping) else {}


def home_label(state: Mapping[str, Any], fallback: str = "") -> str:
    """The label a live registry's home should carry.

    The same one-slot rule ``_mirror_home`` applies when it writes: the registry entry's own
    name, else *fallback* (the name the last stored write kept), else the id. Exposed so a
    live read and a stored write can never disagree about the label.
    """
    return _clean_name_for(state, str(state.get("home_id") or ""), fallback)


def repair_home_projection() -> bool:
    """Rewrite ``home_channel`` from the stored registry when the projection is missing or stale.

    The projection is the only thing the framework's readers resolve through, so a
    hand-deleted or never-written block silently breaks ``deliver=topoi``: the platform still
    looks connected (the registry alone satisfies ``is_connected``) and nothing raises. A
    registry write normally rewrites it, which covers every app-driven move; this covers the
    gap where none has happened since - a fresh config, or an operator edit that dropped the
    key. Called at adapter connect, so a gateway boot repairs what a delivery would otherwise
    silently lose. Returns True when it wrote; a healthy config costs one cached read and no
    write.
    """
    home = home_id()
    if not home:
        return False
    from hermes_cli.config import _CONFIG_LOCK, load_config, save_config

    with _CONFIG_LOCK:
        config = load_config()
        platforms = config.get("platforms")
        section = platforms.get(PLATFORM_NAME) if isinstance(platforms, dict) else None
        if not isinstance(section, dict):
            return False
        channel = _home_channel(section)
        state = normalize_state(section.get("topics") or {})
        name = home_label(state, str(channel.get("name") or ""))
        if (
            _valid_id(channel.get("chat_id")) == home
            and str(channel.get("name") or "") == name
        ):
            return False
        section["home_channel"] = {
            "platform": PLATFORM_NAME,
            "chat_id": home,
            "name": name,
        }
        save_config(config)
    logger.info("[topoi] repaired home_channel projection -> %s (%s)", home, name)
    return True


def _clean_name_for(state: Mapping[str, Any], home: str, previous_name: str) -> str:
    for entry in state.get("entries") or []:
        if entry.get("id") == home:
            return str(entry.get("name") or "").strip() or home
    return previous_name.strip() or home


def _mirror_home(
    section: dict[str, Any], state: Mapping[str, Any], previous_home: str
) -> None:
    """Keep the delivery home in step with the registry.

    ``home_channel`` is the framework's typed projection of the registry's ``home_id``; two
    readers exist (cron, framework notices) and neither raises when they drift, so the registry
    writes the projection rather than leaving the delivery home to disagree with the home the
    app shows. The label has ONE slot: the registry entry for the home id, else the existing
    ``home_channel.name``, else the id.
    """
    home = str(state["home_id"])
    channel = _home_channel(section)
    previous_name = str(channel.get("name") or "")
    name = _clean_name_for(state, home, previous_name)
    if home == previous_home and name == previous_name:
        return
    merged = dict(channel)
    merged.update({"platform": PLATFORM_NAME, "chat_id": home, "name": name})
    section["home_channel"] = merged
    logger.info(
        "[topoi] home topic moved %s -> %s (config.yaml)",
        previous_home or "<unset>",
        home,
    )


def write_state(raw: Any) -> dict[str, Any]:
    """Store a client-sent registry and return what was stored, stamped with this write's ``updated_at``.

    Read-modify-write under the core's config lock, so two clients (or a client and the dashboard) cannot interleave and lose one another's edit. Last writer wins: the state is replaced whole, which is what the stamp lets a client order.
    """
    state = validate_state(raw)
    from hermes_cli.config import _CONFIG_LOCK, load_config, save_config

    with _CONFIG_LOCK:
        config = load_config()
        platforms = config.get("platforms")
        if not isinstance(platforms, dict):
            platforms = {}
            config["platforms"] = platforms
        section = platforms.get(PLATFORM_NAME)
        if not isinstance(section, dict):
            section = {}
            platforms[PLATFORM_NAME] = section
        stored = section.get("topics")
        previous_home = (
            _valid_id(stored.get("home_id")) if isinstance(stored, Mapping) else ""
        ) or _valid_id(_home_channel(section).get("chat_id"))
        state["updated_at"] = _stamp(stored)
        section["topics"] = state
        _mirror_home(section, state, previous_home)
        save_config(config)
    return state
