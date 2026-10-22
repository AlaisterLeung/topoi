"""Cron thread pairing check (zero-dep, throwaway HERMES_HOME).

The run-to-thread pairing lives in a plugin-private SQLite store beside the bindings: one row per confirmed delivery that carried both a job id and a thread id, written by the adapter and read by the listing and the /cron route. Covers the store (record, upsert by thread id, thread -> job mapping, persistence across fresh connections, shape refusals) and the run-id parse. The window match lives in the listing, not here: it reads the seed session's own started_at. Run:

    ~/.hermes/hermes-agent/venv/bin/python tests/check_cron_thread.py

"""

from __future__ import annotations

import importlib
import os
import pathlib
import sqlite3
import sys
import tempfile
import types

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


def main() -> int:
    home = pathlib.Path(tempfile.mkdtemp(prefix="topoi-thread-log-"))
    os.environ["HERMES_HOME"] = str(home)

    log = load_module("topoi_cron_thread_checked", "cron_thread")

    check(
        "the store lives in the plugin's private data dir",
        log.db_path() == home / "plugin-data" / "topoi" / "cron_thread.db",
        log.db_path(),
    )
    check(
        "an empty store has no rows", log.jobs_by_thread() == {}, log.jobs_by_thread()
    )

    log.record_delivery(
        topic_id="t_news", thread_id="th_1700000000_aaaaaa", job_id="job1"
    )
    log.record_delivery(
        topic_id="t_news", thread_id="th_1700000000_bbbbbb", job_id="job1"
    )
    log.record_delivery(
        topic_id="t_work", thread_id="th_1700000000_cccccc", job_id="job2"
    )
    mapped = log.jobs_by_thread()
    check(
        "every delivered thread maps to the job that seeded it",
        mapped
        == {
            "th_1700000000_aaaaaa": "job1",
            "th_1700000000_bbbbbb": "job1",
            "th_1700000000_cccccc": "job2",
        },
        mapped,
    )

    log.record_delivery(
        topic_id="t_work", thread_id="th_1700000000_aaaaaa", job_id="job3"
    )
    remapped = log.jobs_by_thread()
    check(
        "re-recording a thread id replaces its row",
        len(remapped) == 3 and remapped["th_1700000000_aaaaaa"] == "job3",
        remapped,
    )
    columns = {
        row[1]
        for row in sqlite3.connect(log.db_path()).execute(
            "PRAGMA table_info(deliveries)"
        )
    }
    check(
        "the store carries the join only",
        columns == {"thread_id", "topic_id", "job_id"},
        columns,
    )

    for missing in ({"topic_id": ""}, {"thread_id": ""}, {"job_id": ""}):
        field = next(iter(missing))
        kwargs = {
            "topic_id": "t_news",
            "thread_id": "th_1700000000_dddddd",
            "job_id": "job1",
            **missing,
        }
        try:
            log.record_delivery(**kwargs)
        except log.DeliveryError:
            check(f"a blank {field} is refused", True)
        else:
            check(f"a blank {field} is refused", False, "accepted")

    check(
        "a run id parses to its job id",
        log.run_job_id("cron_010c6f508731_20261021_083033") == "010c6f508731",
    )
    check(
        "a non-run id has no job id",
        log.run_job_id("20261021_110957_083f9f") is None
        and log.run_job_id("") is None
        and log.run_job_id("cron_nostamp") is None,
    )

    fresh = load_module("topoi_cron_thread_checked_fresh", "cron_thread")
    check(
        "a fresh connection reads the same rows",
        fresh.jobs_by_thread() == remapped,
        fresh.jobs_by_thread(),
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("cron thread pairing checks: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
