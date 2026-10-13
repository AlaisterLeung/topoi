// Topoi desktop half: a topics tree pane whose thread rows carry the app's
// own session statuses, a topic tab that lists one topic's threads (each
// with a delete action), and the Topics settings page. Talks to the plugin's
// own REST namespace (/api/plugins/topoi) through ctx.rest and opens threads
// through Hermes' native chat (host.openSession), so the conversation
// surface stays core's.
//
// A New thread click files the chat the app mints under its topic: the bind
// waits out the session row's lazy write and only ever files a chat that did
// not exist when the arm was set, and the topic tab's Add to topic action
// files an existing chat that flow missed. The row menu's Move to topic
// re-files a thread under another topic, the same bind with a new target.
//
// Disk plugin: plain ESM, no build, no JSX (jsx() calls only), and the import
// allowlist is @hermes/plugin-sdk / react / react/jsx-runtime.

import {
  atom,
  Badge,
  Button,
  Codicon,
  COMPOSER_AREAS,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DisclosureCaret,
  EmptyState,
  host,
  Input,
  PANES_AREA,
  ScrollArea,
  queryClient,
  coarseElapsed,
  useQuery,
  useQueryClient,
  useValue,
} from "@hermes/plugin-sdk";
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

// Threads a topic section shows when expanded, and one page of a topic tab
// (its Load more button appends the next page of the same size).
const PANE_THREADS = 4;
const PAGE_SIZE = 10;
// A New thread click arms a filing that waits for the chat to mint its
// session: the app writes the session row on the first prompt, never on the
// click, so the bind retries for as long as the arm lives, and the arm
// expires with this window. Generous because the misfire guard below makes
// a long window safe: a chat that already existed when the arm was set can
// never be filed by it, so waiting costs nothing.
const NEW_THREAD_WINDOW_MS = 15 * 60 * 1000;
const BIND_RETRY_MS = 700;

// Disk plugins are not Tailwind-scanned, so the tree's own layout lives here;
// the SDK components (Button, Badge, ScrollArea, Input) own their chrome.
const CSS = `
.topoi-tree{display:flex;flex-direction:column;height:100%;min-height:0;padding-top:6px}
.topoi-scroll{flex:1;min-height:0}
.topoi-arm{display:flex;align-items:center;gap:6px;margin:0 0 4px;padding:2px 8px;font-size:0.6875rem;color:var(--ui-text-tertiary)}
.topoi-arm-dot{flex-shrink:0;width:5px;height:5px;border-radius:50%;background:var(--ui-accent)}
.topoi-arm-topic{font-weight:600;color:var(--ui-text-secondary)}
.topoi-section{padding:2px 0 6px}
.topoi-section-head{display:flex;align-items:center;gap:1px;padding:2px 8px 2px 4px}
.topoi-chevron{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:20px;height:24px;padding:0;border:0;border-radius:4px;background:none;color:var(--ui-text-quaternary);cursor:pointer;opacity:0;transition:opacity 120ms ease}
.topoi-chevron:hover{background:var(--chrome-action-hover);color:var(--ui-text-secondary)}
.topoi-section-head:hover .topoi-chevron{opacity:1}
.topoi-chevron:focus-visible{opacity:1}
.topoi-topic{display:flex;flex:1;min-width:0;margin-left:4px;align-items:center;gap:6px;height:24px;padding:0 4px;border:0;border-radius:4px;background:none;color:var(--ui-text-secondary);cursor:pointer;text-align:left}
.topoi-topic:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.topoi-topic-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.6875rem;font-weight:600}
.topoi-section-add{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:20px;height:24px;padding:0;border:0;border-radius:4px;background:none;color:var(--ui-text-tertiary);cursor:pointer;opacity:0;transition:opacity 120ms ease}
.topoi-section-add:hover{background:var(--chrome-action-hover);color:var(--ui-text-secondary)}
.topoi-section-head:hover .topoi-section-add{opacity:1}
.topoi-section-add:focus-visible{opacity:1}
.topoi-home-dot{width:5px;height:5px;border-radius:50%;background:var(--ui-accent);flex-shrink:0}
.topoi-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px;padding:0 4px 0 8px}
.topoi-row-main{display:flex;min-width:0;align-items:center;gap:6px;height:26px;padding:0 4px;text-align:left;border:0;border-radius:4px;background:none;color:var(--ui-text-primary);cursor:pointer}
.topoi-row-main:hover{background:var(--chrome-action-hover)}
.topoi-row-main.topoi-open,.topoi-row-main.topoi-open:hover{background:var(--ui-row-active-background)}
.topoi-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem}
.topoi-row-time{flex-shrink:0;font-size:0.625rem;color:var(--ui-text-quaternary)}
.topoi-dot{flex-shrink:0;box-sizing:border-box;width:6px;height:6px;border-radius:9999px}
.topoi-dot-working{background:var(--ui-accent)}
.topoi-dot-stalled{border:1px solid var(--ui-accent)}
.topoi-dot-unread{background:var(--ui-success)}
.topoi-dot-attention{background:var(--color-amber-500)}
.topoi-dot-background{border:1px solid var(--ui-text-tertiary)}
.topoi-row-menu{padding:0 2px}
.topoi-more{display:flex;align-items:center;height:24px;margin:0 8px;padding:0 4px;border:0;border-radius:4px;background:none;color:var(--ui-text-quaternary);font-size:0.6875rem;cursor:pointer}
.topoi-more:hover{background:var(--chrome-action-hover);color:var(--ui-text-secondary)}
.topoi-note{padding:4px 10px 8px;font-size:0.6875rem;line-height:1.5;color:var(--ui-text-quaternary)}
.topoi-problem{font-size:0.6875rem;line-height:1.5;color:var(--color-red-400)}
.topoi-tab{display:flex;flex-direction:column;height:100%;min-height:0}
.topoi-tab-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
.topoi-tab-titles{display:flex;min-width:0;flex-direction:column;gap:2px}
.topoi-tab-title{display:flex;align-items:center;gap:6px;font-size:0.875rem;font-weight:600;color:var(--ui-text-primary)}
.topoi-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topoi-tab-meta{font-size:0.6875rem;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
.topoi-tab-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.topoi-tab-body{flex:1;min-height:0}
.topoi-load-more{display:flex;justify-content:center;padding:6px 0 10px}
.topoi-picker{display:flex;flex-direction:column;gap:2px;padding:4px 8px}
.topoi-picker-filter{margin-bottom:4px}
.topoi-pick{display:flex;min-width:0;align-items:center;gap:8px;width:100%;height:26px;padding:0 4px;text-align:left;border:0;border-radius:4px;background:none;color:var(--ui-text-primary);font:inherit;cursor:pointer}
.topoi-pick:hover{background:var(--chrome-action-hover)}
.topoi-pick-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem}
/* The Add to topic toggle's active state: the ghost button keeps the hover
   treatment while the picker is open, so the mode reads without a second
   look. */
.topoi-add-active{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
/* The Button's default fill is bg-primary + text-primary-foreground, and a
   skin's primaryForeground does not always contrast its primary (catppuccin
   paints a light mauve primary with white ink, ~1.8:1). The theme's
   mode-flipped chrome ink is the honest label colour here: near-black on the
   light fills dark skins use, near-white on the deep fills light skins use. */
.topoi-new-thread{color:var(--theme-neutral-chrome)}
.topoi-settings{display:flex;flex-direction:column;gap:10px;padding:2px 0 8px}
.topoi-add{display:flex;gap:6px}
.topoi-add-input{flex:1;min-width:0}
.topoi-edit{display:flex;align-items:center;gap:6px}
.topoi-edit-name{flex:1;min-width:0}
.topoi-edit-actions{display:flex;align-items:center;gap:2px}
`;

