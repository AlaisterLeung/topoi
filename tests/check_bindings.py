"""Binding store check (zero-dep, throwaway HERMES_HOME).

The session-to-topic index lives in a plugin-private SQLite store, not config.yaml: bindings are high-churn and unbounded, the registry is not, and the REST surface resolves a thread's topic server-side so clients never see the map. Covers the store lifecycle (set, overwrite, clear, mapping, persistence across fresh connections), pruning against the live topic set, the dead-root sweep with its threshold, root-shape refusal, the one-time adoption of a legacy config block, the cross-module seams the REST write path composes (a registry write pruning the store; the live-topic check gating a bind), and the sync bind core the async handler wraps (validation order, response shape, store effect). Run:

    ~/.hermes/hermes-agent/venv/bin/python tests/check_bindings.py

"""

from __future__ import annotations

import importlib
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


def load_module(pkg_name: str, name: str):
    """Load a plugin-root module under a package shim, so a plain import works."""
    if pkg_name not in sys.modules:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]
        sys.modules[pkg_name] = pkg
    sys.path.insert(0, str(ROOT))
    return importlib.import_module(f"{pkg_name}.{name}")


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
            f"skip binding checks - agent tree not found at {tree} (set HERMES_AGENT_TREE)"
        )
        return 0
    sys.path.insert(0, tree)
    home = pathlib.Path(tempfile.mkdtemp(prefix="topoi-bindings-"))
    os.environ["HERMES_HOME"] = str(home)

    store = load_module("topoi_bindings_checked", "bindings")
    registry = load_module("topoi_bindings_checked", "topic_store")
    api = load_module("topoi_bindings_checked", "dashboard.plugin_api")
    (home / "config.yaml").write_text(
        yaml.safe_dump(SEED_CONFIG, sort_keys=False), encoding="utf-8"
    )

    # The store lands under the profile's plugin-data dir, never in config.yaml.
    check(
        "the store lives under plugin-data",
        store.db_path() == home / "plugin-data" / "topoi" / "bindings.db",
        store.db_path(),
    )
    check("a fresh store is empty", store.mapping() == {})

    store.set_binding("sess_root", "t_general")
    check(
        "a binding round trips",
        store.mapping() == {"sess_root": "t_general"},
        store.mapping(),
    )
    # mapping() opens a fresh connection per call, so a second read is a persistence proof.
    check(
        "a binding survives a fresh connection",
        store.mapping().get("sess_root") == "t_general",
    )

    store.set_binding("sess_root", "t_work")
    check(
        "re-binding moves the topic",
        store.mapping() == {"sess_root": "t_work"},
        store.mapping(),
    )

    store.set_binding("sess_two", "t_general")
    dropped = store.prune_to(["t_general"])
    check(
        "prune drops bindings to topics no longer live",
        dropped == 1 and store.mapping() == {"sess_two": "t_general"},
        (dropped, store.mapping()),
    )
    check(
        "prune with every topic live drops nothing", store.prune_to(["t_general"]) == 0
    )

    try:
        store.set_binding("bad id", "t_general")
    except store.BindingError as error:
        check("a bad session id is refused", bool(str(error)), error)
    except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
        check(
            "a bad session id is refused",
            False,
            f"raised {type(error).__name__}: {error}",
        )
    else:
        check("a bad session id is refused", False, "accepted")
    try:
        store.set_binding("sess_three", "")
    except store.BindingError as error:
        check("a missing topic is refused", bool(str(error)), error)
    except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
        check(
            "a missing topic is refused",
            False,
            f"raised {type(error).__name__}: {error}",
        )
    else:
        check("a missing topic is refused", False, "accepted")

    store.clear_binding("sess_two")
    check("clear removes the binding", store.mapping() == {}, store.mapping())
    store.clear_binding("sess_never")
    check("clearing a never-bound root is a no-op", store.mapping() == {})

    # The dead-root sweep: below the threshold it does not run at all, past it drops
    # every root the caller's liveness probe reports gone.
    for index in range(5):
        store.set_binding(f"s{index}", "t_general")
    dead = {"s1", "s2", "s3", "s4", "s5"}
    swept = store.sweep_dead_roots(lambda root: root not in dead)
    check(
        "below the threshold the sweep does not run",
        swept == 0 and len(store.mapping()) == 5,
        (swept, store.mapping()),
    )
    for index in range(5, 205):
        store.set_binding(f"s{index}", "t_general")
    swept = store.sweep_dead_roots(lambda root: root not in dead)
    check(
        "past the threshold the sweep drops dead roots",
        swept == 5
        and len(store.mapping()) == 200
        and not (dead & set(store.mapping())),
        (swept, len(store.mapping())),
    )
    store.drop_roots([f"s{index}" for index in range(10, 200)])
    check(
        "below the threshold again the sweep stays off",
        store.sweep_dead_roots(lambda root: False) == 0,
        len(store.mapping()),
    )
    store.drop_roots(list(store.mapping()))
    check("drop_roots empties the store", store.mapping() == {})

    # One-time adoption of a legacy config block: valid rows import, junk is skipped,
    # and what the store already holds is never overwritten.
    adopted = store.adopt_config_block(
        {"sess_x": "t_general", "bad id": "t_general", "sess_y": ""}
    )
    check(
        "adoption imports valid rows and skips junk",
        adopted == 1 and store.mapping() == {"sess_x": "t_general"},
        (adopted, store.mapping()),
    )
    store.set_binding("sess_x", "t_work")
    readopted = store.adopt_config_block({"sess_x": "t_general"})
    check(
        "adoption never overwrites what the store holds",
        readopted == 0 and store.mapping()["sess_x"] == "t_work",
        (readopted, store.mapping()),
    )
    check("a non-mapping block adopts nothing", store.adopt_config_block("nope") == 0)

    # The two seams the REST write path composes: a registry write prunes the store
    # (a deleted topic takes its bindings), and the live-topic check gates a bind.
    store.set_binding("sess_news", "t_news")
    store.set_binding("sess_test", "t_test")
    check(
        "the live-topic check sees the registry's entries",
        api._live_topic_ids() == {"t_test", "t_news"},
        api._live_topic_ids(),
    )
    state = registry.write_state(
        {
            "home_id": "t_test",
            "entries": [{"id": "t_test", "name": "Test"}],
        }
    )
    dropped = api._prune_after_registry_write(state)
    check(
        "a registry write that deletes a topic prunes its bindings",
        dropped == 2 and store.mapping() == {"sess_test": "t_test"},
        (dropped, store.mapping()),
    )
    check(
        "the live-topic check no longer sees the deleted topic",
        api._live_topic_ids() == {"t_test"},
        api._live_topic_ids(),
    )

    # The sync core the async handler wraps: driven directly, with the db lifecycle
    # owned by the caller exactly as the handler owns it. This is the layer that
    # validates order, the response shape, and the store effect end to end.
    from hermes_state import SessionDB

    registry.write_state(
        {
            "home_id": "t_test",
            "entries": [
                {"id": "t_test", "name": "Test"},
                {"id": "t_news", "name": "News"},
            ],
        }
    )
    session_db = SessionDB()
    try:
        # A session the adapter itself mints: source=topoi, topic in chat_id.
        session_db.create_session(
            "sess_cron", "topoi", chat_id="t_news", thread_id="th_1700000000_abc123"
        )
        session_db.create_session("sess_plain", "local", chat_id="")
        # A compression continuation: the parent ends FIRST (the edge test requires
        # child.started_at >= parent.ended_at), and the core resolves the live id
        # back to the root before storing.
        session_db.end_session("sess_plain", "compression")
        session_db.create_session(
            "sess_plain_tip", "local", chat_id="", parent_session_id="sess_plain"
        )

        bound = api._bind_core(session_db, "sess_plain", "t_news")
        check(
            "the bind core returns the response shape",
            bound
            == {
                "session_id": "sess_plain",
                "lineage_root": "sess_plain",
                "topic_id": "t_news",
            },
            bound,
        )
        check(
            "the bind core wrote the store",
            store.mapping().get("sess_plain") == "t_news",
            store.mapping(),
        )
        # A re-file needs the explicit move flag: a plain bind on an already-filed
        # root is a conflict, which is what keeps a stale client arm from
        # relocating a thread (the random-move report).
        try:
            api._bind_core(session_db, "sess_plain_tip", "t_test")
        except api.BindConflict as error:
            check(
                "re-filing without move is a BindConflict (409)",
                "already filed under t_news" in str(error)
                and store.mapping()["sess_plain"] == "t_news",
                str(error),
            )
        except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
            check(
                "re-filing without move is a BindConflict (409)",
                False,
                f"raised {type(error).__name__}: {error}",
            )
        else:
            check("re-filing without move is a BindConflict (409)", False, "accepted")
        bound_tip = api._bind_core(session_db, "sess_plain_tip", "t_test", move=True)
        check(
            "binding a live id resolves to the lineage root",
            bound_tip["lineage_root"] == "sess_plain"
            and store.mapping()["sess_plain"] == "t_test",
            bound_tip,
        )
        same = api._bind_core(session_db, "sess_plain", "t_test")
        check(
            "re-filing under the same topic needs no move flag",
            same["topic_id"] == "t_test" and store.mapping()["sess_plain"] == "t_test",
            same,
        )
        # The check order: a request that fails both checks is the 404.
        try:
            api._bind_core(session_db, "nope", "t_typo")
        except LookupError as error:
            check(
                "an unknown session is a LookupError (404)",
                "unknown session" in str(error),
                error,
            )
        except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
            check(
                "an unknown session is a LookupError (404)",
                False,
                f"raised {type(error).__name__}: {error}",
            )
        else:
            check("an unknown session is a LookupError (404)", False, "accepted")
        try:
            api._bind_core(session_db, "sess_plain", "t_typo")
        except ValueError as error:
            check(
                "an unknown topic is a ValueError (422)",
                "unknown topic" in str(error),
                error,
            )
        except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
            check(
                "an unknown topic is a ValueError (422)",
                False,
                f"raised {type(error).__name__}: {error}",
            )
        else:
            check("an unknown topic is a ValueError (422)", False, "accepted")
        try:
            api._bind_core(session_db, "", "t_news")
        except ValueError as error:
            check(
                "a missing session_id is a ValueError (422)",
                "required" in str(error),
                error,
            )
        except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
            check(
                "a missing session_id is a ValueError (422)",
                False,
                f"raised {type(error).__name__}: {error}",
            )
        else:
            check("a missing session_id is a ValueError (422)", False, "accepted")
        check(
            "the core left the pre-existing binding plus the bound root",
            store.mapping() == {"sess_test": "t_test", "sess_plain": "t_test"},
            store.mapping(),
        )
    finally:
        session_db.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("binding store checks: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
