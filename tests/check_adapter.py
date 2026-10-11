"""Adapter contract check for the stripped topoi platform (zero-dep, throwaway HERMES_HOME).

Pins the seams the strip must not break: the tool-progress capability contract (edit_message stays the base method, so the runner keeps draining tool progress), delivery evidence without any listener, the continuable cron thread mint, the deliver=topoi:<topic> target syntax, and the standalone sender. Run:

    ~/.hermes/hermes-agent/venv/bin/python tests/check_adapter.py

"""

from __future__ import annotations

import asyncio
import importlib
import os
import pathlib
import re
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


def load_adapter(pkg_name: str):
    """Load the adapter under the loader's package name, so its relative imports resolve."""
    if pkg_name not in sys.modules:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]
        sys.modules[pkg_name] = pkg
    sys.path.insert(0, str(ROOT))
    return importlib.import_module(f"{pkg_name}.adapter")


SEED_CONFIG = {
    "platforms": {
        "topoi": {
            "enabled": True,
            "home_channel": {
                "platform": "topoi",
                "chat_id": "t_test",
                "name": "Test",
            },
            "topics": {
                "updated_at": 1,
                "home_id": "t_test",
                "entries": [
                    {"id": "t_test", "name": "Test"},
                    {"id": "t_news", "name": "News"},
                ],
                "bindings": {},
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
            f"skip adapter checks - agent tree not found at {tree} (set HERMES_AGENT_TREE)"
        )
        return 0
    sys.path.insert(0, tree)
    home = pathlib.Path(tempfile.mkdtemp(prefix="topoi-adapter-"))
    os.environ["HERMES_HOME"] = str(home)
    (home / "config.yaml").write_text(
        yaml.safe_dump(SEED_CONFIG, sort_keys=False), encoding="utf-8"
    )

    mod = load_adapter("topoi_adapter_checked")
    from gateway.config import HomeChannel, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry

    # The gateway loads the plugin through register(); the registry must know the platform
    # before Platform("topoi") (and any SessionSource) resolves.
    class _StubCtx:
        def register_platform(self, **kwargs):
            platform_registry.register(PlatformEntry(**kwargs))

    mod.register(_StubCtx())
    from gateway.platforms.base import BasePlatformAdapter

    # The capability contract: the runner reads edit_message on the CLASS to decide whether a
    # platform gets editable tool-progress bubbles, so an override silently switches this
    # platform from "drain tool progress" to "post a message per tool update".
    check(
        "edit_message stays the base method",
        mod.TopoiAdapter.edit_message is BasePlatformAdapter.edit_message,
    )
    check(
        "draft streaming stays the base default (no listener to stream to)",
        mod.TopoiAdapter.supports_draft_streaming
        is BasePlatformAdapter.supports_draft_streaming,
    )

    adapter = mod.TopoiAdapter(
        PlatformConfig(
            enabled=True,
            home_channel=HomeChannel(
                platform=mod.Platform("topoi"), chat_id="t_test", name="Test"
            ),
        )
    )
    check("connect marks connected", asyncio.run(adapter.connect()))
    check(
        "home topic falls back to the configured projection",
        adapter.home_topic() == "t_test",
        adapter.home_topic(),
    )

    result = asyncio.run(adapter.send("t_news", "hello"))
    check("send succeeds without a listener", result.success, result)
    check(
        "send mints a message id for the delivery ledger",
        bool(re.fullmatch(r"msg_[0-9a-f]{12}", str(result.message_id or ""))),
        result.message_id,
    )
    check(
        "send falls back to the home topic for an empty chat_id",
        asyncio.run(adapter.send("", "x")).success,
    )

    thread_id = asyncio.run(adapter.create_handoff_thread("t_news", "Hermes - daily"))
    check(
        "a continuable run gets a th_ thread id",
        bool(re.fullmatch(r"th_\d+_[0-9a-f]{6}", str(thread_id or ""))),
        thread_id,
    )
    check(
        "minted ids match the thread shape",
        bool(re.fullmatch(r"th_\d+_[0-9a-f]{6}", mod.mint_thread_id())),
    )

    # deliver=topoi:<topic>[:<thread>] - the native target syntax.
    check(
        "a bare topic parses to a chat target",
        mod._parse_target_ref("t_news") == ("t_news", None),
    )
    check(
        "a topic with a thread id parses to both",
        mod._parse_target_ref(f"t_news:{thread_id}") == ("t_news", thread_id),
    )
    for junk in ("", "t_News", "t_news:t_bad", "t_news:th_1:extra", "general"):
        check(
            f"an unparseable target declines: {junk!r}",
            mod._parse_target_ref(junk) is None,
            mod._parse_target_ref(junk),
        )
    check(
        "a live topic validates",
        mod._validate_target_ref("t_news") is True,
    )
    for bad, expect_substr in (
        ("t_typo", "unknown topic"),
        ("not-a-topic", "not a topoi topic id"),
    ):
        verdict = mod._validate_target_ref(bad)
        check(
            f"a bad target is refused with a reason: {bad}",
            isinstance(verdict, str) and expect_substr in verdict,
            verdict,
        )

    standalone = asyncio.run(
        mod._standalone_send(PlatformConfig(), "t_news", "out of process")
    )
    check(
        "the standalone sender receipts the delivery",
        standalone.get("success") is True
        and standalone.get("platform") == "topoi"
        and standalone.get("chat_id") == "t_news"
        and bool(
            re.fullmatch(r"msg_[0-9a-f]{12}", str(standalone.get("message_id") or ""))
        ),
        standalone,
    )
    home_config = PlatformConfig()
    home_config.home_channel = HomeChannel(
        platform=mod.Platform("topoi"), chat_id="t_test", name="Test"
    )
    check(
        "the standalone sender falls back to the home topic",
        asyncio.run(mod._standalone_send(home_config, "", "x")).get("chat_id")
        == "t_test",
    )

    class _StubConfig:
        def __init__(self, home_channel=None) -> None:
            self.extra: dict = {}
            self.home_channel = home_channel

    check(
        "a home projection counts as connected",
        mod.is_connected(
            _StubConfig(
                HomeChannel(
                    platform=mod.Platform("topoi"), chat_id="t_test", name="Test"
                )
            )
        ),
    )
    # The projection is the only configured-home key, so with no registry stored it alone
    # must carry the platform: a config that has only home_channel is connected and delivers.
    bare = pathlib.Path(tempfile.mkdtemp(prefix="topoi-bare-"))
    (bare / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "platforms": {
                    "topoi": {
                        "enabled": True,
                        "home_channel": {
                            "platform": "topoi",
                            "chat_id": "t_only",
                            "name": "Only",
                        },
                    }
                },
                "plugins": {"enabled": ["topoi"]},
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    saved_home = os.environ["HERMES_HOME"]
    os.environ["HERMES_HOME"] = str(bare)
    try:
        from gateway.config import load_gateway_config

        bare_cfg = load_gateway_config().platforms.get(mod.Platform("topoi"))
        check(
            "a projection with no registry still counts as connected",
            mod.is_connected(bare_cfg),
        )
        bare_adapter = mod.TopoiAdapter(bare_cfg)
        check(
            "a projection with no registry resolves the home",
            bare_adapter.home_topic() == "t_only",
            bare_adapter.home_topic(),
        )
    finally:
        os.environ["HERMES_HOME"] = saved_home

    # The projection is the framework's only view of the home, so a config that lost the
    # key (hand edit, or never written) would silently break deliver=topoi: the platform
    # still looks connected and nothing raises. connect() must repair it from the registry.
    lost = pathlib.Path(tempfile.mkdtemp(prefix="topoi-lost-"))
    (lost / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "platforms": {
                    "topoi": {
                        "enabled": True,
                        "topics": {
                            "updated_at": 1,
                            "home_id": "t_test",
                            "entries": [{"id": "t_test", "name": "Test"}],
                        },
                    }
                },
                "plugins": {"enabled": ["topoi"]},
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    os.environ["HERMES_HOME"] = str(lost)
    try:
        from gateway.config import load_gateway_config

        lost_cfg = load_gateway_config().platforms.get(mod.Platform("topoi"))
        lost_adapter = mod.TopoiAdapter(lost_cfg)
        asyncio.run(lost_adapter.connect())
        healed = load_gateway_config().platforms.get(mod.Platform("topoi"))
        check(
            "connect repairs a lost home projection from the registry",
            healed is not None
            and healed.home_channel is not None
            and healed.home_channel.chat_id == "t_test",
            getattr(healed, "home_channel", None),
        )
    finally:
        os.environ["HERMES_HOME"] = saved_home
    check("check_requirements is unconditional", mod.check_requirements())
    check("register is callable", callable(mod.register))

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("adapter contract checks: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