// Bound at register; null after unload/disable. Components read them per call.
let rest = null;
let storage = null;

// The topic tabs this plugin has open, keyed by topic id: closed on unload.
const topicTabs = new Map();
// The armed New thread filing, if any: the topic to file under plus the chat
// id that was focused when the click happened (never the one we want). An
// atom so the composer banner re-renders when the arm changes.
const $pendingThread = atom(null);

const TOPICS_KEY = (scope) => ["topoi", "topics", scope];
const THREADS_KEY = (scope) => ["topoi", "threads", scope];
const TOPIC_PAGE_KEY = (scope, topicId, limit) => ["topoi", "topic", scope, topicId, limit];

// Queries are scoped by the active connection so a backend switch is a clean
// cache miss (the kanban roster pattern).
function useScope() {
  return useValue(host.state.connectionId) ?? "local";
}

const fetchTopics = () => rest("/topics");
const fetchThreads = () => rest("/threads");
// One topic's threads, newest first: `total` is the topic's whole count, so a
// Load more button knows whether a next page exists.
const fetchTopicPage = (topicId, limit) =>
  rest(`/threads?topic=${encodeURIComponent(topicId)}&limit=${limit}&offset=0`);
const putTopics = (state) => rest("/topics", { method: "PUT", body: state });
const bindThread = (sessionId, topicId) =>
  rest("/threads/bind", { method: "POST", body: { session_id: sessionId, topic_id: topicId } });
const deleteThread = (sessionId) =>
  rest(`/threads/${encodeURIComponent(sessionId)}`, { method: "DELETE" });

// The row's open door: a new tab / window / main on intent (the same
// vocabulary middle-click and the session menu use). The sidebar pane always
// passes "tab", so a row click never replaces the chat already open.
const openThread = (sessionId, intent) =>
  host
    .openSession(sessionId, intent ? { intent } : {})
    .catch((error) => host.notifyError(error, "Could not open the thread"));

// Opening a thread from its TOPIC TAB replaces the tab: the session opens as
// a tab in the same strip and the topic tab closes, so the workspace never
// carries both the list and the chat. A failed open leaves the tab standing
// rather than costing the listing.
async function openThreadFromTopicTab(sessionId, topicId) {
  try {
    await host.openSession(sessionId, { intent: "tab" });
    topicTabs.get(topicId)?.();
  } catch (error) {
    host.notifyError(error, "Could not open the thread");
  }
}

// The active connection's profile, for the RPCs that are profile-scoped.
const activeProfile = () => host.state?.profile?.get?.().trim() || "";

const copyThreadId = async (sessionId) => {
  try {
    await navigator.clipboard.writeText(sessionId);
    host.notify({ kind: "success", message: "Session id copied." });
  } catch (error) {
    host.notifyError(error, "Could not copy the session id");
  }
};

// A branch opens beside the original and is filed under the same topic, so it
// shows up in the pane like any other thread of it.
async function branchThread(thread) {
  const profile = activeProfile();
  try {
    const created = await host.request("session.branch_stored", {
      ...(profile ? { profile } : {}),
      parent_session_id: thread.session_id,
    });
    const sessionId = created?.stored_session_id;
    if (!sessionId) {
      throw new Error("The gateway did not return a branch id");
    }
    // A branch copies its parent's transcript, so its row is seeded and the
    // tab can hydrate it; only a branch of a never-sent chat would be lazy.
    await host.openSession(sessionId, { intent: "tab", ...(profile ? { profile } : {}) });
    await fileThread(sessionId, thread.topic_id, "the branch", Date.now());
  } catch (error) {
    host.notifyError(error, "Could not branch the thread");
  }
}

