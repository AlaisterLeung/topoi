# Topoi. - groups your Hermes Agent chats into topics

Topoi groups every Hermes Agent chat under topics you defined in Hermes Desktop, so your conversations are easy to find again.

## Features

- **Sessions** - Group and organize your chat sessions by topic as threads
- **Sidebar** - View recently active threads from the past week, and click the topic to see all
- **Status dots** - A dot next to each thread indicating whether it's working, waiting on you, unread, or idle
- **New chat** - Start one from the sidebar or the tab strip, and it files under your home topic (default: General)
- **Search** - Find threads by message content from the topic tab
- **Cron job display** - Deliver cron job results to topics without a separate messaging platform
- **Reply to cron jobs** - Reply directly to threads created by the cron jobs with continuable session context
- **Topics** - Create and manage topics in both Desktop settings and Web Dashboard
- **Organization** - Add existing sessions to a topic and move threads to a different one
- **Mobile app** - Continue your chats on the go with [Topoi mobile app](https://github.com/AlaisterLeung/topoi-mobile)

## Install

1. Open the plugins page in Hermes Desktop: `Capabilities` > `Plugins`
2. Click `Install from Git` and enter `https://github.com/AlaisterLeung/topoi`.
3. Enable the plugin for both Desktop and Agent.
4. Restart gateway.
5. Start chatting by creating topics and chatting in new threads!

## Upgrading

1. Open the plugins page in Hermes Desktop: `Capabilities` > `Plugins`
2. Click the `Update` button for Topoi.

**If your Hermes Desktop connects to a remote gateway,** it only upgrades the gateway side. On the computer running Hermes Desktop, download the desktop-side update yourself, then reload (`Ctrl+K` / `⌘ K` → `Reload desktop plugins`) or restart the app.

```bash
mkdir -p ~/.hermes/plugins/topoi/desktop
curl -fsSL https://raw.githubusercontent.com/AlaisterLeung/topoi/main/desktop/plugin.js \
    -o ~/.hermes/plugins/topoi/desktop/plugin.js
```

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
