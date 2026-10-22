# Topoi contract

This is the contract between the gateway side of this package and every client of it. It covers the identifiers, the configuration keys, the REST surface, the cron delivery contract, the events, and the desktop half install. This repo holds the canonical copy, and a client that speaks the surface should vendor a pinned copy of this file alongside its code.

There is no inbound transport and no protocol of our own. The gateway side is a delivery namespace: cron results and framework notices land in topic-keyed sessions, and a continuable run gets a fresh reply-able thread. The gateway side also serves the topic registry and topic-grouped session listings over REST. The desktop half (the Hermes Desktop plugin at `desktop/plugin.js`) is the primary client and the dashboard extension is a second one, but anything that can reach `/api/plugins/topoi/` can read and write the same state.

## Contents

1. [Identifiers](#1-identifiers)
2. [Configuration](#2-configuration)
3. [REST surface](#3-rest-surface)
4. [Delivery contract](#4-delivery-contract)
5. [Events](#5-events)
6. [Desktop half install](#6-desktop-half-install)

## 1. Identifiers

| Kind | Shape | Minted by |
| --- | --- | --- |
| Topic id | `t_[a-z0-9_]+` | the client, when creating a topic |
| Thread id | `th_<epoch-seconds>_<6 hex>` | the adapter's `create_handoff_thread` |
| Message id | `msg_<12 hex>` | the adapter's `send` |
| Session id | whatever `state.db` mints | Hermes core |

A topic id outside its shape never becomes a topic, whatever wrote it. The client picks a topic's id when the topic is created, and it is fixed from then on: neither the dashboard nor the desktop half offers an id edit afterwards. A thread id is opaque to clients; it exists so a continuable cron run has a stable key. Message ids are minted so the delivery ledger has one, the same as any platform's send; no socket carries them.

## 2. Configuration

```yaml
platforms:
  topoi:
    enabled: true
    topics:                       # the registry, gateway-owned, see topic_store.py
      updated_at: 1791372109923   # epoch ms of the last stored write
      home_id: t_system
      entries:
        - {id: t_general, name: General}
        - {id: t_work, name: Work, archived: true}
    home_channel:                 # framework projection of home_id, written with it
      platform: topoi
      chat_id: t_system
      name: System
```

`home_channel` is the only configured-home key. It seeds the home when no registry is stored yet, and the registry rewrites it whenever `home_id` moves, so the delivery home a bare `deliver=topoi` targets never drifts from the home the app shows.

A registry write moves both keys (`topics.home_id`, `home_channel`) in the same read-modify-write, so a fresh process and a fresh `load_gateway_config()` always see the moved home. The same write path syncs the in-process views: `TopoiAdapter.sync_live_home()` repoints the runner's `PlatformConfig.home_channel`, which is a startup snapshot that never reloads mid-process and feeds framework notices and the system prompt's delivery list. Cron needs no help there: it resolves through a fresh config load on every delivery.

Because `home_channel` is the only thing that feeds the typed projection, a config that lost the key (hand edit, or one never written) would silently break `deliver=topoi`. The platform still looks connected, since the registry alone satisfies `is_connected`, and nothing raises. The adapter's `connect()` therefore calls `repair_home_projection()`, which rewrites the projection from the stored registry when it is missing or stale; a healthy config costs one cached read and no write.

### 2.1 The registry block

The registry block is the only home for topic state: topics are low-churn (a rename, an archive, a reorder), and a config block survives both the gateway and its clients. `updated_at` is stamped server-side on every write and nudged to stay strictly increasing, so a stalled clock can never make a newer registry look older.

### 2.2 Bindings

Session-to-topic bindings do NOT live in the config block. They are high-churn, session-scoped and unbounded, so they live in a plugin-private SQLite store at `<hermes home>/plugin-data/topoi/bindings.db`. Clients never see the map: the REST layer resolves a thread's topic server-side on every `GET /threads`. A binding maps a session's lineage root (the durable id that survives compression) to a topic.

A session's topic is resolved as follows:
- A session the adapter itself minted (`source: topoi`) carries its topic in `chat_id` and never consults the store.
- A scheduled run (`source: cron`) resolves from its job's delivery lane, a read of the job store rather than a binding.
- Every other session resolves through the store, keyed by lineage root.

The only write path is `POST /threads/bind`: a client files a freshly created chat under a topic, or moves a listed thread (a scheduled run included) to another one with `move: true`. Without that flag a bind only ever creates a filing: if the thread already sits under a different topic the route answers 409, so a client that fires on the wrong chat cannot relocate it. There is no unfile operation, so a thread's topic is fixed once it is filed. Deleting a topic prunes its bindings in the same registry write, and bindings to sessions that no longer exist are swept opportunistically on the bind path. A legacy config-level `bindings` block (left by an earlier build) is ignored on read, adopted into the store once on the first `GET /topics`, and dropped by the next registry write.

An older block may still use the retired `items` / `revision` spellings; they are ignored, never half-read.

### 2.3 Cron thread pairings

A cron run and the run thread it delivered into never name each other: the seeded session carries a topic and a thread id but no job id, and the run session carries the job id but no thread. `cron_thread.db` (same directory, same shape as the bindings) holds that pairing: one row per confirmed delivery that carried both, `thread_id`, `topic_id`, `job_id`.

The adapter writes it inside `send()`, the only place the core's route metadata hands over `job_id` and `thread_id` together (`cron/scheduler_delivery.py::_live_route_metadata`). A write that fails is logged and dropped: a missing row only means the run row keeps showing, never a lost delivery.

The listing reads it to withhold a run row whose clean thread is listed (section 3.3). No stamp is stored: the seed's own session row carries `started_at`, and a run is withheld when a delivery row names its job, the seed is live under that same topic, and the seed's start falls inside the run's life (`started_at` to `ended_at`, or now for a run still open) plus a grace for the finalize that follows the send.

## 3. REST surface

All routes mount under `/api/plugins/topoi/`, behind the dashboard's normal auth gate. The Python half is imported only when the plugin is in `plugins.enabled`; routes of a disabled plugin are rejected at request time.

### 3.1 `GET /topics`

`GET /topics` returns the registry: `updated_at`, `home_id`, and `entries` in order. Bindings are server-side only and are never shipped as a map. Deleted topics are not tracked anywhere. Only a topic with no threads can be deleted (both clients offer delete only for a 0-thread topic), so there is no tombstone list. A leftover `deleted` key in the block is ignored on read, and the next registry write drops it from the file.

### 3.2 `PUT /topics`

`PUT /topics` stores a client-sent registry whole, last writer wins, and returns what was stored, stamped. A structural refusal (a bad id shape, a repeated id, a non-object state, an over-cap list) is a 422 carrying the reason, and the stored block is left untouched. A blank or over-long name is cleaned rather than refused.

### 3.3 `GET /threads`

`GET /threads` lists sessions resolved to topics, newest activity first, and only those filed under a live topic: an untagged session never appears, and neither does a thread whose topic is no longer a live entry (a deleted topic, including a `source: topoi` session whose delivery topic is gone). `topic_id` is therefore never null. Each row carries:

- `session_id` - the live chain tip a client opens
- `lineage_root` - the durable id bindings key on
- `topic_id` - a live registry entry
- `title`, `latest_message`, `started_at`, `last_active`, `message_count`, `source`
- `cron_result`, `cron_kind`, `replyable` - the reader flags below

`latest_message` is the newest user or assistant text of the thread, whitespace-collapsed to one line and capped at a row-preview width, so a client can render two-line rows without a second call. It is deliberately not the store's own `preview` column: that one is the session's opening user prompt, which answers a title lookup but never the "what happened last" a listing row shows. Tool rows are skipped and the read pages back from the newest row, so the field costs one bounded read per listed row.

How each listed row resolves its topic:
- A `source: topoi` session resolves its topic from `chat_id` (the adapter mints those for cron deliveries) and never consults the binding store.
- A scheduled run is listed here too: a `source: cron` row (`cron_<job id>_<stamp>`, the session the Cron platform listing shows) resolves to the topic its job's `deliver` lane addresses, `topoi:<topic>` or the home topic for a bare `topoi`, with `failure_deliver` as the fallback. When that run delivered into a run thread whose seeded session is listed, the run row is withheld from topics: the thin thread is the reading copy and `Cron` keeps the run as provenance. The pairing is the plugin's cron thread store (`cron_thread.db`, written by the adapter from the route metadata's `job_id` + `thread_id`), and it needs both proofs - a pairing row for the run's job and a live session for that exact topic and thread, whose own `started_at` falls inside the run's life. A run that delivered into no thread (`[SILENT]`, a failed send, a deleted or archived thread) is listed as the run row, so no result goes missing.
- Every other session resolves through the store, keyed by lineage root.

Nothing is stored for the cron resolution; the job store is the record. That is why a job whose `deliver` is retargeted moves its older runs with it, a run of a deleted job drops out of its topic (the session itself stays under Cron), and a client-filed binding still wins, so Move to topic sticks.

A cron row is a result, not a chat, and the listing says which shape it is. `cron_result` is true for a `source: cron` row and for a `source: topoi` row whose thread has a delivery row; `cron_kind` is `run` or `thread`; `replyable` is true only for a thread whose seed is live and keyed. A `source: topoi` session with no delivery row is an app-minted chat and carries none of them, which is what keeps the New thread flow opening in the composer. A finished run that answered with core's silence sentinel (`[SILENT]`, `NO_REPLY`) is dropped from the listing entirely: it produced no result to read. The drop runs in the same pass as the withholding rule, before pagination, so `total` stays honest; an open run is never dropped, and a run that delivered anything is never silent. Archived, hidden and machinery-source sessions (`kanban`, `tool`) are excluded, mirroring the dashboard's own listing. Query params: `topic` (filter to one), `limit` (1-500, default 200), `offset`, `profile` (defaults to this process's own store). The live-topic filter runs before pagination, so `total` is the filtered count and `offset` walks the filtered rows: a match sitting past the first page is still reachable.

### 3.4 `POST /threads/bind`

`POST /threads/bind` with `{session_id, topic_id}` files one session under a topic - the desktop half's New thread flow, which files the chat the app mints once its row exists. The session id is resolved to its lineage root first, so filing a live id survives compression. It answers 404 when the session does not exist, 422 when the topic is not a live registry entry or the session_id is missing (a request failing both checks gets the 404, so a client can tell a deleted thread from a deleted topic), and 409 when the body files a thread that already sits under another topic without `move: true`. The path also sweeps bindings whose session no longer exists, once the store is past a small threshold.

Re-filing a session that already sits under another topic needs `{session_id, topic_id, move: true}`, which is what the desktop row menu's Move to topic sends. Both shapes upsert by lineage root; the flag only decides whether that upsert may change a topic that already exists. Without it the answer is 409, so a stale new-thread arm cannot re-topic a thread it mistook for its own.

### 3.5 `DELETE /threads/{session_id}`

`DELETE /threads/{session_id}` deletes one thread. The row, its compression chain and its on-disk transcripts go through the core's own session delete - the same handler the desktop's own delete rides - so an already-absent session is a no-op success and a session under an active turn is a 409. The thread's binding is resolved from its lineage root before the row goes and dropped in the same call, so a deleted thread never leaves a binding behind.

### 3.6 Broadcasts

Every registry write broadcasts `plugin.topoi.topics.changed`. Bindings need no broadcast: resolution is server-side on every `GET /threads`, so a binding is visible to every client the moment it lands. The thread list needs no plugin-side push either: a client refetches on the gateway's own `sessions.changed` event.

### 3.7 The dashboard client

The dashboard extension (`dashboard/manifest.json` + `dashboard/dist/index.js`) is the web-dashboard client of this surface: the registry CRUD at `/topics`, and a compact topic overview injected into the Sessions page through the `sessions:top` slot. The dashboard shell renders plugin tabs in a separate Plugins section at the end of the sidebar, so `tab.position: after:sessions` orders the Topics tab first among the plugin tabs rather than literally after the built-in Sessions tab. The tab's Recent Threads card lists only threads filed under a live topic, caps each topic group at `RECENT_PER_TOPIC` (4), and its heading total counts exactly those threads. A thread whose `topic_id` names a topic that is no longer a live entry is therefore not listed there at all, and its binding is not resurrected by anything.

### 3.8 `GET /threads/{session_id}/cron`

One cron result as a document, for a client that renders it instead of opening a chat. The path is `/cron` because the run is the core component and a briefing is one kind of run.

- `kind: thread` - a mirrored run thread. `markdown` is the seed's first user turn with core's delivery label stripped; the transcript long-form is the brief itself.
- `kind: run` - a scheduled run with no mirror. `markdown` is its final assistant text, read from the transcript (never the `cron/output` copy, which delivery may have truncated).
- `replyable` / `reply_session_id` - true only for a mirrored thread whose seed is live, unarchived and keyed; then the id is that seed. A run row is never replyable, so the button cannot open a chat that would refuse the message.
- `title` is the job's name and `job_id` comes from the delivery log.

404 when the session does not exist, 422 when it is not a cron result. A reader left open on a thread deleted under it degrades: the next fetch answers 404 and the client shows a gone state rather than a chat.

## 4. Delivery contract

### 4.1 Target syntax

`deliver=topoi` targets the home topic. `deliver=topoi:<topic>[:<thread>]` addresses one explicitly: a topic id, optionally with one of the adapter's thread ids. The parser accepts only those shapes; anything else declines so core resolution continues instead of guessing. The validator accepts a topic only when it is a live registry entry, so `deliver=topoi:t_typo` fails with a reason instead of delivering into a topic no client shows.

### 4.2 Continuable runs

For a continuable job (per-job `attach_to_session: true`, or global `cron.mirror_delivery: true`) with a live gateway and the platform enabled, core mints a thread via `create_handoff_thread`, seeds the topic-keyed session, delivers the output through `send()`, and mirrors the brief into the seeded session as a labelled user turn. Replies continue in the same session.

### 4.3 Standalone runs

The standalone path (`hermes cron run` with no live adapters) rides `standalone_sender_fn`: nothing is pushed anywhere, and the run is reconstructible from the cron run session plus the job's deliver config. Thread opening and seeding are skipped by design.

### 4.4 Preflight

Cron preflight requires the target platform to be known and to have gateway credentials configured; a home topic (stored, configured, or from the environment) satisfies that for `topoi`.

## 5. Events

`broadcast_plugin_event("topoi", "topics.changed", {...})` on every registry write. The wire name is `plugin.topoi.topics.changed`. It reaches desktop windows only when the emitting code runs in the `hermes serve` backend process; from the messaging gateway it is a logged no-op. The `sessions.changed` gateway event is the reliable trigger for thread-list refreshes either way.

## 6. Desktop half install

### 6.1 Same machine as the gateway

Desktop plugins are app-level: one root per machine, `$HERMES_HOME/desktop-plugins/`. When a unified package like this one lands in a local plugins root, the app copies its `desktop/plugin.js` there and refreshes the copy when the source file changes (mtime rule, via Rescan or a restart). The copy is what loads and hot-reloads. The desktop half is enabled by default and can be toggled in Capabilities to Plugins.

### 6.2 Remote backend

Against a remote backend (the gateway on another machine), the backend's `~/.hermes/plugins` is not reachable as a filesystem. Install the package on the backend machine for the gateway side, and on the app machine via Install from Git with the Desktop target, or by cloning the desktop half separately into `desktop-plugins/`. The gateway side stays off until `platforms.topoi.enabled` is set.
