# Topoi.

Hermes Agent chats, organized under topics you define: a conversation from three weeks ago takes one click to find instead of one long scroll. Cron job results arrive as a topic thread you can reply to.

## What you get

- **Topics** - create, rename, reorder and archive topics in Desktop settings or in the Dashboard's Topics tab.
- **A sidebar of threads** - the topics active in the past week, each thread carrying a dot for working, waiting on you, unread or idle.
- **Organization** - a new chat files under your home topic, and an existing session can be added to a topic or moved to another one.
- **Search** - find a thread by message content from its topic tab.
- **Read state** - threads you have not opened stay marked, and a topic section can be marked as read in one click.
- **Cron results as threads** - a job delivers into a topic instead of a separate chat platform, and your reply continues that run's session context.
- **One registry for every client** - the gateway owns the topic list, so an edit made in the Dashboard reaches Desktop over REST.
- **Mobile** - the [Topoi mobile app](https://github.com/AlaisterLeung/topoi-mobile) is a separate client for this plugin.

## Requirements

Hermes Agent and Desktop `>=0.23.0`

## Install

Install with CLI:

```bash
hermes plugins install AlaisterLeung/topoi
```

Or with Hermes Desktop: **Capabilities → Plugins → Install from Git** → `https://github.com/AlaisterLeung/topoi`, then enable it for **both Desktop and Agent**.

Platform adapters are imported once, at gateway start. There is no hot reload, so a restart is required:

```bash
hermes gateway restart
```

Restart the Dashboard service as well if its plugin list should pick the change up.

To update, run `hermes plugins update topoi`.

## Configure

The registry lives under `platforms.topoi` in `config.yaml`. The gateway owns it and the UI normally writes it for you; edit it by hand only when you mean to.

| Key | Default | Meaning |
| --- | --- | --- |
| `topics.entries` | one topic, `t_general` named General | The registry: `id`, `name`, and an optional `archived`. Ids match `t_[a-z0-9_]+`. |
| `topics.home_id` | `t_general` | The home topic: where a new chat files, and the default cron delivery target. |
| `topics.updated_at` | written by the plugin | Epoch milliseconds of the last write, kept strictly increasing. |

Moving the home topic also rewrites the framework's `home_channel` projection, so a `deliver=topoi` cron job never targets a topic the UI has stopped showing as home.

`enabled` is set by `hermes plugins enable topoi`. Do not hand-edit it.

## Usage

Create a topic, then start a chat: it files under your home topic. Open a topic to see its threads, search inside one, or move a thread somewhere else. When a cron job delivers, its thread appears in the target topic, and replying there continues that run's session.

Nothing new to learn. The plugin gives the sidebar and the Topics tab their behaviour, and you keep chatting the way you already do.

## How it works

```
Hermes Desktop ─┐
                ├─► REST /api/plugins/topoi/ ─► dashboard/plugin_api.py
Web Dashboard ──┘

dashboard/plugin_api.py ─┬─► topics   ─► config.yaml (platforms.topoi.topics)
                         └─► bindings ─► plugin SQLite store

Gateway ─► topoi platform adapter ─► cron results and deliveries ─► topic thread
```

The gateway owns one copy of the registry. Both clients read and write it over REST, and a write broadcasts `plugin.topoi.topics.changed` so the other client re-reads instead of guessing. Bindings are high-churn and unbounded, so they live in a plugin-private SQLite store rather than in `config.yaml`.

| Path | What |
| --- | --- |
| `adapter.py` | gateway platform adapter: deliveries, the home-topic projection, standalone sends for gateway-less runs |
| `topic_store.py` | the topic registry in `config.yaml`, and the `home_channel` repair |
| `bindings.py` | session-to-topic index in the plugin SQLite store |
| `dashboard/manifest.json` | the Dashboard extension manifest: tab, slot, entry, API |
| `dashboard/plugin_api.py` | the REST API at `/api/plugins/topoi/` |
| `dashboard/dist/index.js` | dashboard bundle: the Topics tab and the Sessions overview card |
| `desktop/plugin.js` | the Hermes Desktop half: sidebar, topic tabs, settings pages |
| `skills/cron-delivery/` | the bundled `topoi:cron-delivery` skill |
| `tests/` | Python check scripts, see Development |

## What Topoi does on your computer

A plugin runs with the agent's authority. This is all of it.

- **Writes** into `config.yaml`: the `platforms.topoi.topics` registry, and the framework's `home_channel` projection derived from it.
- **Keeps** session-to-topic bindings in a plugin-private SQLite database under the plugin's own data directory.
- **Reads** Hermes' per-profile session databases and the cron job store to list threads, their status and their cron results. Most of that goes through documented store APIs; a few reads reach Hermes internals that can move between releases, which is why `requires_hermes` has a floor.
- **Serves** an HTTP API at `/api/plugins/topoi/` through the plugin host, on the Dashboard's own origin and auth.
- **Registers** an in-process gateway platform adapter, which runs on the gateway's event loop with the gateway's authority.
- **Bundles** one skill, `topoi:cron-delivery`, so an agent that schedules a job knows how to land it in a topic.
- **Makes** no third-party network calls, stores no credentials, and reports no telemetry.

## Limitations

- One registry per gateway. Two gateways do not sync with each other.
- The registry lives in `config.yaml`, which is right for a topic list and wrong for thousands of topics.
- Only an empty topic can be deleted, otherwise it is archived.

## Troubleshooting

- **No topoi lines in the gateway log, or cron delivers to the wrong place.** Run `hermes plugins doctor topoi`, then `hermes gateway restart`. Adapters load at startup only.
- **The Topics tab is missing in the Dashboard.** Restart the Dashboard service. It holds its own plugin discovery, separate from the gateway's.
- **The plugin is listed but there is no sidebar.** The Desktop half is not loaded. Reload desktop plugins from the app.
- **A home-topic change did not stick.** The `home_channel` projection is repaired on the next gateway start.

## Development

The checks run against a throwaway `HERMES_HOME` and need no live gateway:

```bash
~/.hermes/hermes-agent/venv/bin/python tests/check_topic_store.py
~/.hermes/hermes-agent/venv/bin/python tests/check_bindings.py
~/.hermes/hermes-agent/venv/bin/python tests/check_adapter.py
~/.hermes/hermes-agent/venv/bin/python tests/check_backend.py
~/.hermes/hermes-agent/venv/bin/python tests/check_cron_thread.py
~/.hermes/hermes-agent/venv/bin/python tests/check_dashboard_bundle.py
```

On an install that owes a `hermes update`, the launcher re-runs these on the managed runtime with `-I`, which drops the venv's site-packages and fails at `import yaml`. Prefix `HERMES_DISABLE_LAZY_INSTALLS=1` to skip that relaunch.

Validate the package the way catalog CI does. Pass an absolute path and run it from outside the plugin directory, or the capability probe imports your own modules first and fails with a relative-import error that is not your bug:

```bash
cd /tmp && hermes plugins validate /absolute/path/to/topoi --install-deps
```

After a Hermes upgrade, re-run that gate and re-check the core seams the REST layer reads at the new tag. That is what the `requires_hermes` floor exists for.

`CONTRACT.md` is the REST and delivery contract. `AGENTS.md` is for agentic development.

## License

MIT, see `LICENSE`.
