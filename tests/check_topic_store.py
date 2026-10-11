"""Store check for the topic registry: the config block, its validation, the stamp and the home mirror.

Runs against a throwaway ``HERMES_HOME``, so the real config.yaml is never touched. Run:

    ~/.hermes/hermes-agent/venv/bin/python tests/check_topic_store.py
"""

from __future__ import annotations

import importlib
import os
import pathlib
import sys
import tempfile
import time
import types

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    suffix = f" - {detail}" if detail and not ok else ""
    print(f"{'ok  ' if ok else 'FAIL'} {name}{suffix}")
    if not ok:
        failures.append(name)


def load_plugin_module(pkg_name: str, name: str):
    """Load a plugin module under the loader's package name, so its relative imports resolve."""
    if pkg_name not in sys.modules:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]
        sys.modules[pkg_name] = pkg
    sys.path.insert(0, str(ROOT))
    return importlib.import_module(f"{pkg_name}.{name}")


SEED_CONFIG = {
    "agent": {"max_turns": 42},
    "platforms": {
        "topoi": {
            "enabled": True,
            "home_channel": {
                "platform": "topoi",
                "chat_id": "t_briefs",
                "name": "Briefs",
            },
        }
    },
    "plugins": {"enabled": ["topoi"]},
}

# A stamp in the epoch-milliseconds range, so a store that quietly went back to a small counter fails loudly.
EPOCH_MS_FLOOR = 1_700_000_000_000


