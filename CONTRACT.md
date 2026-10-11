# Topoi contract

This document is the contract between the gateway side of this package and every client of it: the identifiers it uses, the configuration keys it owns, the REST surface it serves, the cron delivery contract, the events it emits, and how the desktop half is installed. This repo holds the canonical copy; a client that speaks the surface should vendor a pinned copy of this file alongside its code.

There is no inbound transport and no protocol of our own. The gateway side is a delivery namespace: cron results and framework notices land in topic-keyed sessions, and a continuable run gets a fresh reply-able thread. On top of that, the gateway side serves the topic registry and topic-grouped session listings over REST. The desktop half (the Hermes Desktop plugin at `desktop/plugin.js`) is the primary client and the dashboard extension is a second one, but anything that can reach `/api/plugins/topoi/` can read and write the same state.

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

`home_channel` is the only configured-home key: it seeds the home when no registry is stored yet, and the registry rewrites it whenever `home_id` moves, so the delivery home a bare `deliver=topoi` targets never drifts from the home the app shows.

A registry write moves both keys (`topics.home_id`, `home_channel`) in the same read-modify-write, so a fresh process and a fresh `load_gateway_config()` always see the moved home. The in-process views are synced by the same write path: `TopoiAdapter.sync_live_home()` repoints the runner's `PlatformConfig.home_channel` (framework notices and the system prompt's delivery list), which is a startup snapshot that never reloads mid-process. Cron needs no help there: it resolves through a fresh config load on every delivery.

Because `home_channel` is the only thing that feeds the typed projection, a config that lost the key (hand edit, or one never written) would silently break `deliver=topoi` — the platform still looks connected, since the registry alone satisfies `is_connected`, and nothing raises. The adapter's `connect()` therefore calls `repair_home_projection()`, which rewrites the projection from the stored registry when it is missing or stale; a healthy config costs one cached read and no write.

### 2.1 The registry block

The registry block is the only home for topic state: topics are low-churn (a rename, an archive, a reorder), and a config block survives both the gateway and its clients. `updated_at` is stamped server-side on every write and nudged to stay strictly increasing, so a stalled clock can never make a newer registry look older.

### 2.2 Bindings

Session-to-topic bindings do NOT live in the config block. They are high-churn, session-scoped and unbounded, so they live in a plugin-private SQLite store at `<hermes home>/plugin-data/topoi/bindings.db`, and clients never see the map: the REST layer resolves a thread's topic server-side on every `GET /threads`. A binding maps a session's lineage root (the durable id that survives compression) to a topic. A session the adapter itself minted (one with `source: topoi`) carries its topic in `chat_id` and never consults the store. The only write path is `POST /threads/bind`, when a client files a freshly created chat under a topic; there is no unfile operation, so a thread's topic is fixed once it is filed. Deleting a topic prunes its bindings in the same registry write, and bindings to sessions that no longer exist are swept opportunistically on the bind path. A legacy config-level `bindings` block (left by an earlier build) is ignored on read, adopted into the store once on the first `GET /topics`, and dropped by the next registry write.

An older block may still use the retired `items` / `revision` spellings; they are ignored, never half-read.

## 3. REST surface

All routes mount under `/api/plugins/topoi/`, behind the dashboard's normal auth gate. The Python half is imported only when the plugin is in `plugins.enabled`; routes of a disabled plugin are rejected at request time.

### 3.1 `GET /topics`

`GET /topics` returns the registry: `updated_at`, `home_id`, and `entries` in order. Bindings are server-side only and are never shipped as a map. Deleted topics are not tracked anywhere: only a topic with no threads can be deleted (both clients offer delete only for a 0-thread topic), so there is no tombstone list, a leftover `deleted` key in the block is ignored on read, and the next registry write drops it from the file.

### 3.2 `PUT /topics`

`PUT /topics` stores a client-sent registry whole, last writer wins, and returns what was stored, stamped. A structural refusal (a bad id shape, a repeated id, a non-object state, an over-cap list) is a 422 carrying the reason, and the stored block is left untouched. A blank or over-long name is cleaned rather than refused.

### 3.3 `GET /threads`

`GET /threads` lists sessions resolved to topics, newest activity first, and only those filed under a live topic: an untagged session never appears, and neither does a thread whose topic is no longer a live entry (a deleted topic, including a `source: topoi` session whose delivery topic is gone). `topic_id` is therefore never null. Each row carries:

- `session_id` - the live chain tip a client opens
- `lineage_root` - the durable id bindings key on
- `topic_id` - a live registry entry
- `title`, `started_at`, `last_active`, `message_count`, `source`

