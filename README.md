# Topoi - groups your Hermes Agent chats into topics

It is a plugin that extends the gateway, desktop app, and web dashboard, working inside your normal Hermes setup. Every chat is easy to find and organized by topic in the desktop app. Cron job results arrive as topic threads you can reply to.

- **On the gateway:** it keeps the list of topics and puts each chat under one.
- **In Hermes Desktop:** it adds a Topics pane to the sidebar.
- **In web dashboard:** it adds a Topics management tab.

## Install

1. Open the plugins page in Hermes Desktop: `Capabilities` > `Plugins`
2. Click `Install from Git` and enter `https://github.com/AlaisterLeung/topoi`.
3. Enable the plugin for both Desktop and Agent.
4. Restart gateway.
5. Start chatting by creating topics and chatting in new threads!

## Project Architecture

| Path                      | What                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `adapter.py`              | platform adapter for message deliveries                         |
| `topic_store.py`          | topic registry in `config.yaml`                                 |
| `bindings.py`             | session-to-topic index in a plugin SQLite database              |
| `dashboard/plugin_api.py` | REST API endpoint at `/api/plugins/topoi/`                      |
| `dashboard/dist/index.js` | dashboard bundle: topics tab and overview card in Sessions page |
| `desktop/plugin.js`       | Hermes Desktop plugin script                                    |
| `tests/`                  | Python check scripts                                            |

See `CONTRACT.md` for the REST API and delivery contract. `AGENTS.md` is included for agentic development.
