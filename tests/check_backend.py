"""Backend route check for the topoi REST surface (real router handlers, real store, throwaway HERMES_HOME).

Drives the read paths of ``dashboard/plugin_api.py`` directly (the handlers are plain async functions; the ``include_router`` mount itself is core's) against a seeded state.db: the registry read, the live-topic-only listing with its compression-tip projection, topic resolution from ``chat_id`` and through the binding store, the lineage walk the bind handler resolves roots with, and the delete route (row gone, binding dropped). The store logic (set / clear / prune / sweep / adopt) is covered by check_bindings.py, the registry write and its refusals by check_topic_store.py, and the registry-write-prunes-store composition plus the bind core by check_bindings.py's integration section. Run:

    ~/.hermes/hermes-agent/venv/bin/python tests/check_backend.py

"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import pathlib
import sys
import tempfile
import types

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    suffix = f" - {detail}" if detail and not ok else ""
    print(f"{'ok  ' if ok else 'FAIL'} {name}{suffix}")
    if not ok:
        failures.append(name)


def fake_request(subject: str = "topoi-check"):
    """A minimal stand-in for the dashboard Request the plugin handlers forward to core.

    Core's session endpoints read the mutation principal off ``request.state`` and the app-level
    authority off ``request.app.state``; with a native principal present the credential branch is
    never reached, so no headers or cookies are needed.
    """
    state = types.SimpleNamespace(
        native_http_principal={"subject": subject}, session=None
    )
    app_state = types.SimpleNamespace(
        auth_required=False, session_authority=None, gateway_runner=None
    )
    return types.SimpleNamespace(
        state=state, app=types.SimpleNamespace(state=app_state)
    )


def _delete_is_fenced() -> bool:
    """True when the installed core's session delete carries the mutation fence."""
    from inspect import signature

    from hermes_cli.web_routers.sessions import delete_session_endpoint

    return "expected_revision" in signature(delete_session_endpoint).parameters


def load_plugin_api(pkg_name: str):
    """Import ``dashboard.plugin_api`` under the loader's package name.

    The real web server mounts the file BY PATH (module name ``hermes_dashboard_plugin_topoi``); importing it as a package child here exercises the same module - including its ``topic_store`` path-load fallback, which fires whenever the gateway's package instance is not already in ``sys.modules``.
    """
    if pkg_name not in sys.modules:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]
        sys.modules[pkg_name] = pkg
    sys.path.insert(0, str(ROOT))
    return importlib.import_module(f"{pkg_name}.dashboard.plugin_api")


SEED_CONFIG = {
    "platforms": {
        "topoi": {
            "enabled": True,
            "home_topic": "t_test",
            "topics": {
                "updated_at": 1,
                "home_id": "t_test",
                "entries": [
                    {"id": "t_test", "name": "Test"},
                    {"id": "t_news", "name": "News"},
                    {"id": "t_empty", "name": "Empty"},
                ],
            },
        }
    },
    "plugins": {"enabled": ["topoi"]},
}