def main() -> int:
    tree = os.environ.get(
        "HERMES_AGENT_TREE", str(pathlib.Path.home() / ".hermes" / "hermes-agent")
    )
    if pathlib.Path(tree, "hermes_cli").is_dir():
        sys.path.insert(0, tree)
    home = pathlib.Path(tempfile.mkdtemp(prefix="topoi-store-"))
    os.environ["HERMES_HOME"] = str(home)
    config_path = home / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(SEED_CONFIG, sort_keys=False), encoding="utf-8"
    )

    store = load_plugin_module("topoi_store_checked", "topic_store")

    def raw_config() -> dict:
        return yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}

    def block() -> dict | None:
        stored = raw_config().get("platforms", {}).get("topoi", {}).get("topics")
        return stored if isinstance(stored, dict) else None

    def section() -> dict:
        return raw_config().get("platforms", {}).get("topoi", {})

    # An unset registry seeds the gateway's own home topic, so the app's home and the delivery home agree from the first connect.
    seeded = store.load_state()
    check(
        "an unset registry seeds the configured home topic",
        seeded["home_id"] == "t_briefs"
        and seeded["entries"] == [{"id": "t_briefs", "name": "Briefs"}]
        and seeded["updated_at"] == 0,
        seeded,
    )
    check("an unset registry reads as no stored home", store.home_id() == "")
    check("an unset registry stores nothing", block() is None)

    # The retired pre-rename shape (items / revision) is ignored, never half-read, and it says so in the log.
    # A leftover deleted list rides the same rule: ignored on read, gone after the next write.
    raw = raw_config()
    raw["platforms"]["topoi"]["topics"] = {
        "revision": 23,
        "home_id": "t_system",
        "deleted": ["t_gone"],
        "items": [
            {"id": "t_general", "name": "General"},
            {"id": "t_saved", "name": "Saved", "archived": True},
        ],
    }
    config_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    retired = store.load_state()
    check(
        "a block in the retired shape serves no entries and ignores a leftover deleted list",
        retired
        == {
            "updated_at": 0,
            "home_id": "t_system",
            "entries": [],
        },
        retired,
    )

    written = store.write_state(
        {
            "home_id": "t_briefs",
            "entries": [
                {"id": "t_briefs", "name": "Briefs"},
                {"id": "t_general", "name": "General"},
                {"id": "t_work", "name": "Work", "archived": True},
                {"id": "t_quiet", "name": "Quiet", "archived": False},
            ],
        }
    )
    check(
        "the gateway stamps the write",
        written["updated_at"] >= EPOCH_MS_FLOOR,
        written,
    )
    check(
        "the stored state keeps order and archive flags",
        written["entries"]
        == [
            {"id": "t_briefs", "name": "Briefs"},
            {"id": "t_general", "name": "General"},
            {"id": "t_work", "name": "Work", "archived": True},
            {"id": "t_quiet", "name": "Quiet"},
        ],
        written,
    )
    check("the block lands in config.yaml", isinstance(block(), dict), block())
    check(
        "the write rewrites the block in the new shape, dropping the stored deleted key",
        set(block() or {}) == {"updated_at", "home_id", "entries"},
        block(),
    )
    check(
        "the round trip through YAML is the stored state",
        store.load_state() == written,
        store.load_state(),
    )
    check(
        "unrelated config sections survive the write",
        raw_config().get("agent") == {"max_turns": 42},
        config_path.read_text(encoding="utf-8"),
    )
    check(
        "an unchanged home does not rewrite the delivery keys",
        section().get("home_channel")
        == {"platform": "topoi", "chat_id": "t_briefs", "name": "Briefs"},
        section(),
    )
    check(
        "the stamp is epoch milliseconds, not a counter",
        abs(written["updated_at"] - int(time.time() * 1000)) < 60_000,
        written["updated_at"],
    )

    # Moving the home topic has to move the delivery home with it: three readers exist and none of them raises on drift.
    moved = store.write_state(
        {
            "home_id": "t_general",
            "entries": [
                {"id": "t_briefs", "name": "Briefs"},
                {"id": "t_general", "name": "General"},
            ],
        }
    )
    check(
        "each write stamps a newer updated_at",
        moved["updated_at"] > written["updated_at"],
        (written["updated_at"], moved["updated_at"]),
    )
    check(
        "a stalled clock cannot make a newer state look older",
        store._stamp({"updated_at": 10**15}) == 10**15 + 1,
        store._stamp({"updated_at": 10**15}),
    )
    check(
        "the retired stamp key no longer seeds the chain",
        EPOCH_MS_FLOOR <= store._stamp({"revision": 10**15}) < 10**15,
        store._stamp({"revision": 10**15}),
    )
    check(
        "moving home rewrites the channel projection",
        (section().get("home_channel") or {}).get("chat_id") == "t_general"
        and (section().get("home_channel") or {}).get("name") == "General",
        section(),
    )
    check(
        "moving home writes the framework's home_channel projection",
        section().get("home_channel")
        == {"platform": "topoi", "chat_id": "t_general", "name": "General"},
        section(),
    )
    check("the store reports the moved home", store.home_id() == "t_general")

    # The runner's in-process view has to follow the registry: it reads a startup
    # PlatformConfig snapshot that never reloads mid-process, so without the sync a moved home
    # reaches notices and the system prompt's delivery list only after a restart.
    typed = load_live_home()
    check(
        "a live registry read moves the typed projection",
        typed == "t_general/General",
        typed,
    )

    renamed = store.write_state(
        {
            "home_id": "t_general",
            "entries": [
                {"id": "t_briefs", "name": "Briefs"},
                {"id": "t_general", "name": "Project X"},
            ],
        }
    )
    check(
        "renaming the home topic moves the channel name",
        (section().get("home_channel") or {}).get("name") == "Project X",
        section(),
    )
    check(
        "the stamp chain keeps rising",
        renamed["updated_at"] > moved["updated_at"],
        (moved["updated_at"], renamed["updated_at"]),
    )

    # A registry-only home (no entry for it, e.g. a session-derived topic) keeps the operator's label instead of clobbering it with an id.
    store.write_state(
        {
            "home_id": "t_session_derived",
            "entries": [{"id": "t_briefs", "name": "Briefs"}],
        }
    )
    check(
        "a home with no registry entry keeps the last channel name",
        (section().get("home_channel") or {}).get("chat_id") == "t_session_derived"
        and (section().get("home_channel") or {}).get("name") == "Project X",
        section(),
    )

    # A missing projection is the silent failure: the platform still looks connected (the
    # registry alone satisfies is_connected), cron resolves an empty target and nothing
    # raises. Repair at boot rewrites it from the registry; a healthy config is a no-op.
    broken = raw_config()
    broken["platforms"]["topoi"].pop("home_channel", None)
    config_path.write_text(yaml.safe_dump(broken, sort_keys=False), encoding="utf-8")
    check(
        "repair rewrites a missing projection from the registry",
        store.repair_home_projection() is True
        and section().get("home_channel")
        == {
            "platform": "topoi",
            "chat_id": "t_session_derived",
            # No entry and no previous name to fall back on (the key was deleted), so the
            # one-slot rule lands on the id.
            "name": "t_session_derived",
        },
        section(),
    )
    check(
        "repair is a no-op once the projection is healthy",
        store.repair_home_projection() is False,
    )
    stale = raw_config()
    stale["platforms"]["topoi"]["home_channel"] = {
        "platform": "topoi",
        "chat_id": "t_wrong",
        "name": "Wrong",
    }
    config_path.write_text(yaml.safe_dump(stale, sort_keys=False), encoding="utf-8")
    check(
        "repair overwrites a hand-stale projection",
        store.repair_home_projection() is True
        and (section().get("home_channel") or {}).get("chat_id") == "t_session_derived",
        section(),
    )
    # No stored registry: nothing to repair from (the configured home is the only home),
    # so the repair must leave the section alone rather than mint a projection from a default.
    empty = raw_config()
    empty["platforms"]["topoi"].pop("topics", None)
    empty["platforms"]["topoi"].pop("home_channel", None)
    config_path.write_text(yaml.safe_dump(empty, sort_keys=False), encoding="utf-8")
    check(
        "repair does nothing with no stored registry",
        store.repair_home_projection() is False and "home_channel" not in section(),
        section(),
    )

    # Refusals: a client bug has to be visible, and a refused write may not touch what is stored.
    before = config_path.read_text(encoding="utf-8")
    refusals = [
        ("a non-object state", "not-a-state"),
        (
            "entries that are not a list",
            {"home_id": "t_system", "entries": {"id": "t_x", "name": "X"}},
        ),
        (
            "a retired-shape client",
            {
                "home_id": "t_system",
                "revision": 1,
                "items": [{"id": "t_x", "name": "X"}],
            },
        ),
        (
            "a bad entry id",
            {"home_id": "t_system", "entries": [{"id": "t_Bad Id", "name": "Bad"}]},
        ),
        (
            "a repeated entry id",
            {
                "home_id": "t_system",
                "entries": [{"id": "t_x", "name": "X"}, {"id": "t_x", "name": "Y"}],
            },
        ),
        (
            "an entry that is not an object",
            {"home_id": "t_system", "entries": ["t_x"]},
        ),
        ("a bad home id", {"home_id": "System", "entries": []}),
        ("a missing home id", {"entries": []}),
        (
            "more entries than the cap",
            {
                "home_id": "t_system",
                "entries": [
                    {"id": f"t_x{i}", "name": "X"} for i in range(store.MAX_ENTRIES + 1)
                ],
            },
        ),
    ]
    for label, payload in refusals:
        try:
            store.write_state(payload)
        except store.TopicError as error:
            check(f"refused: {label}", bool(str(error)), error)
        except Exception as error:  # noqa: BLE001 - a wrong exception type is the failure
            check(f"refused: {label}", False, f"raised {type(error).__name__}: {error}")
        else:
            check(f"refused: {label}", False, "accepted")
    check(
        "refused writes leave the file untouched",
        config_path.read_text(encoding="utf-8") == before,
    )

    # The retired tombstone tracking is ignored, not refused: a client still
    # sending a deleted list keeps working, and nothing is stored for it.
    tolerated = store.write_state(
        {
            "home_id": "t_system",
            "deleted": ["t_old", "nope", "t_old"],
            "entries": [{"id": "t_system", "name": "System"}],
        }
    )
    check(
        "a client-sent deleted list is ignored, not refused",
        "deleted" not in tolerated and "deleted" not in (block() or {}),
        (tolerated, block()),
    )

    # Reads stay tolerant: a hand-edited block with junk must still serve the app.
    store.write_state(
        {
            "home_id": "t_system",
            "entries": [{"id": "t_system", "name": "System"}],
        }
    )
    raw = raw_config()
    raw["platforms"]["topoi"]["topics"] = {
        "updated_at": "7",
        "home_id": "t_NOPE",
        "deleted": ["t_ok", "bad id", "t_ok"],
        "entries": [
            "junk",
            {"id": "t_ok", "name": "  "},
            {"id": "t_ok", "name": "Dup"},
            {"name": "no id"},
            {},
        ],
    }
    config_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    tolerant = store.load_state()
    check(
        "a hand-edited block is cleaned on read",
        tolerant
        == {
            "updated_at": 0,
            "home_id": "t_system",
            "entries": [{"id": "t_ok", "name": "t_ok"}],
        },
        tolerant,
    )
    check(
        "an invalid stored home falls back to the configured one",
        tolerant["home_id"] == "t_system" and store.home_id() == "",
        (tolerant["home_id"], store.home_id()),
    )

    # A pre-store bindings block in the config is not registry state: the registry read
    # ignores it, legacy_bindings() surfaces it for one-time adoption, and any write
    # replaces the whole block (so the key disappears without anyone touching it).
    raw = raw_config()
    raw["platforms"]["topoi"]["topics"]["bindings"] = {
        "20261009_030000_d4e5f6": "t_ok",
        "bad id": "t_ok",
    }
    config_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    with_legacy = store.load_state()
    check(
        "a legacy bindings block does not leak into the registry read",
        "bindings" not in with_legacy
        and with_legacy["entries"] == [{"id": "t_ok", "name": "t_ok"}],
        with_legacy,
    )
    check(
        "legacy_bindings surfaces the block for adoption",
        dict(store.legacy_bindings())
        == {"20261009_030000_d4e5f6": "t_ok", "bad id": "t_ok"},
        dict(store.legacy_bindings()),
    )
    rewritten = store.write_state(
        {"home_id": "t_ok", "entries": [{"id": "t_ok", "name": "OK"}]}
    )
    check(
        "a registry write drops the legacy bindings key from the block",
        "bindings" not in (block() or {}) and rewritten["entries"][0]["name"] == "OK",
        block(),
    )

    if failures:
        print(f"\ntopic store checks: {len(failures)} failed - {', '.join(failures)}")
        return 1
    print("\ntopic store checks: all passed")
    return 0