A `source: topoi` session resolves its topic from `chat_id` (the adapter mints those for cron deliveries) and never consults the binding store; every other session resolves through the store, keyed by lineage root. Archived, hidden and machinery-source sessions (`kanban`, `tool`) are excluded, mirroring the dashboard's own listing. Query params: `topic` (filter to one), `limit` (1-500, default 200), `offset`, `profile` (defaults to this process's own store). The live-topic filter runs before pagination, so `total` is the filtered count and `offset` walks the filtered rows: a match sitting past the first page is still reachable.

### 3.4 `POST /threads/bind`

`POST /threads/bind` with `{session_id, topic_id}` files one session under a topic - the desktop half's New thread flow, which files the chat the app mints once its row exists. The session id is resolved to its lineage root first, so filing a live id survives compression. It answers 404 when the session does not exist and 422 when the topic is not a live registry entry or the session_id is missing (a request failing both checks gets the 404, so a client can tell a deleted thread from a deleted topic). The path also sweeps bindings whose session no longer exists, once the store is past a small threshold.

### 3.5 `DELETE /threads/{session_id}`

`DELETE /threads/{session_id}` deletes one thread. The row, its compression chain and its on-disk transcripts go through the core's own session delete - the same handler the desktop's own delete rides - so an already-absent session is a no-op success and a session under an active turn is a 409. The thread's binding is resolved from its lineage root before the row goes and dropped in the same call, so a deleted thread never leaves a binding behind.

### 3.6 Broadcasts

Every registry write broadcasts `plugin.topoi.topics.changed`. Bindings need no broadcast: resolution is server-side on every `GET /threads`, so a binding is visible to every client the moment it lands. The thread list needs no plugin-side push either: a client refetches on the gateway's own `sessions.changed` event.

### 3.7 The dashboard client

The dashboard extension (`dashboard/manifest.json` + `dashboard/dist/index.js`) is the web-dashboard client of this surface: the registry CRUD at `/topics`, and a compact topic overview injected into the Sessions page through the `sessions:top` slot. The dashboard shell renders plugin tabs in a separate Plugins section at the end of the sidebar, so `tab.position: after:sessions` orders the Topics tab first among the plugin tabs rather than literally after the built-in Sessions tab. The tab's Recent Threads card lists only threads filed under a live topic, caps each topic group at `RECENT_PER_TOPIC` (4), and its heading total counts exactly those threads; a thread whose `topic_id` names a topic that is no longer a live entry is therefore not listed there at all, and its binding is not resurrected by anything.

## 4. Delivery contract

### 4.1 Target syntax

`deliver=topoi` targets the home topic. `deliver=topoi:<topic>[:<thread>]` addresses one explicitly: a topic id, optionally with one of the adapter's thread ids. The parser accepts only those shapes; anything else declines so core resolution continues instead of guessing. The validator accepts a topic only when it is a live registry entry, so `deliver=topoi:t_typo` fails with a reason instead of delivering into a topic no client shows.

### 4.2 Continuable runs

A continuable job (per-job `attach_to_session: true`, or global `cron.mirror_delivery: true`) with a live gateway and the platform enabled: core mints a thread via `create_handoff_thread`, seeds the topic-keyed session, delivers the output through `send()`, and mirrors the brief into the seeded session as a labelled user turn. Replies continue in the same session.

### 4.3 Standalone runs

The standalone path (`hermes cron run` with no live adapters) rides `standalone_sender_fn`: nothing is pushed anywhere, and the run is reconstructible from the cron run session plus the job's deliver config. Thread opening and seeding are skipped by design.

### 4.4 Preflight

Cron preflight requires the target platform to be known and to have gateway credentials configured; a home topic (stored, configured, or from the environment) satisfies that for `topoi`.

## 5. Events

`broadcast_plugin_event("topoi", "topics.changed", {...})` on every registry write. The wire name is `plugin.topoi.topics.changed`. It reaches desktop windows only when the emitting code runs in the `hermes serve` backend process; from the messaging gateway it is a logged no-op. The `sessions.changed` gateway event is the reliable trigger for thread-list refreshes either way.

## 6. Desktop half install

### 6.1 Same machine as the gateway

Desktop plugins are app-level: one root per machine, `$HERMES_HOME/desktop-plugins/`. When a unified package like this one lands in a local plugins root, the app copies its `desktop/plugin.js` there, refreshed when the source file changes (mtime rule, via Rescan or a restart; the copy is what loads and hot-reloads). The desktop half is enabled by default and can be toggled in Capabilities to Plugins.

### 6.2 Remote backend

Against a remote backend (the gateway on another machine), the backend's `~/.hermes/plugins` is not reachable as a filesystem: install the package on the backend machine for the gateway side, and on the app machine via Install from Git with the Desktop target, or by cloning the desktop half separately into `desktop-plugins/`. The gateway side stays off until `platforms.topoi.enabled` is set.
