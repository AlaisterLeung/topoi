"""Topoi backend routes, mounted under ``/api/plugins/topoi/``.

Serves the topic registry and topic-grouped session listings to the desktop half (and any client). The routes run inside the gateway / dashboard process, so they read the session store and the registry directly rather than proxying; only the backend ``plugin_api.py`` namespace is shared between the desktop and dashboard SDKs, and this is it.

Routes (CONTRACT.md section 3):

- ``GET /topics`` - the registry: entries, order, home. Bindings are server-side only and never shipped as a map.
- ``PUT /topics`` - store a client-sent registry; 422 with the refusal reason on a bad one.
- ``GET /threads`` - session rows resolved to topics (adapter-minted ``chat_id``, then the binding store, then a cron run's own job delivery lane), paged, newest first; only threads filed under a live topic are listed.
- ``POST /threads/bind`` - file one session under a topic; re-filing one that is already filed elsewhere needs ``move: true`` (the row menu's Move to topic), so a client-side misfire cannot relocate a thread (409 otherwise).
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


class BindConflict(Exception):
    """A bind that would re-topic an existing filing (409).

    Only an explicit ``move`` may relocate a thread, so a client-side misfire can never do it by accident.
    """


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


def _topic_id_of(
    row: dict[str, Any],
    binding_map: dict[str, str],
    cron_topics: dict[str, str],
) -> str | None:
    """The topic a session row belongs to.

    A ``source: topoi`` session carries its topic in ``chat_id`` (the adapter mints those for cron deliveries); every other session resolves through the binding map, keyed by lineage root. Listing rows are already projected to their live tip (``_lineage_root_id`` carries the durable id, same field the desktop's session-row slots hand out), so the root - not the row id - is the binding key.

    A ``source: cron`` row is a scheduled RUN (``cron_<job id>_<stamp>``): its topic lives on the job's delivery lane, never on the row, so it resolves through ``cron_topics``. A client-filed binding still wins for these rows, which is what makes Move to topic stick on a briefing. The order matters: chat_id (adapter-minted) > file (a human decision) > delivery lane (the job's own target).
    """
    source = str(row.get("source") or "")
    if source == "topoi":
        chat_id = str(row.get("chat_id") or "").strip()
        return chat_id if topic_store.is_topic_id(chat_id) else None
    root = str(row.get("_lineage_root_id") or row.get("id") or "")
    filed = binding_map.get(root)
    if filed:
        return filed
    if source == "cron":
        job_id = _cron_job_id(root, cron_topics)
        if job_id:
            return cron_topics[job_id]
    return None


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


# A cron run session is minted by the scheduler as `cron_<job id>_<stamp>`; the id
# prefix is the only link back to the job, and the job's delivery lane is the only
# record of where the run went.
_CRON_SESSION_PREFIX = "cron_"


def _deliver_text(value: Any) -> str:
    """One delivery-lane value as the core reads it: lists flatten to a comma string, empty means local."""
    if isinstance(value, (list, tuple)):
        return ",".join(str(part).strip() for part in value if str(part).strip())
    return str(value or "")


def _lane_topic(value: Any, home_topic: str) -> str | None:
    """The topoi topic one delivery-lane value addresses, or None when it has no topoi leg.

    Mirrors the core's grammar (``cron/scheduler_delivery.py::_resolve_delivery_targets``): comma-separated tokens, ``<platform>:<target>``. ``topoi:<topic>[:<thread>]`` names one (the thread suffix is the continuable-run key, not a topic); a bare ``topoi`` is the home topic, the same one the adapter's ``send()`` falls back to. The ``all`` routing token is deliberately not expanded: it means every platform with a home, so honouring it would file every broadcast job's runs under the home topic.
    """
    for token in _deliver_text(value).split(","):
        platform, _, target = token.strip().partition(":")
        if platform.strip().lower() != PLATFORM_NAME:
            continue
        named = target.strip()
        if not named:
            return home_topic or None
        topic = named.split(":")[0].strip()
        if topic_store.is_topic_id(topic):
            return topic
    return None


def _cron_delivery_topics(profile: str | None) -> dict[str, str]:
    """Job id -> the topic that job's runs are filed under.

    Read from the profile's cron job store on every listing (no cache): the job is the record, so a run always resolves against the job as it stands. A job that delivers nowhere topoi-shaped is absent, and so is a job whose delivery lane names no topic this registry knows - the caller's live-topic filter then drops those runs, exactly like any other unfiled session. ``failure_deliver`` is the fallback lane the core itself uses for a failed run's notice.

    An unreadable job store is a debug log and no filing: a listing must never fail because cron state is mid-repair.
    """
    try:
        from cron import jobs as cron_jobs

        if profile:
            # A dashboard process serves every profile; the store scope is an execution-context
            # override, so this cannot retarget a concurrent tick of another profile.
            from hermes_cli.web_server_cron import _cron_profile_home, _cron_store_scope

            _name, home = _cron_profile_home(profile)
            with _cron_store_scope(home):
                jobs = cron_jobs.load_jobs()
        else:
            jobs = cron_jobs.load_jobs()
    except Exception:  # a listing must never fail on cron state
        logger.debug("[topoi] cron job store unreadable; no run filing", exc_info=True)
        return {}
    home_topic = topic_store.home_id()
    topics: dict[str, str] = {}
    for job in jobs or []:
        if not isinstance(job, dict):
            continue
        job_id = str(job.get("id") or "").strip()
        if not job_id:
            continue
        topic = _lane_topic(job.get("deliver"), home_topic) or _lane_topic(
            job.get("failure_deliver"), home_topic
        )
        if topic:
            topics[job_id] = topic
    return topics


def _cron_job_id(session_id: str, cron_topics: dict[str, str]) -> str | None:
    """The job a ``cron_<job id>_<stamp>`` session belongs to, or None.

    Matched against the known job ids rather than parsed out of the id: the stamp's shape is the scheduler's business, and a prefix test against the ids that actually exist cannot drift from it. The trailing underscore keeps ``abc`` from matching ``abcdef``.
    """
    session = str(session_id or "")
    if not session.startswith(_CRON_SESSION_PREFIX):
        return None
    for job_id in cron_topics:
        if session.startswith(f"{_CRON_SESSION_PREFIX}{job_id}_"):
            return job_id
    return None


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


def _bind_core(
    db: Any, session_id: str, topic_id: str, move: bool = False
) -> dict[str, Any]:
    """File one session under a topic, synchronously.

    Everything the bind endpoint does lives here so a plain sync check can drive it: the required-field check, the lineage walk (a live id resolves to its root, so a mid-thread compression never orphans a binding), topic liveness against the registry, the re-file guard, the store write, and the dead-root sweep. The async handler is a thin wrapper that owns the request parsing and the db lifecycle and maps this function's errors to HTTP codes (``LookupError`` -> 404, ``ValueError`` -> 422, ``BindConflict`` -> 409).

    The check order is deliberate: a request that fails both checks is a 404, so a client can tell a deleted thread from a deleted topic.

    A bind may create a filing but never silently re-topic one: an existing binding under another topic is a ``BindConflict`` unless the caller passes ``move`` (the row menu's Move to topic). A thread's topic is fixed once it is filed (Boss's call), so a client-side misfire - a stale new-thread arm catching a chat that was already filed, including one whose session id rotated under compression - is refused instead of relocating the thread.
    """
    if not session_id:
        raise ValueError("session_id is required")
    root = _lineage_root(db, session_id)
    if root is None:
        raise LookupError(f"unknown session: {session_id}")
    # Liveness against the registry: a binding to a topic no client shows is worse than a refusal.
    if topic_id not in _live_topic_ids():
        raise ValueError(f"unknown topic: {topic_id}")
    filed = bindings.get_binding(root)
    if filed is not None and filed != topic_id and not move:
        raise BindConflict(f"already filed under {filed}: a move must say so")
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


# The row preview's own budget: enough for two lines on a phone row. The text is
# collapsed to one line, so a multi-line response can never blow the row up.
LATEST_MESSAGE_CHARS = 240


def _latest_message(db: Any, session_id: str) -> str:
    """The newest user or assistant text of one thread, shaped for a row preview.

    The store is asked which row is the newest of each role (``latest_message_row_id`` already skips the rows that carry no text) and that row is read back, one indexed lookup plus one row each: scanning a fixed tail of rows instead goes off the end of the transcript exactly while a thread is busy, because a running turn writes an empty assistant row plus a machine-payload tool row for every call it makes. Tool rows stay out of the preview, and the store's own ``preview`` column is the session's OPENING user prompt, which is what a title lookup wants but not what a row that tracks recent activity wants.
    """
    newest: tuple[int, str] | None = None
    for role in ("user", "assistant"):
        try:
            row_id = db.latest_message_row_id(session_id, role=role)
            if row_id is None:
                continue
            window = db.get_messages_around(session_id, int(row_id), window=0)["window"]
        except Exception:
            logger.debug(
                "[topoi] latest-message read failed for %s", session_id, exc_info=True
            )
            return ""
        if not window:
            continue
        text = " ".join(str(window[0].get("content") or "").split())
        if not text:
            continue
        if newest is None or int(row_id) > newest[0]:
            newest = (int(row_id), text)
    if newest is None:
        return ""
    text = newest[1]
    return (
        text[:LATEST_MESSAGE_CHARS] + "..."
        if len(text) > LATEST_MESSAGE_CHARS
        else text
    )


@router.get("/threads")
async def get_threads(
    topic: str | None = None,
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    profile: str | None = None,
) -> dict[str, Any]:
    """Session rows resolved to topics, newest activity first, and only those filed under a live topic.

    Each row: ``session_id`` (the live chain tip a client opens), ``lineage_root`` (the durable id bindings key on), ``topic_id`` (always a live registry entry, never null), plus title, ``latest_message`` (the newest user or assistant text, collapsed to one line and capped, read per listed row), and the activity fields. A session with no topic never appears, and neither does a thread whose topic is no longer a live entry (a deleted topic, including a ``source: topoi`` session whose delivery topic is gone): the filter runs before pagination, so ``total`` counts the listed set and ``offset`` walks it. Archived, hidden and machinery-source sessions are excluded, mirroring the dashboard's own listing. ``topic`` filters to one topic; pass no ``topic`` to list every topic's threads.

    Scheduled runs are listed here too: a ``source: cron`` row resolves to the topic its job delivers to (``_cron_delivery_topics``), so a briefing is one session shown under its topic and under the Cron platform listing, never a copy.
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
            # The delivery lanes are read only when the window carries a run: most listings
            # hold none, and a job-store read per refetch would be pure overhead.
            cron_topics = (
                _cron_delivery_topics(profile)
                if any(str(row.get("source") or "") == "cron" for row in rows)
                else {}
            )
            out = []
            for row in rows:
                # The listing projects a compression root onto its live tip and carries the
                # durable id in _lineage_root_id; a row with no rotation is its own root.
                root = str(row.get("_lineage_root_id") or row.get("id") or "")
                tip = str(row.get("id") or root)
                topic_id = _topic_id_of(row, binding_map, cron_topics)
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
                        "latest_message": _latest_message(db, tip),
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
    """File one session under a topic, or move one when the request says so.

    The session id is resolved to its lineage root first, so binding a live id survives compression. 404 when the session does not exist; 422 when the topic is not a live registry entry (a request failing both checks gets the 404); 409 when the thread is already filed under another topic and the body does not carry ``move: true``. The logic lives in ``_bind_core``; this wrapper owns the request parsing and the db lifecycle.
    """
    session_id = str((body or {}).get("session_id") or "").strip()
    topic_id = str((body or {}).get("topic_id") or "").strip()
    move = bool((body or {}).get("move"))
    db = _open_db(profile)
    try:
        return _bind_core(db, session_id, topic_id, move=move)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except BindConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
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