def load_live_home() -> str:
    """Drive the adapter's live-home sync against the throwaway config and report what it set.

    The seam under test is ``TopoiAdapter.sync_live_home``: it reads the stored registry and
    repoints the runner's ``PlatformConfig.home_channel`` (what notices and the system prompt's
    delivery list read). Returns the typed projection so a check can assert it moved with the
    registry, with no restart.
    """
    from gateway.config import HomeChannel, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry

    adapter_mod = load_plugin_module("topoi_store_checked", "adapter")
    if not platform_registry.is_registered(adapter_mod.PLATFORM_NAME):

        class _StubCtx:
            def register_platform(self, **kwargs):
                platform_registry.register(PlatformEntry(**kwargs))

        adapter_mod.register(_StubCtx())
    sync = getattr(adapter_mod.TopoiAdapter, "sync_live_home", None)
    if sync is None:  # the pre-fix adapter has no live-home sync at all
        return "<no sync>"
    config = PlatformConfig(enabled=True)
    config.home_channel = HomeChannel(
        platform=adapter_mod.Platform("topoi"), chat_id="t_briefs", name="Briefs"
    )
    adapter = adapter_mod.TopoiAdapter(config)
    adapter.sync_live_home()
    channel = config.home_channel
    return f"{channel.chat_id}/{channel.name}" if channel is not None else "<none>"


if __name__ == "__main__":
    raise SystemExit(main())