// Archiving drops the row out of the listing (the backend excludes archived
// threads), so the lists refetch once it lands.
async function archiveThread(thread) {
  const profile = activeProfile();
  try {
    await host.request("session.archive", {
      ...(profile ? { profile } : {}),
      archived: true,
      session_id: thread.session_id,
    });
    queryClient.invalidateQueries({ queryKey: ["topoi"] });
  } catch (error) {
    host.notifyError(error, "Could not archive the thread");
  }
}

// Moving a thread is the same bind with another topic: the store upserts by
// lineage root, so POST /threads/bind files a new thread and moves one that
// is already filed. The lists refetch once it lands.
async function moveThread(thread, entry) {
  try {
    await bindThread(thread.session_id, entry.id);
    queryClient.invalidateQueries({ queryKey: ["topoi"] });
  } catch (error) {
    host.notifyError(error, `Could not move the thread to ${entry.name ?? entry.id}`);
  }
}

// A topic id the registry will accept: t_[a-z0-9_]+ , unique against the
// existing entries. The t_ prefix is locked into the field: the user types
// the suffix and cannot remove or alter the prefix. The id is set at topic
// creation and never edited afterwards (CONTRACT.md section 1), so the
// settings page asks for it up front instead of minting one.
const ID_PREFIX = "t_";
function topicIdProblem(id, entries) {
  if (!/^t_[a-z0-9_]+$/.test(id)) {
    return "After t_, use lowercase letters, digits and underscores.";
  }
  if (entries.some((entry) => entry.id === id)) {
    return "A topic with that id already exists.";
  }
  return "";
}

// Where home_id goes when the home topic is deleted: the first live entry,
// else the default home id. A removed topic must never stay the home.
function fallbackHome(entries) {
  const live = entries.filter((entry) => !entry.archived);
  const pool = live.length > 0 ? live : entries;
  return pool.length > 0 ? pool[0].id : "t_system";
}

// Threads grouped by topic in registry order. The home topic is marked, not
// pinned: it keeps its registry slot instead of sorting first. The listing
// carries only threads filed under a live topic, so every thread lands in a
// group; one filed under a topic the registry dropped between the two
// fetches has no group and is skipped.
function groupThreads(entries, threads) {
  const groups = (entries ?? []).map((entry) => ({ entry, threads: [] }));
  const byId = new Map(groups.map((group) => [group.entry.id, group]));
  for (const thread of threads) {
    const group = thread.topic_id ? byId.get(thread.topic_id) : null;
    if (group) {
      group.threads.push(thread);
    }
  }
  return groups;
}

// ---- the topic tab -----------------------------------------------------------

