"""Topoi platform adapter - a delivery namespace for topics.

There is no inbound transport: nothing connects to this platform. What remains is what cron and the framework's notice paths need - a home topic, per-run thread ids for continuable cron runs, and a send() that records the delivery. The topic registry and topic-grouped session listings are served over REST by ``dashboard/plugin_api.py`` (CONTRACT.md), which is where a client reads topics and thread lists from.

Thread ids: ``th_<epoch>_<hex6>``.
    ``create_handoff_thread(parent_chat_id, name)`` receives no job id, so the id is minted locally.

"""

from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any

from gateway.config import HomeChannel, Platform, PlatformConfig
from gateway.platforms._shared import send_error
from gateway.platforms.base import BasePlatformAdapter, SendResult

from .cron_thread import record_delivery
from .topic_store import home_id as _stored_home_id
from .topic_store import home_label as _stored_home_label
from .topic_store import is_topic_id as _is_topic_id
from .topic_store import load_state as _load_registry
from .topic_store import repair_home_projection as _repair_home_projection

logger = logging.getLogger(__name__)

PLATFORM_NAME = "topoi"
DEFAULT_HOME_TOPIC = "t_system"

# The thread id shape create_handoff_thread mints, so an explicit deliver target can name one.
_THREAD_RE = re.compile(r"^th_\d+_[0-9a-f]{6}$")


def mint_thread_id() -> str:
    """Mint a thread id: ``th_<epoch-seconds>_<6 hex>``."""
    return f"th_{int(time.time())}_{uuid.uuid4().hex[:6]}"


def _parse_target_ref(target_ref: str) -> tuple[str, str | None] | None:
    """``<topic>`` / ``<topic>:<thread>`` -> ``(chat_id, thread_id)``; None lets resolution continue (a bare name, a channel-directory lookup).

    This is the native ``deliver=topoi:...`` syntax: a topic id, optionally with one of the adapter's thread ids for a continuable run. Anything else returns None so the core falls back to its own resolution instead of guessing.
    """
    parts = str(target_ref or "").strip().split(":")
    if len(parts) == 1 and _is_topic_id(parts[0]):
        return parts[0], None
    if len(parts) == 2 and _is_topic_id(parts[0]) and _THREAD_RE.match(parts[1]):
        return parts[0], parts[1]
    return None


def _validate_target_ref(chat_id: str) -> bool | str:
    """Accept a topic id only when it is a live registry entry, so ``deliver=topoi:t_typo`` fails with a reason instead of delivering into a topic no client shows."""
    topic = str(chat_id or "").strip()
    if not _is_topic_id(topic):
        return f"'{chat_id}' is not a topoi topic id (shape t_*)"
    entry_ids = {
        str(entry.get("id")) for entry in _load_registry().get("entries") or []
    }
    if topic not in entry_ids:
        return f"unknown topic '{topic}' (not in the topoi registry)"
    return True