def main() -> int:
    tree = os.environ.get(
        "HERMES_AGENT_TREE", str(pathlib.Path.home() / ".hermes" / "hermes-agent")
    )
    if not pathlib.Path(tree, "gateway").is_dir():
        print(
            f"skip backend checks - agent tree not found at {tree} (set HERMES_AGENT_TREE)"
        )
        return 0
    sys.path.insert(0, tree)
    home = pathlib.Path(tempfile.mkdtemp(prefix="topoi-backend-"))
    os.environ["HERMES_HOME"] = str(home)
    (home / "config.yaml").write_text(
        yaml.safe_dump(SEED_CONFIG, sort_keys=False), encoding="utf-8"
    )

    # The package-import harness (the real web server mounts the file by path, which needs no
    # separate test: the module's topic_store path-load fallback fires either way here).
    api = load_plugin_api("topoi_backend_checked")

    from hermes_state import SessionDB

    db = SessionDB()
    try:
        # A session the adapter itself mints (a seeded cron run): source=topoi, topic in chat_id.
        db.create_session(
            "sess_cron", "topoi", chat_id="t_news", thread_id="th_1700000000_abc123"
        )
        # A delivery whose topic is gone: source=topoi with a chat_id no live entry names.
        db.create_session("sess_gone", "topoi", chat_id="t_deleted")
        # A session nothing filed: no chat_id topic, no binding.
        db.create_session("sess_loose", "local", chat_id="")
        # A compression chain: the parent ends FIRST (the edge test requires
        # child.started_at >= parent.ended_at), the listing surfaces the ROOT, opened
        # at the TIP. Bound below, so the chain is a listed thread.
        db.create_session("sess_plain", "local", chat_id="")
        db.end_session("sess_plain", "compression")
        db.create_session(
            "sess_plain_tip", "local", chat_id="", parent_session_id="sess_plain"
        )
    finally:
        db.close()

    topics = asyncio.run(api.get_topics())
    check(
        "GET /topics serves the registry",
        topics.get("home_id") == "t_test"
        and [e["id"] for e in topics["entries"]] == ["t_test", "t_news", "t_empty"]
        and "bindings" not in topics
        and "deleted" not in topics,
        topics,
    )

    # The listing carries only threads filed under a live topic: the bound
    # compression chain (filed through the bind endpoint the desktop's New thread
    # flow rides) and the adapter-minted cron session.
    asyncio.run(api.bind_thread({"session_id": "sess_plain", "topic_id": "t_test"}))
    threads = asyncio.run(api.get_threads(None, 200, 0, None))
    check(
        "GET /threads lists only threads filed under a live topic",
        threads["total"] == 2 and len(threads["threads"]) == 2,
        threads,
    )
    by_root = {t["lineage_root"]: t for t in threads["threads"]}
    check(
        "an untagged session is not listed",
        "sess_loose" not in by_root,
        threads["threads"],
    )
    check(
        "a delivery whose topic is no longer live is not listed",
        "sess_gone" not in by_root,
        threads["threads"],
    )
    check(
        "the listing excludes the compression continuation and shows the root at its tip",
        "sess_plain_tip" not in by_root
        and by_root["sess_plain"]["session_id"] == "sess_plain_tip",
        threads["threads"],
    )
    check(
        "an adapter-minted session resolves its topic from chat_id",
        by_root["sess_cron"]["topic_id"] == "t_news",
        by_root["sess_cron"],
    )
    check(
        "a bound session resolves its topic through the store",
        by_root["sess_plain"]["topic_id"] == "t_test",
        by_root["sess_plain"],
    )
    check(
        "no listed row is untagged",
        all(row["topic_id"] for row in threads["threads"]),
        threads["threads"],
    )

    # The row preview is a thread's LATEST turn, never the store's opening-prompt
    # ``preview`` column: it is what a client renders under the row's title.
    preview_db = SessionDB()
    try:
        preview_db.append_message("sess_plain_tip", "user", "first line of the thread")
        preview_db.append_message(
            "sess_plain_tip", "assistant", "answer\nwith a newline"
        )
        preview_db.append_message(
            "sess_plain_tip", "tool", '{"output": "machine payload"}'
        )
    finally:
        preview_db.close()
    preview = asyncio.run(api.get_threads("t_test", 5, 0, None))
    check(
        "a listed row previews the newest user or assistant turn, one line, tool rows skipped",
        preview["threads"][0]["latest_message"] == "answer with a newline",
        preview["threads"],
    )
    long_db = SessionDB()
    try:
        long_db.append_message(
            "sess_plain_tip", "assistant", "z" * (api.LATEST_MESSAGE_CHARS + 40)
        )
    finally:
        long_db.close()
    capped = asyncio.run(api.get_threads("t_test", 5, 0, None))
    check(
        "an over-long preview is capped at the row width",
        capped["threads"][0]["latest_message"]
        == "z" * api.LATEST_MESSAGE_CHARS + "...",
        capped["threads"],
    )
    # A turn in flight writes an empty assistant row plus a machine-payload tool row
    # per call, so the newest user turn can sit far behind the newest rows. A row
    # preview that scans a fixed tail goes off the end of the transcript and empties
    # exactly while the thread is busy, which is what a client paints under the title.
    busy_db = SessionDB()
    try:
        busy_db.append_message("sess_plain_tip", "user", "the prompt that must show")
        for index in range(12):
            busy_db.append_message(
                "sess_plain_tip",
                "tool",
                '{"output": "machine payload"}',
                tool_call_id=f"call_{index}",
            )
    finally:
        busy_db.close()
    busy = asyncio.run(api.get_threads("t_test", 5, 0, None))
    check(
        "a busy thread still previews its latest user turn",
        busy["threads"][0]["latest_message"] == "the prompt that must show",
        busy["threads"],
    )

    # The topic filter paginates against the FILTERED set. The t_news match (sess_cron)
    # is the oldest row, so a limit of 1 on the newest-first listing must still surface
    # it; filtering the first `limit` rows returns nothing, and the raw count misreports
    # the total.
    news_db = SessionDB()
    try:
        news_db.create_session("sess_cron2", "local", chat_id="")
    finally:
        news_db.close()
    asyncio.run(api.bind_thread({"session_id": "sess_cron2", "topic_id": "t_news"}))

    filtered = asyncio.run(api.get_threads("t_news", 1, 0, None))
    check(
        "a filtered listing paginates against the filtered set, not the raw first page",
        len(filtered["threads"]) == 1
        and filtered["threads"][0]["lineage_root"] == "sess_cron2"
        and filtered["total"] == 2,
        filtered,
    )
    page2 = asyncio.run(api.get_threads("t_news", 1, 1, None))
    check(
        "the filtered offset walks the filtered rows",
        len(page2["threads"]) == 1
        and page2["threads"][0]["lineage_root"] == "sess_cron"
        and page2["total"] == 2,
        page2,
    )
    empty = asyncio.run(api.get_threads("t_empty", 5, 0, None))
    check(
        "a live topic with no threads filters to an empty page with a zero total",
        empty["threads"] == [] and empty["total"] == 0,
        empty,
    )

    # The lineage walk (sync): the bind handler's root resolution, driven directly.
    lineage_db = SessionDB()
    try:
        root_of_tip = api._lineage_root(lineage_db, "sess_plain_tip")
        root_of_self = api._lineage_root(lineage_db, "sess_plain")
        root_of_missing = api._lineage_root(lineage_db, "nope")
    finally:
        lineage_db.close()
    check(
        "the lineage walk resolves a live id to its compression root",
        root_of_tip == "sess_plain",
        root_of_tip,
    )
    check("a root resolves to itself", root_of_self == "sess_plain", root_of_self)
    check(
        "an unknown session resolves to None", root_of_missing is None, root_of_missing
    )

    # The delete route: the row goes through the core's own session delete, and the binding the
    # row was filed under is dropped in the same call. A core that fences session mutations wants
    # a request_id + expected_revision minted by the owning runtime, which this harness cannot
    # mint, so that core's delete is exercised by its own client instead.
    if _delete_is_fenced():
        print(
            "skip delete-route checks - the installed core fences session mutations "
            "and this harness holds no runtime fence"
        )
    else:
        deleted = asyncio.run(api.delete_thread("sess_cron2", fake_request()))
        check(
            "the delete route reports success",
            bool(deleted.get("ok")),
            deleted,
        )
        gone_db = SessionDB()
        try:
            row_gone = gone_db.get_session("sess_cron2") is None
        finally:
            gone_db.close()
        check("the deleted session's row is gone", row_gone)
        check(
            "the deleted thread's binding is dropped",
            "sess_cron2" not in api.bindings.mapping(),
            api.bindings.mapping(),
        )
        after_delete = asyncio.run(api.get_threads("t_news", 5, 0, None))
        check(
            "the deleted thread drops out of the listing",
            after_delete["total"] == 1
            and after_delete["threads"][0]["lineage_root"] == "sess_cron",
            after_delete,
        )
        absent = asyncio.run(api.delete_thread("nope", fake_request()))
        check(
            "deleting an unknown session is a no-op success",
            bool(absent.get("ok")),
            absent,
        )

    # ---- scheduled runs file under their job's delivery topic -------------------
    # A cron run is its own session (cron_<job id>_<stamp>, source='cron', no chat_id);
    # the topic lives on the JOB's delivery lane. The run must be listed under that
    # topic as the SAME session, so a client that opens the row opens the run itself.
    cron_dir = home / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    (cron_dir / "jobs.json").write_text(
        json.dumps(
            {
                "updated_at": "2026-10-20T09:00:00+08:00",
                "jobs": [
                    {
                        "id": "aaaa11112222",
                        "name": "Explicit",
                        "deliver": "topoi:t_news",
                    },
                    {"id": "bbbb33334444", "name": "Bare home", "deliver": "topoi"},
                    {
                        "id": "cccc55556666",
                        "name": "Dead topic",
                        "deliver": "topoi:t_deleted",
                    },
                    {"id": "dddd77778888", "name": "Local only", "deliver": "local"},
                    {
                        "id": "eeee99990000",
                        "name": "Multi target",
                        "deliver": "telegram:123,topoi:t_empty",
                    },
                    {
                        "id": "ffff00001111",
                        "name": "Failure lane",
                        "deliver": "local",
                        "failure_deliver": "topoi:t_news",
                    },
                    {
                        "id": "1234abcd5678",
                        "name": "List form",
                        "deliver": ["local", "topoi:t_news"],
                    },
                    {
                        "id": "5678abcd1234",
                        "name": "Thread suffix",
                        "deliver": "topoi:t_test:th_1700000000_abc123",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    run_db = SessionDB()
    try:
        for job_id in (
            "aaaa11112222",
            "bbbb33334444",
            "cccc55556666",
            "dddd77778888",
            "eeee99990000",
            "ffff00001111",
            "1234abcd5678",
            "5678abcd1234",
        ):
            run_db.create_session(f"cron_{job_id}_20261020_090000", "cron", chat_id="")
        # A run of a job the store no longer knows: nothing to resolve, so no row.
        run_db.create_session("cron_deadbeef9999_20261020_090000", "cron", chat_id="")
        # A compressed run: the parent ends first, the continuation becomes the tip.
        # The job id rides the ROOT, so the projection is what keeps the run filed.
        run_db.end_session("cron_1234abcd5678_20261020_090000", "compression")
        run_db.create_session(
            "20261020_091500_comp01",
            "cron",
            chat_id="",
            parent_session_id="cron_1234abcd5678_20261020_090000",
        )
    finally:
        run_db.close()

    runs = asyncio.run(api.get_threads(None, 500, 0, None))
    filed = {row["lineage_root"]: row for row in runs["threads"]}
    check(
        "a scheduled run is listed under its job's delivery topic",
        filed.get("cron_aaaa11112222_20261020_090000", {}).get("topic_id") == "t_news",
        filed.get("cron_aaaa11112222_20261020_090000"),
    )
    check(
        "a run is listed as the run's own session, not a copy",
        filed.get("cron_aaaa11112222_20261020_090000", {}).get("session_id")
        == "cron_aaaa11112222_20261020_090000",
        filed.get("cron_aaaa11112222_20261020_090000"),
    )
    check(
        "a bare deliver=topoi run files under the home topic",
        filed.get("cron_bbbb33334444_20261020_090000", {}).get("topic_id") == "t_test",
        filed.get("cron_bbbb33334444_20261020_090000"),
    )
    check(
        "a run whose delivery topic is not a live entry is not listed",
        "cron_cccc55556666_20261020_090000" not in filed,
        runs["threads"],
    )
    check(
        "a local-only job's run is not listed",
        "cron_dddd77778888_20261020_090000" not in filed,
        runs["threads"],
    )
    check(
        "a run of a job the store no longer knows is not listed",
        "cron_deadbeef9999_20261020_090000" not in filed,
        runs["threads"],
    )
    check(
        "a topoi leg in a comma-separated deliver value resolves",
        filed.get("cron_eeee99990000_20261020_090000", {}).get("topic_id") == "t_empty",
        filed.get("cron_eeee99990000_20261020_090000"),
    )
    check(
        "a list-shaped deliver value resolves",
        filed.get("cron_1234abcd5678_20261020_090000", {}).get("topic_id") == "t_news",
        filed.get("cron_1234abcd5678_20261020_090000"),
    )
    check(
        "the failure lane files a run whose deliver points nowhere",
        filed.get("cron_ffff00001111_20261020_090000", {}).get("topic_id") == "t_news",
        filed.get("cron_ffff00001111_20261020_090000"),
    )
    check(
        "a thread-suffixed target resolves to its topic",
        filed.get("cron_5678abcd1234_20261020_090000", {}).get("topic_id") == "t_test",
        filed.get("cron_5678abcd1234_20261020_090000"),
    )
    check(
        "a compressed run resolves through its lineage root at the live tip",
        filed.get("cron_1234abcd5678_20261020_090000", {}).get("session_id")
        == "20261020_091500_comp01",
        [
            row
            for row in runs["threads"]
            if row["session_id"] == "20261020_091500_comp01"
        ],
    )
    filtered_runs = asyncio.run(api.get_threads("t_news", 50, 0, None))
    check(
        "the topic filter counts the runs filed under it",
        {row["lineage_root"] for row in filtered_runs["threads"]}
        >= {
            "cron_aaaa11112222_20261020_090000",
            "cron_ffff00001111_20261020_090000",
            "cron_1234abcd5678_20261020_090000",
        },
        filtered_runs,
    )
    # A human filing beats the job's own lane: Move to topic on a briefing sticks.
    asyncio.run(
        api.bind_thread(
            {"session_id": "cron_bbbb33334444_20261020_090000", "topic_id": "t_news"}
        )
    )
    moved = asyncio.run(api.get_threads("t_news", 50, 0, None))
    check(
        "a binding on a run wins over the job's delivery lane",
        "cron_bbbb33334444_20261020_090000"
        in {row["lineage_root"] for row in moved["threads"]},
        moved,
    )

    # ---- search: one topic's threads, transcript first -------------------------
    # The topic tab's search box rides ``q``. The transcript leg is the store's
    # FTS index, so a thread is found by what was SAID in it and not only by its
    # title; that index is global, so scoping it to the listed set is this
    # handler's job - a hit for another topic must never leak through.
    search_db = SessionDB()
    try:
        search_db.create_session("sess_search", "local", chat_id="")
        search_db.append_message(
            "sess_search", "user", "a note about the fusion reactor shutdown"
        )
        search_db.create_session("sess_search2", "local", chat_id="")
        search_db.append_message(
            "sess_search2", "assistant", "the reactor crew roster for next month"
        )
        search_db.create_session("sess_quiet", "local", chat_id="")
        search_db.append_message("sess_quiet", "user", "nothing to see here")
        # A title match with no message behind it: the title leg has to stand on
        # its own, or a thread whose name says it would be unfindable.
        search_db.set_session_title("sess_quiet", "Spare parts inventory")
    finally:
        search_db.close()
    for session_id in ("sess_search", "sess_search2", "sess_quiet"):
        asyncio.run(api.bind_thread({"session_id": session_id, "topic_id": "t_empty"}))

    hits = asyncio.run(api.get_threads("t_empty", 5, 0, None, "reactor"))
    check(
        "a search finds threads by what was said in them",
        hits["total"] == 2
        and {row["lineage_root"] for row in hits["threads"]}
        == {"sess_search", "sess_search2"},
        hits,
    )
    check(
        "a transcript hit carries its matched line for the row",
        any("reactor" in str(row.get("match") or "") for row in hits["threads"]),
        hits["threads"],
    )
    scoped = asyncio.run(api.get_threads("t_news", 5, 0, None, "reactor"))
    check(
        "a search is scoped to the topic it is asked for",
        scoped["total"] == 0 and scoped["threads"] == [],
        scoped,
    )
    titled = asyncio.run(api.get_threads("t_empty", 5, 0, None, "inventory"))
    check(
        "a search matches a thread's title",
        titled["total"] == 1 and titled["threads"][0]["lineage_root"] == "sess_quiet",
        titled,
    )
    paged_hits = asyncio.run(api.get_threads("t_empty", 1, 0, None, "reactor"))
    check(
        "a search paginates against its own matches",
        len(paged_hits["threads"]) == 1 and paged_hits["total"] == 2,
        paged_hits,
    )
    nomatch = asyncio.run(api.get_threads("t_empty", 5, 0, None, "zzzqqq"))
    check(
        "a search with no match lists nothing",
        nomatch["total"] == 0 and nomatch["threads"] == [],
        nomatch,
    )
    plain = asyncio.run(api.get_threads("t_empty", 50, 0, None))
    plain_roots = {row["lineage_root"] for row in plain["threads"]}
    check(
        "the listing without a query still carries every thread of the topic",
        plain["total"] == len(plain["threads"])
        and {"sess_search", "sess_search2", "sess_quiet"} <= plain_roots,
        plain,
    )

    # A run that delivered into a run thread: the thin thread is the reading copy and the run
    # row is withheld from the topic, while Cron keeps the run as provenance. The join is the
    # plugin's delivery log, so each case writes its own row; the cron lane read is stubbed
    # because the job store is core's own surface (the checks above ride the real one).
    api._cron_job_index = lambda profile: {  # type: ignore[attr-defined]
        "job1": {"topic": "t_news", "name": "Morning Email Briefing"},
        "job2": {"topic": "t_news", "name": "Second Job"},
        "job3": {"topic": "t_news", "name": "Third Job"},
    }
    join_db = SessionDB()
    try:
        # A: the seed lands inside the run's own life, which is how a real delivery lands.
        join_db.create_session("cron_job1_20261021_083000", "cron", chat_id="")
        join_db.create_session(
            "sess_seed_a",
            "topoi",
            chat_id="t_news",
            thread_id="th_1700000000_aaaa11",
            session_key="agent:main:topoi:thread:t_news:th_1700000000_aaaa11",
        )
        join_db.end_session("cron_job1_20261021_083000", "cron_complete")
        # B: a run with no seed at all.
        join_db.create_session("cron_job2_20261021_090000", "cron", chat_id="")
        join_db.end_session("cron_job2_20261021_090000", "cron_complete")
        # C: its seed predates the run, so the run is not withheld behind it.
        join_db.create_session(
            "sess_seed_c",
            "topoi",
            chat_id="t_news",
            thread_id="th_1700000000_cccccc",
        )
        join_db.create_session("cron_job3_20261021_100000", "cron", chat_id="")
        join_db.end_session("cron_job3_20261021_100000", "cron_complete")
    finally:
        join_db.close()
    api.cron_thread.record_delivery(
        topic_id="t_news", thread_id="th_1700000000_aaaa11", job_id="job1"
    )
    api.cron_thread.record_delivery(
        topic_id="t_news", thread_id="th_1700000000_cccccc", job_id="job3"
    )
    joined = asyncio.run(api.get_threads(None, 500, 0, None))
    joined_roots = {row["lineage_root"] for row in joined["threads"]}
    check(
        "a run whose delivered thread is listed is withheld from the topic",
        "cron_job1_20261021_083000" not in joined_roots,
        joined["threads"],
    )
    check(
        "the clean thread it delivered into is listed instead",
        "sess_seed_a" in joined_roots,
        joined["threads"],
    )
    check(
        "a run with no delivery row still lists as the run",
        "cron_job2_20261021_090000" in joined_roots,
        joined["threads"],
    )
    check(
        "a seed dated before the run's life does not withhold it",
        "cron_job3_20261021_100000" in joined_roots,
        joined["threads"],
    )
    archive_db = SessionDB()
    try:
        archive_db.set_session_archived("sess_seed_a", True)
    finally:
        archive_db.close()
    after_archive = asyncio.run(api.get_threads(None, 500, 0, None))
    after_archive_roots = {row["lineage_root"] for row in after_archive["threads"]}
    check(
        "archiving the clean thread brings its run row back",
        "cron_job1_20261021_083000" in after_archive_roots,
        after_archive["threads"],
    )
    restore_db = SessionDB()
    try:
        restore_db.set_session_archived("sess_seed_a", False)
    finally:
        restore_db.close()

    # A cron-seeded session is created whole, so its stored title is NULL: the row is titled
    # from the job's name, and the seed's own framing line never reaches a preview.
    title_db = SessionDB()
    try:
        title_db.append_message(
            "sess_seed_c",
            "user",
            "[Cron delivery: Third Job]\nthe brief body",
        )
    finally:
        title_db.close()
    titled = asyncio.run(api.get_threads("t_news", 50, 0, None))
    titled_rows = {row["lineage_root"]: row for row in titled["threads"]}
    check(
        "an untitled cron-seeded thread is titled with its job name",
        titled_rows.get("sess_seed_c", {}).get("title") == "Third Job",
        titled_rows.get("sess_seed_c"),
    )
    check(
        "a run preview drops the cron-delivery label",
        titled_rows.get("sess_seed_c", {}).get("latest_message") == "the brief body",
        titled_rows.get("sess_seed_c"),
    )
    check(
        "only a seeded thread is titled, and only from its own delivery row",
        titled_rows.get("sess_seed_a", {}).get("title") == "Morning Email Briefing"
        and titled_rows.get("sess_cron", {}).get("title") is None,
        {k: v.get("title") for k, v in titled_rows.items()},
    )

    # ---- cron results as documents ---------------------------------------------
    # A cron artifact is read, not chatted. The listing flags which rows are results and
    # whether a reply can land, and the /cron route renders the document itself.
    api._cron_job_index = lambda profile: {  # type: ignore[attr-defined]
        "job1": {"topic": "t_news", "name": "Morning Email Briefing"},
        "job2": {"topic": "t_news", "name": "Second Job"},
        "job3": {"topic": "t_news", "name": "Third Job"},
        "job4": {"topic": "t_news", "name": "Silent Job"},
        "job5": {"topic": "t_news", "name": "Failing Job"},
    }
    result_db = SessionDB()
    try:
        result_db.create_session(
            "sess_seed_key",
            "topoi",
            chat_id="t_news",
            thread_id="th_1700000000_kkkkkk",
            session_key="agent:main:topoi:thread:t_news:th_1700000000_kkkkkk",
        )
        result_db.append_message(
            "sess_seed_key", "user", "[Cron delivery: Second Job]\nsecond brief body"
        )
        result_db.create_session(
            "sess_app", "topoi", chat_id="t_news", thread_id="th_1700000000_app999"
        )
        result_db.create_session("cron_job4_20261021_110000", "cron", chat_id="")
        result_db.end_session("cron_job4_20261021_110000", "cron_complete")
        result_db.append_message("cron_job4_20261021_110000", "assistant", "[SILENT]")
        result_db.create_session("cron_job5_20261021_120000", "cron", chat_id="")
        result_db.end_session("cron_job5_20261021_120000", "cron_incomplete_no_output")
        result_db.append_message(
            "cron_job5_20261021_120000", "assistant", "the run failed loudly"
        )
        result_db.append_message(
            "cron_job3_20261021_100000", "assistant", "run three final answer"
        )
    finally:
        result_db.close()
    api.cron_thread.record_delivery(
        topic_id="t_news",
        thread_id="th_1700000000_kkkkkk",
        job_id="job2",
    )
    results = asyncio.run(api.get_threads(None, 500, 0, None))
    result_rows = {row["lineage_root"]: row for row in results["threads"]}
    check(
        "a mirrored run thread is flagged as a cron result",
        result_rows.get("sess_seed_key", {}).get("cron_result") is True,
        result_rows.get("sess_seed_key"),
    )
    check(
        "a mirrored run thread with a live seed is replyable",
        result_rows.get("sess_seed_key", {}).get("replyable") is True,
        result_rows.get("sess_seed_key"),
    )
    check(
        "a run row is a cron result but never replyable",
        result_rows.get("cron_job5_20261021_120000", {}).get("cron_result") is True
        and result_rows.get("cron_job5_20261021_120000", {}).get("replyable") is False,
        result_rows.get("cron_job5_20261021_120000"),
    )
    check(
        "a silent ended run is not filed under the topic at all",
        "cron_job4_20261021_110000" not in result_rows,
        sorted(result_rows),
    )
    check(
        "an app-minted topoi chat is not a cron result",
        result_rows.get("sess_app", {}).get("cron_result") is False,
        result_rows.get("sess_app"),
    )
    seeded_doc = asyncio.run(api.get_cron_result("sess_seed_key"))
    check(
        "the cron route renders a mirrored thread's brief with its label stripped",
        seeded_doc["kind"] == "thread"
        and seeded_doc["markdown"] == "second brief body"
        and seeded_doc["title"] == "Second Job",
        seeded_doc,
    )
    check(
        "a mirrored thread reports the session a reply belongs in",
        seeded_doc["replyable"] is True
        and seeded_doc["reply_session_id"] == "sess_seed_key",
        seeded_doc,
    )
    run_doc = asyncio.run(api.get_cron_result("cron_job3_20261021_100000"))
    check(
        "the cron route renders a run's own final answer",
        run_doc["kind"] == "run"
        and run_doc["markdown"] == "run three final answer"
        and run_doc["title"] == "Third Job",
        run_doc,
    )
    check(
        "a run row has no reply target",
        run_doc["replyable"] is False and run_doc["reply_session_id"] is None,
        run_doc,
    )
    for session_id, expected in (("sess_plain", 422), ("no_such_session", 404)):
        try:
            asyncio.run(api.get_cron_result(session_id))
        except api.HTTPException as exc:
            check(
                f"the cron route answers {expected} for {session_id}",
                exc.status_code == expected,
                exc.status_code,
            )
        else:
            check(
                f"the cron route answers {expected} for {session_id}", False, "no error"
            )
    archive_seed = SessionDB()
    try:
        archive_seed.set_session_archived("sess_seed_key", True)
    finally:
        archive_seed.close()
    archived_doc = asyncio.run(api.get_cron_result("sess_seed_key"))
    check(
        "an archived mirror is not replyable",
        archived_doc["replyable"] is False and archived_doc["reply_session_id"] is None,
        archived_doc,
    )
    unarchive_seed = SessionDB()
    try:
        unarchive_seed.set_session_archived("sess_seed_key", False)
    finally:
        unarchive_seed.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("backend route checks: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