// One topic's threads, PAGE_SIZE at a time. The New thread button starts a
// chat the app mints its own way, then files it under this topic.
function TopicView({ topicId }) {
  const scope = useScope();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const topicsQuery = useQuery({
    queryFn: fetchTopics,
    queryKey: TOPICS_KEY(scope),
    staleTime: 30_000,
  });
  const pageQuery = useQuery({
    queryFn: () => fetchTopicPage(topicId, limit),
    queryKey: TOPIC_PAGE_KEY(scope, topicId, limit),
    staleTime: 15_000,
  });

  const entries = topicsQuery.data?.entries ?? [];
  const entry = entries.find((item) => item.id === topicId);
  const name = entry?.name ?? topicId;
  const threads = pageQuery.data?.threads ?? [];
  const total = pageQuery.data?.total ?? threads.length;
  // The recovery door: a chat the New thread flow missed (an expired arm, a
  // bind that lost the row race, a first send after the window) is filed
  // from here by picking it. Only chats not already filed under a topic are
  // offered, and filing one moves it into the list below.
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const unfiledQuery = useQuery({
    enabled: picking,
    queryFn: async () => {
      const profile = activeProfile();
      const [listed, filed] = await Promise.all([
        host.request("session.list", { limit: 500, ...(profile ? { profile } : {}) }),
        fetchThreads(),
      ]);
      const filedIds = new Set();
      for (const row of filed?.threads ?? []) {
        filedIds.add(row.session_id);
        if (row.lineage_root) filedIds.add(row.lineage_root);
      }
      return (listed?.sessions ?? []).filter((row) => row?.id && !filedIds.has(row.id));
    },
    queryKey: ["topoi", "unfiled", scope, topicId],
    staleTime: 10_000,
  });
  const fileExisting = async (sessionId) => {
    try {
      await bindThread(sessionId, topicId);
      queryClient.invalidateQueries({ queryKey: ["topoi"] });
      setPicking(false);
    } catch (error) {
      host.notifyError(error, "Could not file the chat under this topic");
    }
  };
  const needle = filter.trim().toLowerCase();
  const unfiled = (unfiledQuery.data ?? []).filter(
    (row) =>
      !needle ||
      (row.title || "").toLowerCase().includes(needle) ||
      String(row.id).toLowerCase().includes(needle),
  );

  return jsxs("div", {
    className: "topoi-tab",
    children: [
      jsxs("div", {
        className: "topoi-tab-head",
        children: [
          jsxs("div", {
            className: "topoi-tab-titles",
            children: [
              jsxs("div", {
                className: "topoi-tab-title",
                children: [
                  jsx("span", { className: "topoi-tab-name", children: name }),
                  entry?.id === topicsQuery.data?.home_id && jsx(Badge, { children: "Home" }),
                ],
              }),
              jsx("span", {
                className: "topoi-tab-meta",
                children: total === 1 ? "1 thread" : `${total} threads`,
              }),
            ],
          }),
          jsx("div", {
            className: "topoi-tab-actions",
            children: [
              jsxs(Button, {
                className: "topoi-new-thread",
                onClick: () => startNewThread(entry ?? { id: topicId, name }),
                size: "sm",
                children: [jsx(Codicon, { name: "add", size: "0.75rem" }), "New thread"],
              }),
              jsxs(Button, {
                "aria-label": `Add a chat to ${name}`,
                "aria-pressed": picking,
                className: picking ? "topoi-add topoi-add-active" : "topoi-add",
                onClick: () => setPicking((current) => !current),
                size: "sm",
                title: "Add an existing chat to this topic",
                variant: "ghost",
                children: [jsx(Codicon, { name: "tag", size: "0.75rem" }), "Add to topic"],
              }),
            ],
          }),
        ],
      }),
      jsxs(ScrollArea, {
        className: "topoi-tab-body",
        children: [
          picking
            ? jsxs("div", {
                className: "topoi-picker",
                children: [
                  jsx(Input, {
                    className: "topoi-picker-filter",
                    onChange: (event) => setFilter(event.target.value),
                    placeholder: "Filter chats by title",
                    value: filter,
                  }),
                  unfiledQuery.isLoading &&
                    jsx("div", { className: "topoi-note", children: "Loading chats" }),
                  unfiledQuery.error &&
                    jsx("div", {
                      className: "topoi-note",
                      children: "Your chats could not be listed.",
                    }),
                  unfiled.map((row) => {
                    const seconds = row.started_at || 0;
                    const when = seconds ? formatAge(seconds) : null;
                    return jsxs("button", {
                      className: "topoi-pick",
                      key: row.id,
                      onClick: () => fileExisting(row.id),
                      type: "button",
                      children: [
                        jsx("span", {
                          className: "topoi-pick-title",
                          children: row.title || row.id,
                        }),
                        when && jsx("span", { className: "topoi-row-time", children: when }),
                      ],
                    });
                  }),
                  unfiled.length === 0 &&
                    !unfiledQuery.error &&
                    !unfiledQuery.isLoading &&
                    jsx(EmptyState, {
                      description: "Every chat is filed under a topic.",
                      title: "No unfiled chats",
                    }),
                ],
              })
            : [
                threads.map((thread) =>
                  jsx(ThreadRow, {
                    deletable: true,
                    entries,
                    key: thread.lineage_root,
                    onOpen: (sessionId) => openThreadFromTopicTab(sessionId, topicId),
                    showStatus: false,
                    thread,
                  }),
                ),
                pageQuery.error &&
                  jsx("div", {
                    className: "topoi-note",
                    children: "The topoi backend could not be reached.",
                  }),
                !pageQuery.isLoading &&
                  !pageQuery.error &&
                  threads.length === 0 &&
                  jsx(EmptyState, {
                    description: "Threads show up here once a chat is added to this topic.",
                    title: "No threads yet",
                  }),
                threads.length < total &&
                  jsx("div", {
                    className: "topoi-load-more",
                    children: jsx(Button, {
                      onClick: () => setLimit((current) => current + PAGE_SIZE),
                      size: "sm",
                      variant: "ghost",
                      children: "Load more",
                    }),
                  }),
              ],
        ],
      }),
    ],
  });
}

// One tab per topic in the workspace tab strip. A second click re-registers
// the same pane id, which the app refreshes in place and fronts instead of
// stacking a duplicate.
function openTopicTab(entry) {
  if (!entry?.id) return;
  if (typeof host.openWorkspace !== "function") {
    host.notify({ kind: "error", message: "Update Hermes Desktop to open a topic tab." });
    return;
  }
  const close = host.openWorkspace(`topic-${entry.id}`, {
    dock: { pane: "workspace", pos: "center" },
    onClose: () => topicTabs.delete(entry.id),
    render: () => jsx(TopicView, { topicId: entry.id }),
    title: entry.name ?? entry.id,
  });
  topicTabs.set(entry.id, close);
}

// The sessions that already exist, by id. The arm files only a chat that did
// NOT exist when it was set, so a click on another chat inside the window
// cannot be filed instead of the new one. A failed listing leaves the
// snapshot unknown and the arm keeps its old behaviour (file the next
// unseen id) rather than never filing at all.
const knownSessionIds = async () => {
  try {
    const profile = activeProfile();
    const listed = await host.request("session.list", {
      limit: 500,
      ...(profile ? { profile } : {}),
    });
    return new Set((listed?.sessions ?? []).map((row) => row?.id).filter(Boolean));
  } catch {
    return null;
  }
};

// The app mints a session on the first prompt, so the click arms a filing and
// the new stored id that shows up next is the chat to file. Opening the
// fresh session as a tab itself is not possible from a plugin, so the draft
// lands in the main pane - where the ArmBanner above the composer names the
// topic it will be filed under.
function startNewThread(entry) {
  if (typeof host.newChat !== "function") {
    host.notify({ kind: "error", message: "Update Hermes Desktop to start a chat." });
    return;
  }
  const name = entry.name ?? entry.id;
  const at = Date.now();
  $pendingThread.set({
    at,
    known: null,
    seenId: host.state?.focusedStoredSessionId?.get?.() ?? null,
    topicId: entry.id,
    topicName: name,
  });
  // The listing rides the gateway socket and lands within a few hundred
  // milliseconds, long before a send can mint the new chat's id, so the
  // snapshot is in before the watcher can see a focus change.
  void knownSessionIds().then((known) => {
    const pending = $pendingThread.get();
    if (pending && pending.at === at) {
      $pendingThread.set({ ...pending, known });
    }
  });
  host.newChat();
}