class TopoiAdapter(BasePlatformAdapter):
    """Outbound-only: deliveries are recorded, continuable cron runs get a fresh reply-able thread id."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        channel = config.home_channel
        self._home = str(channel.chat_id) if channel is not None else ""

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        self._mark_connected()
        # The typed projection is the framework's only view of the home, and it lives only in
        # config.yaml: a missing or hand-stale home_channel silently breaks deliver=topoi
        # (the platform still looks connected, so nothing raises), so repair it from the
        # registry at boot, before any delivery can be lost.
        _repair_home_projection()
        logger.info("[topoi] connected (home_topic=%s)", self.home_topic())
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        logger.info("[topoi] disconnected")

    def home_topic(self) -> str:
        """The live home topic: the topic registry's ``home_id`` once a client has stored one, else the configured ``home_channel`` projection.

        Read per use rather than cached at connect, so moving the home topic in a client retargets deliveries without a gateway restart.
        """
        return _stored_home_id() or self._home or DEFAULT_HOME_TOPIC

    def sync_live_home(self) -> None:
        """Point this process's framework-visible home at the live registry.

        The adapter itself already resolves dynamically, but the framework's readers do not:
        notices and the system prompt's delivery list read the runner's startup
        ``PlatformConfig`` snapshot, which never reloads mid-process, so a home moved through
        the registry reaches those readers only after a restart. Called by the REST write path
        (the one process that both stores the registry and can hold an adapter) so the views
        move together, mirroring ``yuanbao``'s auto-sethome. Cron needs no help here: it
        resolves ``deliver=topoi`` through a fresh config load on every delivery.
        """
        state = _load_registry()
        home = _stored_home_id() or self._home or DEFAULT_HOME_TOPIC
        name = _stored_home_label(state, "")
        channel = self.config.home_channel
        if channel is not None and channel.chat_id == home and channel.name == name:
            return
        self.config.home_channel = HomeChannel(
            platform=Platform(PLATFORM_NAME), chat_id=home, name=name
        )
        logger.info("[topoi] live home moved to %s (%s)", home, name)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        """Record a delivery. No socket exists, so the delivery IS the record: the session the gateway seeded for a continuable run (or the cron run session) holds the content, and every client reads it from there. The message id is minted so the delivery ledger has one, as any other platform's send returns."""
        topic = str(chat_id or self.home_topic())
        thread_id = str((metadata or {}).get("thread_id") or "")
        message_id = f"msg_{uuid.uuid4().hex[:12]}"
        # A run-thread delivery names its job (the core puts it in the route metadata) and the thread it opened, so record the pair here. This is the only place that holds both; the seeded session names neither, and the listing needs the join to withhold the run's own transcript.
        job_id = str((metadata or {}).get("job_id") or "")
        if thread_id and job_id:
            try:
                record_delivery(
                    topic_id=topic,
                    thread_id=thread_id,
                    job_id=job_id,
                )
            except Exception:
                # A missing log row only means the run row keeps showing, never a lost delivery.
                logger.warning(
                    "[topoi] delivery log write failed for %s/%s",
                    job_id,
                    thread_id,
                    exc_info=True,
                )
        logger.info(
            "[topoi] delivery -> %s%s (%d chars)",
            topic,
            f"/{thread_id}" if thread_id else "",
            len(content or ""),
        )
        return SendResult(success=True, message_id=message_id)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": chat_id, "type": "group"}

    async def create_handoff_thread(self, parent_chat_id: str, name: str) -> str | None:
        """Mint the run thread id for a continuable cron delivery."""
        thread_id = mint_thread_id()
        logger.info(
            "[topoi] opened cron thread %s in %s (%s)", thread_id, parent_chat_id, name
        )
        return thread_id


def check_requirements() -> bool:
    return True


def validate_config(config) -> bool:
    """The platform is configured when a home exists: a stored registry, or the ``home_channel`` projection."""
    return bool(
        _stored_home_id()
        or (
            (channel := getattr(config, "home_channel", None)) is not None
            and str(channel.chat_id or "").strip()
        )
    )


def is_connected(config) -> bool:
    return validate_config(config)


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: str | None = None,
    media_files: list | None = None,
    force_document: bool = False,
) -> dict[str, Any]:
    """Out-of-process cron delivery (``hermes cron run`` with no live adapters). Nothing is pushed anywhere; the run is reconstructible from the cron run session plus the job's deliver config, so the receipt only proves the lane accepted it."""
    try:
        channel = getattr(pconfig, "home_channel", None)
        configured = str(channel.chat_id) if channel is not None else ""
        topic = str(chat_id or _stored_home_id() or configured or DEFAULT_HOME_TOPIC)
        message_id = f"msg_{uuid.uuid4().hex[:12]}"
        logger.info(
            "[topoi] standalone delivery -> %s (%d chars)",
            topic,
            len(message or ""),
        )
        return {
            "success": True,
            "platform": PLATFORM_NAME,
            "chat_id": topic,
            "message_id": message_id,
        }
    except Exception as e:  # noqa: BLE001 - mirror the send_error contract
        return send_error(f"topoi standalone send failed: {e}")


def register(ctx) -> None:
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Topoi",
        adapter_factory=lambda cfg: TopoiAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        parse_target_ref_fn=_parse_target_ref,
        validate_target_ref_fn=_validate_target_ref,
        # Dummy env var for keeping Topoi in cron delivery platform table (required by _is_known_delivery_platform)
        cron_deliver_env_var="TOPOI_HOME_TOPIC",
        standalone_sender_fn=_standalone_send,
        emoji="💬",
        pii_safe=True,
    )
