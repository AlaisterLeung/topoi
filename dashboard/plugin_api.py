"""Topoi backend routes, mounted under ``/api/plugins/topoi/``.

Serves the topic registry and topic-grouped session listings to the desktop half (and any client). The routes run inside the gateway / dashboard process, so they read the session store and the registry directly rather than proxying; only the backend ``plugin_api.py`` namespace is shared between the desktop and dashboard SDKs, and this is it.

Routes (CONTRACT.md section 3):

- ``GET /topics`` - the registry: entries, order, home. Bindings are server-side only and never shipped as a map.
- ``PUT /topics`` - store a client-sent registry; 422 with the refusal reason on a bad one.
- ``GET /threads`` - session rows resolved to topics, paged, newest first; only threads filed under a live topic are listed.
- ``POST /threads/bind`` - file one session under a topic, or move one that is already filed (the desktop half's thread-creation flow and the row menu's Move to topic).
- ``DELETE /threads/{session_id}`` - delete one thread, delegating to the core's own session delete.

Every registry write broadcasts ``plugin.topoi.topics.changed`` (which reaches desktop windows only when this code runs in the ``hermes serve`` backend process; from the messaging gateway it is a logged no-op). The thread list needs no plugin-side push: the desktop half refetches on the gateway's own ``sessions.changed`` event. Bindings need no broadcast at all: resolution happens server-side on every ``GET /threads``, so a binding is visible to every client the moment it lands.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()

PLATFORM_NAME = "topoi"
_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_LIMIT = 200
_MAX_LIMIT = 500
# The sources the dashboard itself hides from human listings (kanban board and tool runs); the topic list mirrors that so a topic tree never shows machinery sessions.
_HIDDEN_SOURCES = ("kanban", "tool")


def _load_sibling(name: str):
    """The plugin-root module ``name`` (``topic_store`` or ``bindings``).

    The dashboard mounts this file BY PATH (module name ``hermes_dashboard_plugin_topoi``), not as a package module, so a relative import does not resolve here. The gateway loader's package instance is reused when this process already imported it; otherwise the sibling is loaded by path under a stable name. Both are safe to mix: every module is stateless per call (config reads, SQLite opens), so two instances cannot drift.
    """
    try:
        return importlib.import_module(f"hermes_plugins.topoi.{name}")
    except ImportError:
        pass
    module_name = f"hermes_topoi_plugin_{name}"
    module = sys.modules.get(module_name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(
        module_name, _PLUGIN_ROOT / f"{name}.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"[topoi] cannot load {name} from the plugin root")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


topic_store = _load_sibling("topic_store")
bindings = _load_sibling("bindings")


def _topic_id_of(row: dict[str, Any], binding_map: dict[str, str]) -> str | None:
    """The topic a session row belongs to.

    A ``source: topoi`` session carries its topic in ``chat_id`` (the adapter mints those for cron deliveries); every other session resolves through the binding map, keyed by lineage root. Listing rows are already projected to their live tip (``_lineage_root_id`` carries the durable id, same field the desktop's session-row slots hand out), so the root - not the row id - is the binding key.
    """
    if str(row.get("source") or "") == "topoi":
        chat_id = str(row.get("chat_id") or "").strip()
        return chat_id if topic_store.is_topic_id(chat_id) else None
    return binding_map.get(str(row.get("_lineage_root_id") or row.get("id") or ""))


def _is_compression_edge(child: dict[str, Any], parent: dict[str, Any]) -> bool:
    """The same edge test the dashboard's search router walks: a parent ended by compression, before the child started. Branch and reset children are their own conversations and must not be walked into the parent's binding."""
    parent_ended_at = parent.get("ended_at")
    started_at = child.get("started_at")
    return (
        parent.get("end_reason") == "compression"
        and parent_ended_at is not None
        and started_at is not None
        and started_at >= parent_ended_at
    )


def _lineage_root(db: Any, session_id: str) -> str | None:
    """The compression lineage root of a session id, or None when no such session exists.

    Bindings key on the root, so a mid-thread compression (which rotates the live id) never orphans one. Mirrors the dashboard search router's walk, including the cycle guard.
    """
    current = str(session_id or "").strip()
    if not current or not db.get_session(current):
        return None
    chain: list[str] = []
    while current and current not in chain:
        chain.append(current)
        row = db.get_session(current) or {}
        parent = str(row.get("parent_session_id") or "").strip()
        if not parent:
            return current
        parent_row = db.get_session(parent)
        if not parent_row or not _is_compression_edge(row, parent_row):
            return current
        current = parent
    return current


def _open_db(profile: str | None):
    """The profile's session store, read-only. None = this process's own store, which for the desktop-spawned backend is the connected profile's."""
    from hermes_cli.web_server_sessions import _open_session_db_for_profile

    return _open_session_db_for_profile(profile or None, read_only=True)


def _broadcast(payload: dict[str, Any] | None = None) -> None:
    """Announce a registry change to connected desktop windows; a no-op outside the serve backend."""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event("topoi", "topics.changed", payload or {})
    except Exception:  # a broadcast failure must never fail the write that triggered it
        logger.debug("[topoi] topics.changed broadcast failed", exc_info=True)


def _session_exists(db: Any):
    """A root-liveness probe for the binding sweep: the session store says whether a root still exists."""
    return lambda root: db.get_session(root) is not None


def _live_topic_ids() -> set[str]:
    """The registry's live entry ids. A binding to a topic no client shows is worse than a refusal, so the write path checks liveness here."""
    return {
        str(entry.get("id")) for entry in topic_store.load_state().get("entries") or []
    }


def _prune_after_registry_write(state: dict[str, Any]) -> int:
    """A topic that disappeared takes its bindings with it: the store prunes against the live entries the registry write just stored."""
    return bindings.prune_to(
        str(entry.get("id")) for entry in state.get("entries") or []
    )


def _live_adapter():
    """This process's connected topoi adapter, or None.

    The REST surface runs in whichever process serves it (the serve backend, the dashboard, or
    the gateway), and only a process holding a live adapter can move the framework's
    process-local home views. ``gateway.run._gateway_runner_ref`` is the core's weak ref to the
    active runner, so the gateway process resolves its live adapter here; a ``serve`` backend
    that only fronted the routes has no runner, and there the env-leg write below is still
    correct (a fresh config load re-seeds from the env), so the adapter leg is simply skipped.
    """
    try:
        from gateway.run import _gateway_runner_ref

        runner = _gateway_runner_ref()
    except Exception:  # noqa: BLE001 - a missing runner accessor is a no-op here, not an error
        return None
    if runner is None:
        return None
    adapters = getattr(runner, "adapters", None)
    if not isinstance(adapters, dict):
        return None
    adapter = adapters.get(PLATFORM_NAME)
    return adapter if hasattr(adapter, "sync_live_home") else None


def _sync_live_home() -> None:
    """Move this process's framework-visible home to the registry's, best-effort.

    The registry write already moved the durable keys (``topics.home_id``, ``home_channel``),
    which is what a fresh process or a fresh ``load_gateway_config()`` reads. This closes the
    in-process gap: notices and the system prompt's delivery list read the runner's startup
    ``PlatformConfig`` snapshot, which never reloads mid-process, so without this a moved home
    reaches those readers only after a restart. Cron needs no help here: it resolves through a
    fresh config load each delivery. A failure must never fail the write that triggered it.
    """
    try:
        adapter = _live_adapter()
        if adapter is not None:
            adapter.sync_live_home()
    except Exception:  # a home-view sync must never fail the write that triggered it
        logger.debug("[topoi] live home sync failed", exc_info=True)


def _bind_core(db: Any, session_id: str, topic_id: str) -> dict[str, Any]:
    """File one session under a topic, synchronously.

    Everything the bind endpoint does lives here so a plain sync check can drive it: the required-field check, the lineage walk (a live id resolves to its root, so a mid-thread compression never orphans a binding), topic liveness against the registry, the store write, and the dead-root sweep. The async handler is a thin wrapper that owns the request parsing and the db lifecycle and maps this function's errors to HTTP codes (``LookupError`` -> 404, ``ValueError`` -> 422).

    The check order is deliberate: a request that fails both checks is a 404, so a client can tell a deleted thread from a deleted topic.
    """
    if not session_id:
        raise ValueError("session_id is required")
    root = _lineage_root(db, session_id)
    if root is None:
        raise LookupError(f"unknown session: {session_id}")
    # Liveness against the registry: a binding to a topic no client shows is worse than a refusal.
    if topic_id not in _live_topic_ids():
        raise ValueError(f"unknown topic: {topic_id}")
    # The root came from a real session and the topic from the registry, so the store write cannot shape-fail; a BindingError (a ValueError) would still map to 422.
    bindings.set_binding(root, topic_id)
    bindings.sweep_dead_roots(_session_exists(db))
    return {"session_id": session_id, "lineage_root": root, "topic_id": topic_id}


@router.get("/topics")
async def get_topics() -> dict[str, Any]:
    """The registry: ``entries`` (ordered) and ``home_id``. Bindings are server-side only: a thread's topic is resolved in ``GET /threads``, never shipped as a map."""
    legacy = topic_store.legacy_bindings()
    if legacy:
        # One-time migration of a pre-store config-level bindings block; the next registry write replaces the whole block either way.
        bindings.adopt_config_block(legacy)
    return topic_store.load_state()


@router.put("/topics")
async def put_topics(body: dict[str, Any]) -> dict[str, Any]:
    """Store a client-sent registry (whole-state, last writer wins) and return what was stored, stamped. 422 carries the refusal reason; a refused write leaves the stored block untouched."""
    try:
        state = topic_store.write_state(body)
    except topic_store.TopicError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    _prune_after_registry_write(state)
    _sync_live_home()
    _broadcast({"updated_at": state["updated_at"]})
    return state


@router.get("/threads")
async def get_threads(
    topic: str | None = None,
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    profile: str | None = None,
) -> dict[str, Any]:
    """Session rows resolved to topics, newest activity first, and only those filed under a live topic.

    Each row: ``session_id`` (the live chain tip a client opens), ``lineage_root`` (the durable id bindings key on), ``topic_id`` (always a live registry entry, never null), plus title and activity fields. A session with no topic never appears, and neither does a thread whose topic is no longer a live entry (a deleted topic, including a ``source: topoi`` session whose delivery topic is gone): the filter runs before pagination, so ``total`` counts the listed set and ``offset`` walks it. Archived, hidden and machinery-source sessions are excluded, mirroring the dashboard's own listing. ``topic`` filters to one topic; pass no ``topic`` to list every topic's threads.
    """
    scope = {
        "exclude_sources": list(_HIDDEN_SOURCES),
        "min_message_count": 0,
        "include_archived": False,
        "archived_only": False,
    }
    db = _open_db(profile)
    try:
        live = _live_topic_ids()
        binding_map = bindings.mapping()

        def resolve_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            out = []
            for row in rows:
                # The listing projects a compression root onto its live tip and carries the
                # durable id in _lineage_root_id; a row with no rotation is its own root.
                root = str(row.get("_lineage_root_id") or row.get("id") or "")
                tip = str(row.get("id") or root)
                topic_id = _topic_id_of(row, binding_map)
                # A thread outside every live topic is nobody's listing: untagged rows
                # and rows under a deleted topic both drop here, before pagination.
                if topic_id not in live:
                    continue
                if topic is not None and topic_id != topic:
                    continue
                out.append(
                    {
                        "session_id": tip,
                        "lineage_root": root,
                        "topic_id": topic_id,
                        "title": row.get("title"),
                        "started_at": row.get("started_at"),
                        "last_active": row.get("last_active"),
                        "message_count": row.get("message_count"),
                        "source": str(row.get("source") or "cli"),
                    }
                )
            return out

        # One pass over the whole listing (its size is the store's session count, which
        # is the same scan the topic-filtered query always did): paginating the raw
        # listing first would drop matches past the first page and misreport the total.
        scan = max(db.session_count(exclude_children=True, **scope), 1)
        rows = db.list_sessions_rich(
            limit=scan,
            offset=0,
            order_by_last_active=True,
            compact_rows=True,
            include_pinned=True,
            **scope,
        )
        matched = resolve_rows(rows)
        total = len(matched)
        threads = matched[offset : offset + limit]
    finally:
        db.close()
    return {"threads": threads, "total": total, "limit": limit, "offset": offset}


@router.post("/threads/bind")
async def bind_thread(
    body: dict[str, Any], profile: str | None = None
) -> dict[str, Any]:
    """File one session under a topic.

    The session id is resolved to its lineage root first, so binding a live id survives compression. 404 when the session does not exist; 422 when the topic is not a live registry entry (a request failing both checks gets the 404). The logic lives in ``_bind_core``; this wrapper owns the request parsing and the db lifecycle.
    """
    session_id = str((body or {}).get("session_id") or "").strip()
    topic_id = str((body or {}).get("topic_id") or "").strip()
    db = _open_db(profile)
    try:
        return _bind_core(db, session_id, topic_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        db.close()


@router.delete("/threads/{session_id}")
async def delete_thread(session_id: str, profile: str | None = None) -> dict[str, Any]:
    """Delete one thread and drop its binding.

    The row, its compression chain and its on-disk transcripts go through the core's own session delete - the same handler the desktop's own delete rides, so behavior cannot drift: an already-absent session is a no-op success, a session under an active turn is a 409. The binding is resolved from the lineage root while the row still exists and dropped after the delete, so a deleted thread never leaves a binding behind.
    """
    from hermes_cli.web_routers.sessions import delete_session_endpoint

    db = _open_db(profile)
    try:
        root = _lineage_root(db, session_id)
    finally:
        db.close()
    result = await delete_session_endpoint(session_id, profile)
    if root is not None:
        bindings.drop_roots([root])
    return result