// The app writes the session row a moment after the first prompt, so a 404 is
// the row not being there yet rather than a refusal.
const isMissingSession = (error) =>
  error?.statusCode === 404 || /^404\b/.test(String(error?.message ?? ""));

// Files a chat under its topic, waiting out the row write. The row lands
// when the first prompt is processed, which is after the re-home that armed
// this filing, so the first attempts 404 by design; anything else is a real
// refusal and gives up at once. The wait is bounded by the arm's own
// window, so a first message carrying attachments (or a busy backend) still
// files instead of silently staying a regular desktop session.
async function fileThread(sessionId, topicId, topicName, at) {
  const deadline = at + NEW_THREAD_WINDOW_MS;
  for (;;) {
    try {
      await bindThread(sessionId, topicId);
      queryClient.invalidateQueries({ queryKey: ["topoi"] });
      return;
    } catch (error) {
      if (!isMissingSession(error) || Date.now() >= deadline) {
        host.notifyError(error, `Could not file the new thread under ${topicName || "its topic"}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_MS));
    }
  }
}

function watchNewThreads() {
  const focused = host.state?.focusedStoredSessionId;
  if (!focused?.listen) return () => {};
  return focused.listen((sessionId) => {
    const pending = $pendingThread.get();
    if (!pending || !sessionId || sessionId === pending.seenId) return;
    if (Date.now() - pending.at > NEW_THREAD_WINDOW_MS) {
      $pendingThread.set(null);
      return;
    }
    // A chat that already existed when the arm was set is the user visiting
    // another chat, not the new one: it must not consume the arm.
    if (pending.known?.has(sessionId)) return;
    $pendingThread.set(null);
    fileThread(sessionId, pending.topicId, pending.topicName, pending.at);
  });
}

// ---- the pane ----------------------------------------------------------------

// While a New thread click is armed, the composer's top strip names the topic
// the next chat will be filed under: the draft itself (in the main pane)
// carries no such mark. Renders only on the fresh draft (no focused stored
// session), so it never follows the user into an existing chat.
function ArmBanner() {
  const pending = useValue($pendingThread);
  const focused = useValue(host.state.focusedStoredSessionId);
  if (!pending || focused != null) {
    return null;
  }
  return jsxs("div", {
    className: "topoi-arm",
    children: [
      jsx("span", { className: "topoi-arm-dot" }),
      jsx("span", {
        children: [
          "New chat in topic ",
          jsx("b", { className: "topoi-arm-topic", children: pending.topicName }),
        ],
      }),
    ],
  });
}

// The statuses the app's own session surfaces paint, from the one map the
// builtin sidebar's status dot reads (feature-detected: an older host has no
// such atom and the rows simply show no dot).
const EMPTY_STATUSES = atom({});

const DOT_CLASS = {
  background: "topoi-dot topoi-dot-background",
  "needs-input": "topoi-dot topoi-dot-attention",
  stalled: "topoi-dot topoi-dot-stalled",
  unread: "topoi-dot topoi-dot-unread",
  working: "topoi-dot topoi-dot-working",
};

const DOT_LABEL = {
  background: "Running in the background",
  "needs-input": "Waiting for an answer",
  stalled: "Session running",
  unread: "Finished, unread",
  working: "Session running",
};

// The row age, the builtin session row's compact spelling: under a minute
// reads "now", then 5m / 2h / 3d. coarseElapsed owns the buckets (the SDK's
// relativeTime renders "3 days ago", which is for scheduled next-runs, not
// row ages).
const AGE_SUFFIX = { day: "d", hour: "h", minute: "m" };

const formatAge = (seconds) => {
  const { unit, value } = coarseElapsed(Date.now() - seconds * 1000);
  return unit === "second" ? "now" : `${value}${AGE_SUFFIX[unit]}`;
};

// One thread row, shaped like the builtin sidebar's session row: the date
// sits in a column that never shrinks while the title truncates against it.
// The sidebar copy carries the app's session statuses (the open band and the
// status dot); the topic tab keeps the delete action and nothing else.
function ThreadRow({ deletable = false, entries = [], onOpen, showStatus = false, thread }) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const focused = useValue(host.state.focusedStoredSessionId);
  const statuses = useValue(host.state.sessionStatuses ?? EMPTY_STATUSES);
  const title = thread.title || thread.session_id;
  // The REST surface ships epoch SECONDS; the age label buckets them app-side.
  const seconds = thread.last_active || thread.started_at;
  const when = seconds ? formatAge(seconds) : null;
  // A thread carries its live tip (session_id) and its lineage root; the
  // focused id and the status map can hold either, so match both.
  const opened =
    showStatus &&
    focused != null &&
    (thread.session_id === focused || thread.lineage_root === focused);
  const status = showStatus
    ? (statuses[thread.session_id] ?? statuses[thread.lineage_root] ?? "idle")
    : "idle";
  // The move sub's targets: every registry entry but the thread's own topic
  // (moving to the same one is a no-op, so it is not offered).
  const others = entries.filter((item) => item.id !== thread.topic_id);
  const dot = DOT_CLASS[status]
    ? jsx("span", {
        "aria-label": DOT_LABEL[status],
        className: DOT_CLASS[status],
        role: "status",
        title: DOT_LABEL[status],
      })
    : null;
  return jsxs("div", {
    className: "topoi-row",
    children: [
      jsx(ContextMenu, {
        children: [
          jsx(ContextMenuTrigger, {
            asChild: true,
            children: jsxs("button", {
              className: opened ? "topoi-row-main topoi-open" : "topoi-row-main",
              onClick: () => onOpen(thread.session_id),
              type: "button",
              children: [
                dot,
                jsx("span", { className: "topoi-row-title", children: title }),
                when && jsx("span", { className: "topoi-row-time", children: when }),
              ],
            }),
          }),
          jsxs(ContextMenuContent, {
            children: [
              jsx(ContextMenuItem, {
                onSelect: () => openThread(thread.session_id, "tab"),
                children: [jsx(Codicon, { name: "browser", size: "0.875rem" }), "Open in new tab"],
              }),
              jsx(ContextMenuItem, {
                onSelect: () => openThread(thread.session_id, "window"),
                children: [
                  jsx(Codicon, { name: "link-external", size: "0.875rem" }),
                  "Open in new window",
                ],
              }),
              jsx(ContextMenuSeparator, {}),
              jsx(ContextMenuItem, {
                onSelect: () => copyThreadId(thread.session_id),
                children: [jsx(Codicon, { name: "copy", size: "0.875rem" }), "Copy ID"],
              }),
              jsx(ContextMenuItem, {
                onSelect: () => branchThread(thread),
                children: [
                  jsx(Codicon, { name: "repo-forked", size: "0.875rem" }),
                  "Branch from here",
                ],
              }),
              others.length > 0 &&
                jsxs(ContextMenuSub, {
                  children: [
                    jsxs(ContextMenuSubTrigger, {
                      children: [
                        jsx(Codicon, { name: "move", size: "0.875rem" }),
                        "Move to topic",
                      ],
                    }),
                    jsxs(ContextMenuSubContent, {
                      children: others.map((entry) =>
                        jsx(ContextMenuItem, {
                          key: entry.id,
                          onSelect: () => moveThread(thread, entry),
                          children: [
                            jsx(Codicon, { name: "tag", size: "0.875rem" }),
                            entry.name ?? entry.id,
                          ],
                        }),
                      ),
                    }),
                  ],
                }),
              jsx(ContextMenuSeparator, {}),
              jsx(ContextMenuItem, {
                onSelect: () => archiveThread(thread),
                children: [jsx(Codicon, { name: "archive", size: "0.875rem" }), "Archive"],
              }),
              jsx(ContextMenuItem, {
                onSelect: () => setPendingDelete(true),
                variant: "destructive",
                children: [jsx(Codicon, { name: "trash", size: "0.875rem" }), "Delete"],
              }),
            ],
          }),
        ],
      }),
      deletable &&
        jsxs("div", {
          className: "topoi-row-menu",
          onClick: (event) => event.stopPropagation(),
          children: [
            jsx(Button, {
              "aria-label": "Delete thread",
              onClick: () => setPendingDelete(true),
              size: "sm",
              variant: "ghost",
              children: jsx(Codicon, { name: "trash", size: "0.75rem" }),
            }),
          ],
        }),
      pendingDelete &&
        jsx(ConfirmDialog, {
          confirmLabel: "Delete",
          description: "The session and its transcript are deleted. This cannot be undone.",
          destructive: true,
          onClose: () => setPendingDelete(false),
          onConfirm: async () => {
            await deleteThread(thread.session_id);
            queryClient.invalidateQueries({ queryKey: ["topoi"] });
          },
          open: true,
          title: "Delete thread?",
        }),
    ],
  });
}

// A topic's head row: the name opens the topic tab, and the caret plus the +
// (a new chat filed under this topic) sit at the right of the name and
// reveal on hover, the builtin sidebar's section affordance. The label keeps
// the pane's own text colour and case.
function SectionHead({ entry, expanded, homeId, onOpenTopic, onToggle }) {
  return jsxs("div", {
    className: "topoi-section-head",
    children: [
      jsxs("button", {
        className: "topoi-topic",
        onClick: onOpenTopic,
        title: "Open topic",
        type: "button",
        children: [
          entry?.id === homeId && jsx("span", { className: "topoi-home-dot" }),
          jsx("span", { className: "topoi-topic-label", children: entry?.name ?? entry?.id }),
        ],
      }),
      jsx("button", {
        "aria-expanded": expanded,
        "aria-label": expanded ? "Collapse topic" : "Expand topic",
        className: "topoi-chevron",
        onClick: onToggle,
        type: "button",
        children: jsx(DisclosureCaret, { open: expanded, size: "0.75rem" }),
      }),
      jsx("button", {
        "aria-label": `New thread in ${entry?.name ?? entry?.id}`,
        className: "topoi-section-add",
        onClick: () => startNewThread(entry),
        title: "New thread",
        type: "button",
        children: jsx(Codicon, { name: "add", size: "0.75rem" }),
      }),
    ],
  });
}

function TopicSection({ entries, entry, expanded, homeId, onOpenTopic, onToggle, threads }) {
  const shown = threads.slice(0, PANE_THREADS);
  const hidden = threads.length - shown.length;
  return jsxs("div", {
    className: "topoi-section",
    children: [
      jsx(SectionHead, {
        entry,
        expanded,
        homeId,
        onOpenTopic: onOpenTopic ? () => onOpenTopic(entry) : undefined,
        onToggle,
      }),
      expanded &&
        shown.map((thread) =>
          jsx(ThreadRow, {
            entries,
            key: thread.lineage_root,
            onOpen: (sessionId) => openThread(sessionId, "tab"),
            showStatus: true,
            thread,
          }),
        ),
      expanded &&
        onOpenTopic &&
        hidden > 0 &&
        jsx("button", {
          className: "topoi-more",
          onClick: () => onOpenTopic(entry),
          type: "button",
          children: `${hidden} more`,
        }),
      expanded &&
        threads.length === 0 &&
        jsx("div", { className: "topoi-note", children: "No threads yet." }),
    ],
  });
}

function TopicTree() {
  const scope = useScope();
  const topicsQuery = useQuery({
    queryFn: fetchTopics,
    queryKey: TOPICS_KEY(scope),
    staleTime: 30_000,
  });
  const threadsQuery = useQuery({
    queryFn: fetchThreads,
    queryKey: THREADS_KEY(scope),
    staleTime: 30_000,
  });
  // Fold state is a per-machine preference and survives a reload.
  const [expanded, setExpanded] = useState(() => storage?.get("expanded", {}) ?? {});

  if (topicsQuery.error || threadsQuery.error) {
    return jsx(EmptyState, {
      description:
        "The topoi backend could not be reached. Check that the plugin is enabled on the gateway.",
      title: "Topics unavailable",
    });
  }
  if (topicsQuery.isLoading || threadsQuery.isLoading) {
    return jsx(EmptyState, { title: "Loading topics" });
  }

  const entries = topicsQuery.data?.entries ?? [];
  const homeId = topicsQuery.data?.home_id;
  const threads = threadsQuery.data?.threads ?? [];
  const groups = groupThreads(entries, threads);
  const toggle = (id) =>
    setExpanded((current) => {
      const next = { ...current, [id]: !current[id] };
      storage?.set("expanded", next);
      return next;
    });

  return jsxs("div", {
    className: "topoi-tree",
    children: [
      jsxs(ScrollArea, {
        className: "topoi-scroll",
        children: [
          groups.map((group) =>
            jsx(
              TopicSection,
              {
                entries,
                entry: group.entry,
                expanded: Boolean(expanded[group.entry.id]),
                homeId,
                onOpenTopic: openTopicTab,
                onToggle: () => toggle(group.entry.id),
                threads: group.threads,
              },
              group.entry.id,
            ),
          ),
          threads.length === 0 &&
            jsx(EmptyState, {
              description: "Threads show up here once a chat is added to a topic.",
              title: "No threads yet",
            }),
        ],
      }),
    ],
  });
}

// ---- settings page ------------------------------------------------------------

function TopicsSettings() {
  const scope = useScope();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryFn: fetchTopics,
    queryKey: TOPICS_KEY(scope),
    staleTime: 30_000,
  });
  // Thread counts decide archive vs delete per row, so the settings page reads
  // the listing too (only threads filed under a live topic are counted).
  const { data: threadData } = useQuery({
    queryFn: fetchThreads,
    queryKey: THREADS_KEY(scope),
    staleTime: 30_000,
  });
  const [newName, setNewName] = useState("");
  // The id field opens on the locked t_ prefix; the suffix is the user's part.
  const [newId, setNewId] = useState("t_");
  const [renames, setRenames] = useState({});
  const [pendingDelete, setPendingDelete] = useState(null);

  const entries = data?.entries ?? [];
  const homeId = data?.home_id;

  const threadCounts = {};
  for (const thread of threadData?.threads ?? []) {
    if (thread.topic_id) {
      threadCounts[thread.topic_id] = (threadCounts[thread.topic_id] || 0) + 1;
    }
  }
  const idSuffix = newId.startsWith(ID_PREFIX) ? newId.slice(ID_PREFIX.length) : "";
  const idProblem = idSuffix ? topicIdProblem(newId, entries) : "";

  const save = async (next) => {
    try {
      await putTopics({
        entries: next.entries ?? entries,
        home_id: next.home_id ?? homeId,
      });
    } catch (err) {
      host.notifyError(err, "Could not save topics");
      return false;
    }
    qc.invalidateQueries({ queryKey: ["topoi"] });
    return true;
  };

  const addTopic = () => {
    const name = newName.trim();
    const id = newId.trim();
    // The id is the locked prefix plus the user's suffix; a bare t_ is not an id.
    if (!name || id.length <= ID_PREFIX.length || topicIdProblem(id, entries)) return;
    setNewName("");
    setNewId(ID_PREFIX);
    return save({ entries: [...entries, { id, name }] });
  };

  const commitRename = (id) => {
    const draft = renames[id];
    if (draft === undefined || draft.trim() === "") return;
    const name = draft.trim();
    setRenames((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    const entry = entries.find((item) => item.id === id);
    if (entry && entry.name === name) return;
    return save({
      entries: entries.map((item) => (item.id === id ? { ...item, name } : item)),
    });
  };

  const toggleArchive = (id) =>
    save({
      entries: entries.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item };
        if (next.archived) {
          delete next.archived;
        } else {
          next.archived = true;
        }
        return next;
      }),
    });

  const setHome = (id) => save({ home_id: id });

  const move = (id, direction) => {
    const index = entries.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= entries.length) return;
    const next = [...entries];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    return save({ entries: next });
  };

  const removeTopic = async (entry) => {
    const remaining = entries.filter((item) => item.id !== entry.id);
    const next = { entries: remaining };
    // A deleted home must not leave home_id pointing at a topic no client shows.
    if (homeId === entry.id) next.home_id = fallbackHome(remaining);
    const ok = await save(next);
    if (ok) setPendingDelete(null);
  };

  if (isLoading) {
    return jsx(EmptyState, { title: "Loading topics" });
  }

  const row = (entry) => {
    const draft = renames[entry.id] ?? entry.name;
    const threads = threadCounts[entry.id] || 0;
    return jsxs("div", {
      className: "topoi-edit",
      children: [
        jsx(Input, {
          className: "topoi-edit-name",
          onBlur: () => commitRename(entry.id),
          onChange: (event) =>
            setRenames((current) => ({ ...current, [entry.id]: event.target.value })),
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          },
          value: draft,
        }),
        jsxs("div", {
          className: "topoi-edit-actions",
          children: [
            entry.id === homeId
              ? jsx(Badge, { children: "Home" })
              : jsx(Button, {
                  onClick: () => setHome(entry.id),
                  size: "sm",
                  title: "Set as the delivery home",
                  variant: "ghost",
                  children: jsx(Codicon, { name: "home", size: "0.8125rem" }),
                }),
            // Exactly one of Archive or Delete: a topic with threads keeps them
            // (archive), an empty one goes away (delete).
            threads > 0
              ? jsx(Button, {
                  "aria-label": entry.archived ? "Unarchive topic" : "Archive topic",
                  onClick: () => toggleArchive(entry.id),
                  size: "sm",
                  variant: "ghost",
                  children: jsx(Codicon, { name: "archive", size: "0.8125rem" }),
                })
              : jsx(Button, {
                  "aria-label": "Delete topic",
                  onClick: () => setPendingDelete(entry),
                  size: "sm",
                  variant: "ghost",
                  children: jsx(Codicon, { name: "trash", size: "0.8125rem" }),
                }),
            jsx(Button, {
              "aria-label": "Move topic up",
              onClick: () => move(entry.id, -1),
              size: "sm",
              variant: "ghost",
              children: jsx(Codicon, { name: "arrow-up", size: "0.8125rem" }),
            }),
            jsx(Button, {
              "aria-label": "Move topic down",
              onClick: () => move(entry.id, 1),
              size: "sm",
              variant: "ghost",
              children: jsx(Codicon, { name: "arrow-down", size: "0.8125rem" }),
            }),
          ],
        }),
      ],
    });
  };

  return jsxs("div", {
    className: "topoi-settings",
    children: [
      jsxs("div", {
        className: "topoi-add",
        children: [
          jsx(Input, {
            className: "topoi-add-input",
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") addTopic();
            },
            placeholder: "New topic name",
            value: newName,
          }),
          jsx(Input, {
            className: "topoi-add-input",
            onChange: (event) => {
              // Lock the t_ prefix
              const raw = event.target.value;
              const suffix = raw.startsWith(ID_PREFIX)
                ? raw.slice(ID_PREFIX.length)
                : raw.replace(/^t_?/, "");
              setNewId(ID_PREFIX + suffix);
            },
            onKeyDown: (event) => {
              if (event.key === "Enter") addTopic();
            },
            value: newId,
          }),
          jsx(Button, {
            disabled: !!idProblem || !idSuffix || !newName.trim(),
            onClick: addTopic,
            size: "sm",
            children: "Add",
          }),
        ],
      }),
      idProblem ? jsx("span", { className: "topoi-problem", children: idProblem }) : null,
      entries.map((entry) => jsx("div", { key: entry.id, children: row(entry) })),
      entries.length === 0 &&
        jsx(EmptyState, { title: "No topics", description: "Add one above." }),
      pendingDelete &&
        jsx(ConfirmDialog, {
          confirmLabel: "Delete",
          description:
            `"${pendingDelete.name}" leaves the registry.` +
            (homeId === pendingDelete.id
              ? " It is the current home, so the home moves to another topic."
              : ""),
          destructive: true,
          onClose: () => setPendingDelete(null),
          onConfirm: () => removeTopic(pendingDelete),
          open: true,
          title: "Delete topic?",
        }),
    ],
  });
}

// ---- plugin --------------------------------------------------------------------

export default {
  id: "topoi",
  name: "Topoi",
  description: "Group your chats by topic as threads in a sidebar pane.",
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest;
    storage = ctx.storage;
    ctx.onDispose(() => {
      rest = null;
      storage = null;
      $pendingThread.set(null);
    });
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    ctx.onDispose(() => style.remove());

    // Registry changes arrive over the gateway event stream; thread lists and
    // open topic tabs refresh on the gateway's own sessions.changed. Bindings
    // need no event: they resolve server-side on every /threads read.
    ctx.onEvent("plugin.topoi.topics.changed", () =>
      queryClient.invalidateQueries({ queryKey: ["topoi"] }),
    );
    ctx.onEvent("sessions.changed", () => {
      queryClient.invalidateQueries({ queryKey: ["topoi", "threads"] });
      queryClient.invalidateQueries({ queryKey: ["topoi", "topic"] });
    });

    ctx.onDispose(watchNewThreads());
    ctx.onDispose(() => {
      const closes = [...topicTabs.values()];
      topicTabs.clear();
      closes.forEach((close) => close());
    });

    ctx.register({
      id: "topics",
      area: PANES_AREA,
      title: "Topics",
      // uncloseable: the pane is standing chrome, so its tab carries no ✕ and
      // the zone menu no Close, and a stray click can never dismiss it.
      data: { placement: "left", uncloseable: true, width: "280px" },
      render: () => jsx(TopicTree, {}),
    });

    // The composer's top strip while a New thread click is armed: the fresh
    // draft (in the main pane) says which topic it will be filed under.
    ctx.register({
      id: "new-thread-arm",
      area: COMPOSER_AREAS.top,
      render: () => jsx(ArmBanner, {}),
    });

    ctx.registerSettingsPage?.({
      id: "topics",
      title: "Topics",
      icon: "tag",
      order: 0,
      render: () => jsx(TopicsSettings, {}),
    });
  },
};
