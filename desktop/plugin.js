// Topoi desktop half: a topics tree pane whose thread rows carry the app's
// own session statuses, a topic tab that lists one topic's threads (each
// with a delete action), and the Topics settings page. Talks to the plugin's
// own REST namespace (/api/plugins/topoi) through ctx.rest and opens threads
// through Hermes' native chat (host.openSession), so the conversation
// surface stays core's.
//
// A New thread click files the chat the app mints under its topic: the arm
// waits for the draft's first send however long that takes and is mirrored
// into ctx.storage, so an app restart or a plugin reload restores it; the
// bind waits out the session row's lazy write, and it only ever files a
// chat that did not exist when the arm was set - the topic tab's Add to
// topic action files an existing chat that flow missed. A chat with no turns
// is adopted where the app shows it: the focused chat, or the primary pane's
// empty draft. A click made from a real conversation asks the app for a New
// session (the same action as its New session row and ⌘N), so the new thread
// lands in a draft of its own. The row menu's Move to topic re-files a thread
// under another topic, the same bind with a new target.
//
// A new chat is filed under the home topic by default, including one the app
// minted without a click in this pane. The mechanics live in "the home default"
// section below.
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
  MessageTextContent,
  SessionStatusDot,
  queryClient,
  coarseElapsed,
  useQuery,
  useQueryClient,
  useValue,
} from "@hermes/plugin-sdk";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
// Namespace import on purpose: a missing named export fails ESM linking and takes the
// whole pane down, while a missing property is only undefined. The unread acks are read
// from here behind typeof checks.
import * as pluginSdk from "@hermes/plugin-sdk";

// A topic section is a glance at recent activity: at most SECTION_THREADS
// threads, and the head's label opens the topic tab for the full list.
const SECTION_THREADS = 3;
// One page of a topic tab: its Load more button appends the next page of the
// same size.
const PAGE_SIZE = 10;
// A section lists only threads whose last activity is inside this window;
// older ones are not rows here, they show only in the topic tab.
const PANE_ACTIVE_DAYS = 7;
const PANE_ACTIVE_MS = PANE_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
// A keystroke is not a query: the topic tab's search box waits out this gap, so
// typing a word costs one page request instead of one per letter.
const SEARCH_DEBOUNCE_MS = 220;
// The sidebar's search is one whole-set request: the backend filters the entire
// listing (transcript index, then title and preview) before paginating, so this
// is how many rows a 280px pane shows, not how many matches exist.
const SEARCH_LIMIT = 50;
// One character is a whole-listing scan for nothing.
const SEARCH_MIN_CHARS = 2;
// The bind retries only long enough for the session row to appear: the app
// writes it when the first prompt is processed, a moment after the re-home
// that fired this filing. An id the app minted but never wrote a row for (a
// fresh draft nobody sent into, e.g. a new-chat tile) never gets one, so a
// spent wait is not an error - it drops without a toast. While that draft is
// still the focused chat the wait keeps going at a slower pace, so a long
// think before sending still files. The two globals are the rail's seam for
// shrinking the windows per call; the app never sets them.
const BIND_ROW_GRACE_MS = 2 * 60 * 1000;
const BIND_ROW_MAX_MS = 10 * 60 * 1000;
const BIND_RETRY_MS = 700;
const BIND_RETRY_SLOW_MS = 2000;
const bindWindow = (name, fallback) => Number(globalThis[name]) || fallback;
// The arm's durable mirror in ctx.storage (localStorage-backed), so an app
// restart or a desktop-plugin reload inside its life restores the filing
// instead of losing it.
const PENDING_THREAD_KEY = "pendingThread";

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
.topoi-section-read{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:20px;height:24px;padding:0;border:0;border-radius:4px;background:none;color:var(--ui-text-quaternary);cursor:pointer;opacity:0;transition:opacity 120ms ease}
.topoi-section-read:hover{background:var(--chrome-action-hover);color:var(--ui-text-secondary)}
.topoi-section-head:hover .topoi-section-read{opacity:1}
.topoi-section-read:focus-visible{opacity:1}
.topoi-section-read:disabled,.topoi-section-read:disabled:hover{opacity:0;background:none;cursor:default}
.topoi-section-head:hover .topoi-section-read:disabled{opacity:0}
.topoi-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px;padding:0 4px 0 8px}
.topoi-row-main{display:flex;min-width:0;align-items:center;gap:6px;height:26px;padding:0 4px;text-align:left;border:0;border-radius:4px;background:none;color:var(--ui-text-primary);cursor:pointer}
.topoi-row-main:hover{background:var(--chrome-action-hover)}
.topoi-row-main.topoi-open,.topoi-row-main.topoi-open:hover{background:var(--ui-row-active-background)}
.topoi-reader{display:flex;flex-direction:column;height:100%;min-height:0}
.topoi-reader-head{display:flex;width:min(86%,44rem);margin:0 auto;align-items:center;gap:8px;padding:10px 8px 4px}
.topoi-reader-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.875rem;font-weight:600;color:var(--ui-text-primary)}
.topoi-reader-when{flex-shrink:0;font-size:0.625rem;color:var(--ui-text-quaternary)}
.topoi-reader-body{flex:1;min-height:0;overflow:auto}
.topoi-reader-markdown{width:min(86%,44rem);margin:0 auto;padding:12px 8px 40px}
.topoi-reader-markdown .aui-md > :first-child{margin-top:0}
.topoi-reader-markdown .aui-md > :last-child{margin-bottom:0}
.topoi-reader-markdown .aui-md :where(p){margin-block:0.7rem 0}
.topoi-reader-markdown .aui-md :where(h1,h2,h3,h4){margin-block:1rem 0.25rem}
.topoi-reader-markdown .aui-md :where(img){margin:0}
.topoi-reader-note{width:min(86%,44rem);margin:0 auto;padding:12px 8px 40px;font-size:0.75rem;color:var(--ui-text-tertiary)}
.topoi-reader-reply{color:var(--theme-neutral-chrome)}
.topoi-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem}
.topoi-row-time{flex-shrink:0;font-size:0.625rem;color:var(--ui-text-quaternary)}
.topoi-lead{display:grid;flex-shrink:0;place-items:center;width:14px;height:14px}
.topoi-row-menu{padding:0 2px}
.topoi-note{padding:4px 10px 8px;font-size:0.6875rem;line-height:1.5;color:var(--ui-text-quaternary)}
.topoi-problem{font-size:0.6875rem;line-height:1.5;color:var(--color-red-400)}
.topoi-tab{display:flex;flex-direction:column;height:100%;min-height:0}
.topoi-tab-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
.topoi-tab-titles{display:flex;min-width:0;flex-direction:column;gap:2px}
.topoi-tab-title{display:flex;align-items:center;gap:6px;font-size:0.875rem;font-weight:600;color:var(--ui-text-primary)}
.topoi-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topoi-tab-meta{font-size:0.6875rem;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
.topoi-tab-search{padding:0 12px 6px}
.topoi-search{width:100%}
.topoi-tab-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.topoi-tab-body{flex:1;min-height:0}
.topoi-load-more{display:flex;justify-content:center;padding:6px 0 10px}
.topoi-picker{display:flex;flex-direction:column;gap:2px;padding:4px 8px}
.topoi-picker-filter{margin-bottom:4px}
.topoi-pick{display:flex;min-width:0;align-items:center;gap:8px;width:100%;height:26px;padding:0 4px;text-align:left;border:0;border-radius:4px;background:none;color:var(--ui-text-primary);font:inherit;cursor:pointer}
.topoi-pick:hover{background:var(--chrome-action-hover)}
.topoi-pick-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem}
.topoi-add-active{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.topoi-new-thread{color:var(--theme-neutral-chrome)}
.topoi-settings{display:flex;flex-direction:column;gap:10px;padding:2px 0 8px}
.topoi-add{display:flex;gap:6px}
.topoi-add-input{flex:1;min-width:0}
.topoi-edit{display:flex;align-items:center;gap:6px}
.topoi-edit-name{flex:1;min-width:0}
.topoi-edit-actions{display:flex;align-items:center;gap:2px}
.topoi-find{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:0 8px 6px}
.topoi-find-field{flex:1 1 auto;min-width:0}
.topoi-find-button{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:20px;height:24px;padding:0;border:0;border-radius:4px;background:none;color:var(--ui-text-quaternary);cursor:pointer}
.topoi-find-button:hover{background:var(--chrome-action-hover);color:var(--ui-text-secondary)}
.topoi-find-button:disabled{background:none;color:var(--ui-text-quaternary);cursor:default;opacity:0.4}
.topoi-search-head{display:flex;flex:1;min-width:0;align-items:center;gap:6px;margin-left:4px;padding:0 4px;height:24px}
.topoi-search-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.6875rem;font-weight:600;color:var(--ui-text-secondary)}
.topoi-count{flex-shrink:0;padding-right:4px;font-size:0.625rem;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
`;

// Bound at register; null after unload/disable. Components read them per call.
let rest = null;
let storage = null;
// The app's own built-in actions (ctx.runAction), bound at register. Absent on a
// desktop older than the action door, which is why every call site degrades.
let runAction = null;

// The topic tabs this plugin has open, keyed by topic id: closed on unload.
const topicTabs = new Map();
// The cron readers this plugin has open, keyed by session id: a second click
// fronts the same tab instead of stacking a duplicate.
const cronReaders = new Map();
// The cron readers this plugin has OPEN, by row session id. A Set, because
// several reader tabs can be open at once (the Map above only holds their
// closers), and a row bands when its OWN reader tab holds the zone's active
// slot - so this is the "we really opened one" guard, never the selection. A
// single-id atom here named only the reader opened last, and every earlier
// reader lost its band the moment another tab was fronted.
const $cronReaderIds = atom(new Set());
// Delete-then-add keeps insertion order honest: the last entry is the reader
// opened most recently, which is all a host without pane visibility can know.
const addCronReader = (sessionId) => {
  const next = new Set($cronReaderIds.get());
  next.delete(sessionId);
  next.add(sessionId);
  $cronReaderIds.set(next);
};
const dropCronReader = (sessionId) => {
  const next = new Set($cronReaderIds.get());
  next.delete(sessionId);
  $cronReaderIds.set(next);
};
// The pane read every row falls back to: an always-false atom for a desktop
// without the visibility door and for rows that cannot be open at all. Hooks
// run in the same order on every render, so there is always something to read.
const NO_TAB = atom(false);
// A layout pane's on-screen truth - does it hold its zone's active tab slot?
// `host.paneVisibility` answers that for core's `workspace` / `session-tile:<id>`
// panes and for our own reader tabs, and the open band follows it so exactly
// ONE thread row is lit. Feature-detected per call: a desktop without the door
// answers NO_TAB and the band keeps its older focus/reader-atom rules.
const paneTab = (paneId) =>
  typeof host.paneVisibility === "function" ? host.paneVisibility(paneId) : NO_TAB;
const paneTabsReadable = () => typeof host.paneVisibility === "function";
// The armed New thread filing, if any: the topic to file under, the chat id
// that was focused when the click happened (never the one we want), and - when
// the click adopted a tab with no turns yet - that tab's own id, which IS the
// chat to file. An atom so the composer banner re-renders when the arm changes.
const $pendingThread = atom(null);

// Chats this plugin opened itself, by id: a branch, and every thread row this
// pane opened. The home default reads focus, and both kinds focus an id nothing
// has seen before, so without this the branch would be armed to home and bound
// twice - once by branchThread and once by the default, where the second bind
// 409s - and a clicked cron mirror would be filed under home. It grows with use
// and is never pruned on purpose: the set is small, and a pruned id that came
// back would misfile.
const ownChatIds = new Set();

// Chat ids the app has SHOWN since this plugin loaded. Only ever an exclusion
// set - "ids a mint must not be mistaken for" - so a superset is the safe
// direction: a closed tab leaves no trace here and an extra id costs nothing.
// Never adoption candidates (a closed tab's id must not be adopted), and not
// ownChatIds: that set means "this plugin opened it", which changes the home
// default's arming, not mint detection.
const liveChatIds = new Set();

// The atom is the live copy and ctx.storage the durable mirror, so an app
// restart or a desktop-plugin reload inside the arm's life restores it
// instead of losing the filing. Every mutation goes through here.
const setPendingThread = (next) => {
  $pendingThread.set(next);
  if (next) {
    storage?.set(PENDING_THREAD_KEY, {
      at: next.at,
      awaitTurn: next.awaitTurn === true,
      home: next.home === true,
      known: next.known ? [...next.known] : null,
      seenId: next.seenId,
      sessionId: next.sessionId ?? null,
      topicId: next.topicId,
      topicName: next.topicName,
    });
  } else {
    storage?.remove?.(PENDING_THREAD_KEY);
  }
};

// Files an adopted tab: the chat is already on screen, so the wait starts at
// once and rides fileThread's row-write retry, and the note clears only while
// it is still THIS chat's, so a newer New thread click is never cancelled by a
// wait left over from the previous one.
function fileAdoptedTab(sessionId, topicId, topicName) {
  const stillWanted = () => {
    const pending = $pendingThread.get();
    return pending?.sessionId === sessionId && pending?.topicId === topicId;
  };
  void fileThread(sessionId, topicId, topicName, stillWanted).finally(() => {
    const pending = $pendingThread.get();
    if (pending?.sessionId === sessionId) {
      setPendingThread(null);
    }
  });
}

// Restores an arm a previous session persisted and refreshes its snapshot,
// so chats minted during the gap still cannot consume the arm. An adopted tab's
// id is already known, so its filing simply resumes.
function restorePendingThread() {
  const stored = storage?.get(PENDING_THREAD_KEY, null);
  if (!stored || typeof stored.topicId !== "string" || !stored.topicId) return;
  const at = typeof stored.at === "number" ? stored.at : Date.now();
  const sessionId =
    typeof stored.sessionId === "string" && stored.sessionId ? stored.sessionId : null;
  const topicName = typeof stored.topicName === "string" ? stored.topicName : stored.topicId;
  setPendingThread({
    at,
    awaitTurn: stored.awaitTurn === true,
    home: stored.home === true,
    known: Array.isArray(stored.known) ? new Set(stored.known) : null,
    seenId: typeof stored.seenId === "string" ? stored.seenId : null,
    sessionId,
    topicId: stored.topicId,
    topicName,
  });
  if (sessionId) {
    if (stored.awaitTurn === true) {
      // A home arm restored mid-draft still binds nothing until the first turn,
      // so the check runs now and the watcher's own signals carry it after. The
      // declaration is hoisted, which is why this call site can precede it.
      void settleHomeArm();
      return;
    }
    fileAdoptedTab(sessionId, stored.topicId, topicName);
    return;
  }
  // A restored id-less arm only applies while the draft is fronted; a reload that
  // landed on a real chat should not leave it hunting the next unseen id.
  //
  // The test runs on a 400ms timer instead of here: at register() the route and
  // paneVisibility('workspace') are often not published yet, so a synchronous
  // check would drop a good arm on the reload it exists to survive, and a send
  // inside that gap would file nothing. 400ms is enough for the layout to publish
  // and far too short for anyone to have typed. An id the arm's own snapshot
  // cannot account for is exempt throughout: that is the send-preceded-the-reload
  // mint, which the block below recovers.
  const focusedAtRestore = host.state?.focusedStoredSessionId?.get?.() ?? null;
  const maybeMint =
    Boolean(focusedAtRestore) &&
    Array.isArray(stored.known) &&
    !stored.known.includes(focusedAtRestore);
  if (
    !sessionId &&
    stored.home === true &&
    stored.awaitTurn !== true &&
    !maybeMint &&
    !primaryDraftOnScreen(focusedAtRestore)
  ) {
    globalThis.setTimeout(() => {
      const armed = $pendingThread.get();
      if (!armed || armed.at !== at || armed.sessionId) return;
      const focusedNow = host.state?.focusedStoredSessionId?.get?.() ?? null;
      if (primaryDraftOnScreen(focusedNow)) return;
      if (focusedNow && armed.known instanceof Set && !armed.known.has(focusedNow)) return;
      setPendingThread(null);
    }, 400);
  }
  // The usual shape of a home-draft arm: no id until the send. Re-derive the
  // snapshot here, since watchNewThreads tests a mint against it.
  void knownSessionIds().then((known) => {
    const pending = $pendingThread.get();
    if (!pending || !(known instanceof Set) || pending.at !== at) return;
    const focusedNow = host.state?.focusedStoredSessionId?.get?.() ?? null;
    // A reload can land after the send but before the bind: the arm still has no
    // id, the mint is focused, and no further focus change will announce it. An id
    // the snapshot does not hold is that mint. Same conversion as watchNewThreads:
    // let the settle read turns instead of starting fileThread's window on a chat
    // that may have no row yet.
    if (focusedNow && !pending.sessionId && !known.has(focusedNow)) {
      setPendingThread({
        ...pending,
        awaitTurn: true,
        known,
        sessionId: focusedNow,
        seenId: focusedNow,
      });
      void settleHomeArm();
      return;
    }
    setPendingThread({ ...pending, known });
  });
}

const TOPICS_KEY = (scope) => ["topoi", "topics", scope];
const THREADS_KEY = (scope) => ["topoi", "threads", scope];
const TOPIC_PAGE_KEY = (scope, topicId, limit, query) => [
  "topoi",
  "topic",
  scope,
  topicId,
  limit,
  query,
];

// Queries are scoped by the active connection so a backend switch is a clean
// cache miss (the kanban roster pattern).
function useScope() {
  return useValue(host.state.connectionId) ?? "local";
}

const fetchTopics = () => rest("/topics");
const fetchThreads = () => rest("/threads");
// One topic's threads, newest first: `total` is the topic's whole count, so a
// Load more button knows whether a next page exists. A `query` searches the
// topic's conversations, not the page the tab happens to hold: the backend
// filters before paginating, so `total` is every match in the topic.
const fetchTopicPage = (topicId, limit, query = "") =>
  rest(
    `/threads?topic=${encodeURIComponent(topicId)}&limit=${limit}&offset=0${
      query ? `&q=${encodeURIComponent(query)}` : ""
    }`,
  );
const putTopics = (state) => rest("/topics", { method: "PUT", body: state });
// `move` is the row menu's Move to topic: the backend refuses to re-topic an
// existing filing without it, so a misfired filing leaves the thread alone.
const bindThread = (sessionId, topicId, move = false) =>
  rest("/threads/bind", {
    method: "POST",
    body: move
      ? { session_id: sessionId, topic_id: topicId, move: true }
      : { session_id: sessionId, topic_id: topicId },
  });
const fetchCronResult = (sessionId) => rest(`/threads/${encodeURIComponent(sessionId)}/cron`);
const deleteThread = (sessionId) =>
  rest(`/threads/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
// One read mark for both buttons. The ids are the rows the sidebar is showing, so
// the client owns the scope: the backend stamps them and reports any it could not.
// An empty set never becomes a request.
const markThreadsRead = (sessionIds) =>
  sessionIds && sessionIds.length > 0
    ? rest("/threads/read", { method: "POST", body: { session_ids: sessionIds } })
    : Promise.resolve({ ok: true, marked: 0, failed: [] });

// The sidebar pane passes "in-place".
// The row menu and the branch keep asking for their own intents.
const openThread = (thread, intent) => {
  if (thread && typeof thread === "object" && thread.cron_result) {
    openCronReader(thread);
    return;
  }
  const sessionId = typeof thread === "string" ? thread : thread?.session_id;
  if (!sessionId) return;
  // This pane opened it, so it is not a draft's mint. The listing check in
  // watchNewThreads covers threads this plugin never touched, but it reads the
  // query cache, which is cold until the pane mounts: this line is the
  // deterministic half.
  ownChatIds.add(sessionId);
  return host
    .openSession(sessionId, intent ? { intent } : {})
    .catch((error) => host.notifyError(error, "Could not open the thread"));
};

// A cron result opens as a document, not as a chat: a run's transcript is tool
// calls, and a mirrored thread is a single seeded turn. One tab per session,
// fronted on a second click, and the row's active highlight follows it because
// core's focused session never moves for a workspace tab.
function openCronReader(thread) {
  const sessionId = thread?.session_id;
  if (!sessionId || !rest) return;
  if (typeof host.openWorkspace !== "function") {
    host.notify({
      kind: "error",
      message: "Update Hermes Desktop to open a cron result.",
    });
    return;
  }
  const close = host.openWorkspace(`cron-${sessionId}`, {
    dock: { pane: "workspace", pos: "center" },
    onClose: () => {
      cronReaders.delete(sessionId);
      dropCronReader(sessionId);
    },
    render: () => jsx(CronReader, { thread }),
    title: thread.title || "Cron result",
  });
  cronReaders.set(sessionId, close);
  addCronReader(sessionId);
}

// Opening a thread from its TOPIC TAB replaces the tab: the session opens as
// a tab in the same strip and the topic tab closes, so the workspace never
// carries both the list and the chat. A failed open leaves the tab standing
// rather than costing the listing.
async function openThreadFromTopicTab(thread, topicId) {
  if (thread?.cron_result) {
    // The reader is a sibling of the list, not a replacement for it.
    openCronReader(thread);
    return;
  }
  try {
    await host.openSession(thread.session_id, { intent: "tab" });
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
    // This plugin's own chat, not a tab the user minted: the focus it causes
    // below must not read as a fresh tab for the home default.
    ownChatIds.add(sessionId);
    // A branch copies its parent's transcript, so its row is seeded and the
    // tab can hydrate it; only a branch of a never-sent chat would be lazy.
    await host.openSession(sessionId, { intent: "tab", ...(profile ? { profile } : {}) });
    await fileThread(sessionId, thread.topic_id, "the branch");
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

// Moving a thread is the same bind with another topic plus the move flag: the
// store upserts by lineage root, but the backend only re-files an existing
// binding when the request says move (a plain bind 409s), so a stray filing
// can never relocate a thread. The lists refetch once it lands.
async function moveThread(thread, entry) {
  try {
    await bindThread(thread.session_id, entry.id, true);
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
  return pool.length > 0 ? pool[0].id : "t_general";
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
  // The box's text is instant; the query it sends is debounced. A new search
  // starts at the first page, because the limit a Load more click grew belongs
  // to the list the user was reading, not to the one they just asked for.
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const next = typed.trim();
    if (next === query) return undefined;
    const timer = setTimeout(() => {
      setQuery(next);
      setLimit(PAGE_SIZE);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, query]);
  const topicsQuery = useQuery({
    queryFn: fetchTopics,
    queryKey: TOPICS_KEY(scope),
    staleTime: 30_000,
  });
  const pageQuery = useQuery({
    // The rows of the last answer stay painted while the next one lands, so a
    // keystroke never blanks the tab for a round trip.
    placeholderData: (previous) => previous,
    queryFn: () => fetchTopicPage(topicId, limit, query),
    queryKey: TOPIC_PAGE_KEY(scope, topicId, limit, query),
    staleTime: 15_000,
  });

  const entries = topicsQuery.data?.entries ?? [];
  const entry = entries.find((item) => item.id === topicId);
  const name = entry?.name ?? topicId;
  const threads = pageQuery.data?.threads ?? [];
  const total = pageQuery.data?.total ?? threads.length;
  // A search counts matches, not the topic's threads: the row list IS the
  // answer, and "12 threads" under three matches would read as a bug.
  const summary = query
    ? total === 1
      ? "1 result"
      : `${total} results`
    : total === 1
      ? "1 thread"
      : `${total} threads`;
  // The recovery door: a chat the New thread flow missed (an expired arm, a
  // bind that lost the row race, a first send after the window) is filed
  // from here by picking it. Only chats not already filed under a topic are
  // offered, and filing one moves it into the list below.
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const unfiledQuery = useQuery({
    enabled: picking,
    queryFn: async () => {
      // `limit` caps at 200 in the gateway's list_sessions (1..200, anything
      // else is invalid_params), so the picker's old 500 listed nothing.
      const [listed, filed] = await Promise.all([
        host.request("session.list", { limit: 200 }),
        fetchThreads(),
      ]);
      const filedIds = new Set();
      for (const row of filed?.threads ?? []) {
        filedIds.add(row.session_id);
        if (row.lineage_root) filedIds.add(row.lineage_root);
      }
      // Cron runs are not chat targets. A result belongs to its topic through the
      // reader, and filing a run by hand would list the run beside the thread it
      // already delivered into.
      return (listed?.sessions ?? []).filter(
        (row) => row?.id && !filedIds.has(row.id) && row.source !== "cron",
      );
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
                children: summary,
              }),
            ],
          }),
          jsx("div", {
            className: "topoi-tab-actions",
            children: [
              jsxs(Button, {
                className: "topoi-new-thread",
                onClick: () => void startNewThread(entry ?? { id: topicId, name }),
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
      // The search row sits under the head and OUTSIDE the scroll box, so the
      // field holds its place while the results move beneath it. It stands down
      // while the Add to topic picker is open, which carries its own filter.
      !picking &&
        jsx("div", {
          className: "topoi-tab-search",
          children: jsx(Input, {
            "aria-label": `Search ${name}`,
            className: "topoi-search",
            onChange: (event) => setTyped(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Escape") setTyped("");
            },
            placeholder: "Search this topic",
            value: typed,
          }),
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
                    hint: thread.match,
                    key: thread.lineage_root,
                    onOpen: (row) => openThreadFromTopicTab(row, topicId),
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
                  (query
                    ? jsx(EmptyState, {
                        description: `No thread in ${name} mentions it, in any message.`,
                        title: "No matches",
                      })
                    : jsx(EmptyState, {
                        description: "Threads show up here once a chat is added to this topic.",
                        title: "No threads yet",
                      })),
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
// unseen id) rather than never filing at all. `limit` caps at 200: the
// gateway's list_sessions accepts 1..200 and refuses anything else, so the old
// `limit: 500` made every snapshot fail and left the guard blind in the app.
const knownSessionIds = async () => {
  try {
    const listed = await host.request("session.list", { limit: 200 });
    return new Set((listed?.sessions ?? []).map((row) => row?.id).filter(Boolean));
  } catch {
    return null;
  }
};

// One snapshot of both turn listings: the gateway's live `session.list` and
// core's own persisted read (state.db, no message floor). `turns(id)` answers a
// chat's message count, or null when neither listing names it - the app writes
// a session row only when the first prompt is processed, so an unstarted "New
// session" tab is rowless and appears in neither. `answered` says whether any
// listing answered at all, so "no turns" can be told from "could not look".
async function loadTurnLookup() {
  const rows = new Map();
  let answered = false;
  const absorb = (page) => {
    for (const row of Array.isArray(page?.sessions) ? page.sessions : []) {
      const id = row?.id ?? row?.session_id;
      if (id && !rows.has(id)) rows.set(id, Number(row.message_count ?? 0) || 0);
    }
  };
  try {
    absorb(await host.request("session.list", { limit: 200 }));
    answered = true;
  } catch {
    // Refused or socket-busy: the persisted read below still answers.
  }
  if (typeof host.listPersistedSessions === "function") {
    try {
      absorb(
        await host.listPersistedSessions(null, {
          limit: 50,
          profile: activeProfile() || "default",
        }),
      );
      answered = true;
    } catch {
      // Unreadable: the snapshot stays partial, and nothing is assumed from it.
    }
  }
  return { answered, turns: (id) => (rows.has(id) ? rows.get(id) : null) };
}

// Is this chat unstarted? A listed chat answers from its own message count, and
// a chat NO answering listing names has no row yet, so it has no turns either.
// `trustUnreadable` is the focused chat's benefit of the doubt: an unreadable
// listing still lets the click adopt it, because the filing's own row-write
// retry is what makes that guess safe. Another tab has to prove it is empty, so
// a failed listing can never hand a real conversation to the filing.
const isUnstarted = (lookup, sessionId, trustUnreadable = false) => {
  const turns = lookup.turns(sessionId);
  if (turns !== null) return turns === 0;
  return lookup.answered || trustUnreadable;
};

// A fresh chat through the app's own door: `session.new`, the action the sidebar's
// New session row and the ⌘N shortcut run. It lands a draft in the workspace pane,
// because core docks a tab only for `session.newTab`, which is not allowlisted yet.
// A desktop without the action keeps its own draft, and the caller arms nothing.
function startNewChat() {
  if (runAction) {
    const result = runAction("session.new");
    if (result?.ok === true) return true;
  }
  if (typeof host.newChat === "function") {
    host.newChat();
    return true;
  }
  return false;
}

// The primary chat holds an unstarted draft that is ON SCREEN: core reports no
// selected session there (a null focused chat) and the pane owns its zone's
// active slot, so the empty tab in front is the app's own new chat.
function primaryDraftOnScreen(focused) {
  if (focused) return false;
  if (typeof host.paneVisibility !== "function") return false;
  return host.paneVisibility("workspace")?.get?.() === true;
}

// Arms the chat this click adopted. The arm carries its id, so the focus watcher skips it
// and the first turn files it.
function adoptChat(sessionId, entry, name) {
  setPendingThread({
    at: Date.now(),
    // Nothing typed yet, so wait for the first turn. Binding now would file an empty thread
    // and clear the hint; a restored arm keeps fileAdoptedTab because it may have turns.
    awaitTurn: true,
    known: null,
    seenId: sessionId,
    sessionId,
    topicId: entry.id,
    topicName: name,
  });
  host.composer?.focus?.(sessionId);
  void settleHomeArm();
}

// Arms the primary pane's own unstarted draft: no tab is minted, so the thread
// lands in the empty chat already on screen, and the watcher files the first id
// that send produces (the snapshot keeps a visit to another chat from consuming
// the arm).
function adoptPrimaryDraft(entry, name) {
  const at = Date.now();
  setPendingThread({
    at,
    known: null,
    seenId: null,
    sessionId: null,
    topicId: entry.id,
    topicName: name,
  });
  void knownSessionIds().then((known) => {
    const pending = $pendingThread.get();
    if (pending && pending.at === at) {
      setPendingThread({ ...pending, known });
    }
  });
  host.composer?.focus?.("new");
}

// A New thread click. ANY chat with no turns that the app is SHOWING is the new
// thread: the focused chat when it is unstarted, and the primary chat's empty
// draft (Boss, 2026-10-27: "whether in front or not does not matter"). The click
// adopts it and files it on the first send through fileThread's row-write retry,
// instead of stacking a second empty chat. A click made from a real conversation
// asks the app for a New session, which lands a draft in the workspace pane.
async function startNewThread(entry) {
  if (!runAction && typeof host.newChat !== "function") {
    host.notify({ kind: "error", message: "Update Hermes Desktop to start a chat." });
    return;
  }
  const name = entry.name ?? entry.id;
  const at = Date.now();
  const focused = host.state?.focusedStoredSessionId?.get?.() ?? null;
  const lookup = await loadTurnLookup();
  // The topic `+` on an untitled chat is a topic change, not a request for
  // another chat: adopt what is focused. Fronting an open tile, if a caller ever
  // needs it: host.openSession(id, {intent: "tab"}).
  if (focused && isUnstarted(lookup, focused, true)) {
    adoptChat(focused, entry, name);
    return;
  }
  if (primaryDraftOnScreen(focused)) {
    adoptPrimaryDraft(entry, name);
    return;
  }
  setPendingThread({
    at,
    known: null,
    seenId: focused,
    sessionId: null,
    topicId: entry.id,
    topicName: name,
  });
  // The listing rides the gateway socket and lands within a few hundred
  // milliseconds, long before a send can mint the new chat's id, so the
  // snapshot is in before the watcher can see a focus change.
  void knownSessionIds().then((known) => {
    const pending = $pendingThread.get();
    if (pending && pending.at === at) {
      setPendingThread({ ...pending, known });
    }
  });
  // A draft of its own when the click came from a real conversation. The action
  // is the app's own New session, so a desktop without it says so instead of
  // leaving the user in a chat that never appears.
  if (!startNewChat()) {
    setPendingThread(null);
    host.notify({ kind: "error", message: "Update Hermes Desktop to start a chat." });
  }
}

// The app writes the session row a moment after the first prompt, so a 404 is
// the row not being there yet rather than a refusal.
const isMissingSession = (error) =>
  error?.statusCode === 404 || /^404\b/.test(String(error?.message ?? ""));

// A 409 means the chat is already filed under another topic. Only the row
// menu's Move sends the move flag, so a filing that collides with an existing
// one is a misfire and must leave the thread where it is.
const isAlreadyFiled = (error) =>
  error?.statusCode === 409 || /^409\b/.test(String(error?.message ?? ""));

const stillFocused = (sessionId) =>
  (host.state?.focusedStoredSessionId?.get?.() ?? null) === sessionId;

// Files a chat under its topic, waiting out the row write. The row lands when
// the first prompt is processed, which is after the re-home that fired this
// filing, so the first attempts 404 by design; anything else is a real
// refusal and gives up at once. A 404 that outlives the grace is a draft with
// no row (nobody sent into it), which is not a failure the user can act on, so
// it drops silently. While that draft is still focused the wait continues
// slowly until the hard cap, which is what keeps a long think before the first
// send from losing the filing. `stillWanted` (optional) is the caller's
// supersession test, read before every attempt: an adopted tab whose click has
// since been replaced stops without binding.
async function fileThread(sessionId, topicId, topicName, stillWanted = null) {
  const deadline = Date.now() + bindWindow("__TOPOI_BIND_GRACE_MS__", BIND_ROW_GRACE_MS);
  const cap = Date.now() + bindWindow("__TOPOI_BIND_MAX_MS__", BIND_ROW_MAX_MS);
  for (;;) {
    if (stillWanted && !stillWanted()) return;
    try {
      await bindThread(sessionId, topicId);
      queryClient.invalidateQueries({ queryKey: ["topoi"] });
      return;
    } catch (error) {
      if (isAlreadyFiled(error)) {
        console.warn(
          "[topoi] filing skipped, already filed:",
          sessionId,
          String(error?.message ?? error),
        );
        return;
      }
      if (!isMissingSession(error)) {
        console.warn(
          "[topoi] could not file the new thread under",
          topicName || "its topic",
          String(error?.message ?? error),
        );
        return;
      }
      const now = Date.now();
      const waiting = now < deadline || (now < cap && stillFocused(sessionId));
      if (!waiting) {
        console.warn("[topoi] filing dropped, no session row:", sessionId);
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, now < deadline ? BIND_RETRY_MS : BIND_RETRY_SLOW_MS),
      );
    }
  }
}

function watchNewThreads() {
  const focused = host.state?.focusedStoredSessionId;
  if (!focused?.listen) return () => {};
  return focused.listen((sessionId) => {
    const pending = $pendingThread.get();
    if (!pending || !sessionId || sessionId === pending.seenId) return;
    // An adopted tab names its own chat, so this door - which files the FIRST
    // unseen id a draft produces - is not its filing. Without this guard a
    // switch to any other chat filed THAT chat under the topic (and left the
    // adopted tab's own send unfiled).
    if (pending.sessionId) return;
    // A chat that already existed when the arm was set is the user visiting
    // another chat, not the new one: it must not consume the arm.
    if (pending.known?.has(sessionId)) return;
    // Chats this plugin opens itself are never a draft's mint. The arm is
    // id-less while the primary draft is fronted, and every unseen id looks like
    // a mint to this door, so a thread clicked in this pane - a cron mirror, a
    // thread another client made, an Apropos child - would otherwise be filed
    // under the home topic.
    if (ownChatIds.has(sessionId)) return;
    // The listing already carries it, so it is filed and cannot be the mint
    // either. Same cache read as the arming side: a scope-keyed lookup would go
    // blind whenever the prefetch and the gateway disagree about `connectionId`.
    const filed = cachedTopoi(["topoi", "threads"], scopeNow());
    if (filedSessionIds(filed).has(sessionId)) return;
    // The arm has no id yet, so it belongs to the primary draft, and this id is
    // not necessarily a mint: a new chat starts with no turns, and filing that
    // now would start fileThread's window with no row to bind, then let it expire
    // before the first send. Convert the arm and let turns decide. A draft's send
    // already has its row, so it binds at once; a fresh chat waits for its first
    // turn.
    // An id-less arm is a draft, home default or sidebar click alike: convert it and let
    // the first turn file it. Filing here binds an empty chat and clears the arm, which is
    // the hint flashing and vanishing.
    setPendingThread({ ...pending, awaitTurn: true, sessionId, seenId: sessionId });
    void settleHomeArm();
  });
}

// ---- the home default --------------------------------------------------------

// The home default. A chat the app starts on its own (its New session row, ⌘N,
// ⌘T) has no plugin door: core mints it, so focus is the only signal this half
// can watch. A mint docks a tile and focuses it, and its id is one this window
// has never held, which separates it from a switch to an empty chat the user
// already had.
//
// The arm is the sidebar's, except that nothing binds until the draft's first
// turn. fileThread's retry window starts when it is called, so a tab opened at
// nine and sent at ten would spend that window on a row that cannot exist yet,
// then drop the filing without a word.

// The layout can still be mounting its tiles this early, so an id focused in the
// first moments after load is the restore settling, not a mint.
const HOME_STARTUP_MS = 2000;

// The connection the query keys are scoped by, read without a hook: the value
// useScope answers, so a read here hits the cache the panes filled. The two must
// stay in lockstep, because a divergence reads a cold cache and pays a REST read
// on every mint instead.
const scopeNow = () => host.state?.connectionId?.get?.() ?? "local";

// The registry and the thread listing as the panes last saw them, with one read
// each through the same fetchers the panes use when nothing is cached. Either
// may come back null, and every caller reads that as "arm nothing" rather than
// guessing: filing under a topic the user never chose is worse than leaving a
// draft unfiled.
async function registrySnapshot() {
  const scope = scopeNow();
  const read = (fetcher) => (rest ? fetcher().catch(() => null) : null);
  return {
    threads: queryClient.getQueryData(THREADS_KEY(scope)) ?? (await read(fetchThreads)),
    topics: queryClient.getQueryData(TOPICS_KEY(scope)) ?? (await read(fetchTopics)),
  };
}

// The registry's home, and only a live one. An absent home_id, or one naming an
// entry the registry dropped or archived, answers null: fallbackHome() repairs a
// deletion write, and borrowing it here would file chats under a topic nobody
// picked. An archived home arms nothing because its section leaves the tree, so
// the thread would look lost rather than filed.
const homeTopic = (topics) => {
  const homeId = topics?.home_id;
  if (typeof homeId !== "string" || !homeId) return null;
  const entries = topics.entries ?? [];
  return entries.find((entry) => entry.id === homeId && !entry.archived) ?? null;
};

// Both ids a listed row carries, because focus can report either: the live chain
// tip and the lineage root a binding keys on.
const filedSessionIds = (threads) => {
  const ids = new Set();
  for (const row of threads?.threads ?? []) {
    if (row.session_id) ids.add(row.session_id);
    if (row.lineage_root) ids.add(row.lineage_root);
  }
  return ids;
};

// Arms a chat the app started itself (its New session row, ⌘N, ⌘T).
// Only a chat with no turns qualifies: anything else is a conversation the user
// opened, and filing it under a topic nobody picked is worse than leaving it
// alone. The primary pane's draft never reaches here, because it has no id until
// its send (watchNewThreads handles that), so no turn-count guess is needed.
async function armHomeDefault(sessionId) {
  // A reload nulls `rest` between this call and its reads: arm nothing rather
  // than throwing inside a promise nobody awaits.
  if (rest == null) return;
  const [snapshot, lookup] = await Promise.all([registrySnapshot(), loadTurnLookup()]);
  const entry = homeTopic(snapshot.topics);
  if (!entry) return;
  // The listing already carries it, so it is filed: a branch, a cron thread, or
  // a chat filed by hand. Never a fresh tab of ours.
  if (filedSessionIds(snapshot.threads).has(sessionId)) return;
  // An arm already exists, so a click in this pane is deliberate and owns it: a
  // default must never replace one. This also covers the id-less draft arm,
  // which is set before a mint exists and is what will file it.
  if ($pendingThread.get()) return;
  // An unanswered listing proves nothing at all, and isUnstarted answers false
  // there, so a refused socket arms nothing rather than filing a live chat.
  if (!isUnstarted(lookup, sessionId)) return;
  // The user left the tab while these reads were in flight: the default no
  // longer applies to it.
  if ((host.state?.focusedStoredSessionId?.get?.() ?? null) !== sessionId) return;
  setPendingThread({
    at: Date.now(),
    awaitTurn: true,
    home: true,
    known: null,
    seenId: sessionId,
    sessionId,
    topicId: entry.id,
    topicName: entry.name ?? entry.id,
  });
}

// The newest cached value under a topoi key root, whichever connection scope wrote
// it. register() can prefetch before the gateway publishes its connection id, and
// on a scope mismatch a scope-keyed read would miss the registry for the rest of
// the session: the feature would go inert with no error to chase.
function cachedTopoi(root, scope) {
  const direct = queryClient.getQueryData([...root, scope]);
  if (direct) return direct;
  let newest = null;
  let at = -1;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: root })) {
    const data = query.state?.data;
    if (!data) continue;
    if ((query.state?.dataUpdatedAt ?? 0) > at) {
      at = query.state?.dataUpdatedAt ?? 0;
      newest = data;
    }
  }
  return newest;
}

// The home topic as the Topics pane last saw it, read synchronously. The arm has
// to exist before the send, so it cannot wait on a round trip: a paste and Enter
// beats two RPCs, and an arm that lands after the mint files nothing. The pane is
// uncloseable, so the registry is warm in practice; a cold cache arms nothing,
// which is the same result as no home configured.
const homeTopicFromCache = () => homeTopic(cachedTopoi(["topoi", "topics"], scopeNow()));

// The ids a draft's mint must not be mistaken for, as far as the cache can tell:
// the chats this window has shown, the focused chat, and every thread the listing
// carries. The live session listing can name more, so this is upgraded once the
// arm is set.
function knownFromCache() {
  const ids = new Set(liveChatIds);
  const focused = host.state?.focusedStoredSessionId?.get?.() ?? null;
  if (focused) ids.add(focused);
  for (const id of filedSessionIds(cachedTopoi(["topoi", "threads"], scopeNow()))) {
    ids.add(id);
  }
  return ids;
}

// Arms the primary pane's draft: the surface the sidebar's New session row and
// Alt+N both produce, and the only new-chat door with no id to key on. Its send
// mints the chat, and watchNewThreads (which takes the first id an arm has never
// seen) converts this arm and settles it. Hence no sessionId and no `awaitTurn`:
// there is nothing to wait for until the mint exists.
function armHomeDraft() {
  if (rest == null) return;
  const entry = homeTopicFromCache();
  if (!entry) return;
  // A send can beat even this call, in which case the focus is already the mint
  // and armHomeDefault's eager path is the one that applies.
  if ((host.state?.focusedStoredSessionId?.get?.() ?? null) !== null) return;
  // A click in this pane still wins, and an arm of this same shape is already
  // correct.
  if ($pendingThread.get()) return;
  const at = Date.now();
  setPendingThread({
    at,
    awaitTurn: false,
    home: true,
    known: knownFromCache(),
    seenId: null,
    sessionId: null,
    topicId: entry.id,
    topicName: entry.name ?? entry.id,
  });
  // Upgrade the guard with the live listing, which knows chats the cache does not
  // (a chat closed but never filed). The arm is already live, so a send landing
  // inside this read is still filed correctly.
  void knownSessionIds().then((known) => {
    if (!(known instanceof Set)) return;
    const pending = $pendingThread.get();
    if (!pending || pending.at !== at || pending.sessionId) return;
    setPendingThread({
      ...pending,
      known: new Set([...(pending.known ?? []), ...known]),
    });
  });
}

// Whether the armed home draft has produced its first turn. Two cheap signals
// drive it, the gateway's sessions.changed (the row write that follows a send)
// and a focus change, and neither is a timer, so a parked tab costs nothing and
// files the moment it is used. The event can arrive before the message is
// committed, and then this read sees an empty draft and no further signal comes;
// that costs a late filing rather than a lost one, because the next focus change
// settles it. A signal which arrives during a settle is replayed once, since the
// listing read takes long enough for a send to land inside it.
let settlingHome = false;
let resettleHome = false;
async function settleHomeArm() {
  // Same reload window as armHomeDefault: a nulled `rest` means the plugin is
  // gone, and fileThread would call it on null.
  if (rest == null) return;
  const armed = $pendingThread.get();
  if (!armed?.awaitTurn || !armed.sessionId) return;
  if (settlingHome) {
    resettleHome = true;
    return;
  }
  settlingHome = true;
  try {
    const lookup = await loadTurnLookup();
    const turns = lookup.turns(armed.sessionId);
    if (turns === null || turns === 0) {
      // Nothing sent yet. A parked arm is superseded, not expired: armDraftIfFronted
      // clears one before arming a fresh draft, and watchHomeDefault clears one when a
      // different id is minted and focused. It cannot misfile in the meantime, because
      // watchNewThreads skips any arm that names a sessionId - it can only file the
      // chat it names.
      return;
    }
    // A newer arm (a sidebar click) may have landed while the listing was read.
    // It does not cancel this filing: the arm describes this chat, whose first
    // send did happen, so the topic it named is correct. Only the arm is handed
    // over, which is why the bind goes through fileThread rather than
    // fileAdoptedTab's stillWanted test.
    void fileThread(armed.sessionId, armed.topicId, armed.topicName);
    if ($pendingThread.get() === armed) setPendingThread(null);
  } finally {
    settlingHome = false;
    if (resettleHome) {
      resettleHome = false;
      void settleHomeArm();
    }
  }
}

// Arms the draft when it is genuinely the fronted pane, retrying briefly instead
// of trusting one read. Two things can lag: pane visibility can publish a tick
// after the focus atom does (so the first look misses the draft it is staring at),
// and the registry can be cold, in which case armHomeDraft finds no home. Both are
// bounded re-checks, never a loop, and every attempt re-tests the live focus, so a
// user who has already moved on is left alone.
function armDraftIfFronted(attempt = 0) {
  if (rest == null) return;
  if ((host.state?.focusedStoredSessionId?.get?.() ?? null) !== null) return;
  if (!primaryDraftOnScreen(null)) {
    if (attempt < 2) globalThis.setTimeout(() => armDraftIfFronted(attempt + 1), 80);
    return;
  }
  // A parked default from an earlier mint was a tab nobody typed into, and it would
  // block this surface through armHomeDefault's "an arm already exists" test. One
  // arm at a time, so the newest surface wins.
  const parked = $pendingThread.get();
  // Only a parked home default yields here. A sidebar arm names its own topic, and it is
  // parked waiting for its first turn now, so clearing it would hand the chat to the home
  // default and silently change the topic the user picked.
  if (parked?.awaitTurn === true && parked.home === true) setPendingThread(null);
  if ($pendingThread.get()) return;
  if (!homeTopicFromCache()) {
    if (attempt < 2) globalThis.setTimeout(() => armDraftIfFronted(attempt + 1), 120);
    return;
  }
  armHomeDraft();
}

// Watches focus for a chat id this window has never held. `liveChatIds` is the sole
// test, and it grows only from ids this window has shown, never from a later
// listing, which would make an old chat look like a mint. Seeded at register and
// here from the gateway listing (empty on a refused socket) and the focused chat,
// so a restored window starts holding every id it can see. An id is recorded
// before it is armed, so a declined candidate is never reconsidered and a
// re-focus cannot loop.
function watchHomeDefault() {
  const focusedAtom = host.state?.focusedStoredSessionId;
  if (!focusedAtom?.listen) return () => {};
  // The focused chat's turn flag: a send flips it, which is when the draft stops
  // being a draft. A second signal beside sessions.changed, because that broadcast
  // is a state.db signature with a floor, and the common path (press +, type, send,
  // never switch tabs) has no focus change to settle it. Both edges fire, since the
  // rising one can land before the message commit. A stray edge costs one call:
  // settleHomeArm returns early with no live arm.
  const stopBusy = host.state?.busy?.listen?.(() => {
    void settleHomeArm();
  });
  const start = focusedAtom.get?.() ?? null;
  if (start) liveChatIds.add(start);
  void knownSessionIds().then((ids) => {
    for (const id of ids ?? []) liveChatIds.add(id);
  });
  const settledAfter = Date.now() + HOME_STARTUP_MS;
  // The focus watcher only sees changes, so a reload that lands while the draft is
  // already on screen (the normal state after a plugin reload) would never arm it.
  // One check after the restore settles covers that case.
  const primeDraft = globalThis.setTimeout(() => {
    if ((focusedAtom.get?.() ?? null) !== null) return;
    if ($pendingThread.get() || !primaryDraftOnScreen(null)) return;
    void armHomeDraft();
  }, HOME_STARTUP_MS + 100);
  let last = start;
  const stopFocused = focusedAtom.listen((next) => {
    if (next === last) return;
    last = next;
    // Settled here, where a tile minted earlier has long been docked, rather
    // than on an event which can arrive while one is still mounting. This call
    // suspends on its listing read, so nothing below may clear the arm it is
    // holding: a send-then-switch would lose the filing.
    void settleHomeArm();
    // Nothing focused means the primary pane's draft, the surface the sidebar's
    // New session row and Alt+N both produce. It has no id to key an arm on, so the
    // arm is id-less; watchNewThreads runs first (registered before this watcher),
    // converts it and settles it, which is the step that actually files the thread.
    // Only when the draft is the fronted pane: a focus-clear behind a page or a
    // tool panel is not a new chat.
    if (!next) {
      if (Date.now() >= settledAfter) armDraftIfFronted();
      return;
    }
    // Visited ids are never reconsidered, so a declined candidate cannot come
    // back as a mint and a re-focus cannot loop.
    const seen = liveChatIds.has(next);
    liveChatIds.add(next);
    if (Date.now() < settledAfter) return;
    if (seen || ownChatIds.has(next)) {
      // An id-less arm is only honest while the draft is fronted. Left alive
      // through a move to a chat this window already knew, it would sit waiting
      // for the next unseen id and file that one under the home topic.
      const stale = $pendingThread.get();
      if (stale && stale.home === true && !stale.sessionId) setPendingThread(null);
      return;
    }
    // A parked default never outlives a newer mint. This mint's own arm is the
    // exception: watchNewThreads runs first and may have just converted the id-less
    // draft arm into a parked one naming `next`, so clearing that here would drop
    // the filing it exists for. Only a different id is superseded.
    const parked = $pendingThread.get();
    if (parked?.awaitTurn === true && parked.sessionId !== next) setPendingThread(null);
    // A click in this pane always wins over a default. An id-less draft arm sitting
    // here is expected: it is what files this mint, through watchNewThreads.
    if ($pendingThread.get()) return;
    void armHomeDefault(next);
  });
  // Both listeners plus the primer come back through ctx.onDispose: a reload that
  // left them live would keep calling into a dead module instance.
  return () => {
    globalThis.clearTimeout(primeDraft);
    stopFocused();
    stopBusy?.();
  };
}

// ---- the pane ----------------------------------------------------------------

// The composer's top strip, naming the topic the focused chat will be filed
// under: the chat itself carries no such mark. An arm that names a chat shows
// while that chat is focused; the id-less draft arm shows while nothing is
// focused, so neither follows the user into another chat.
function ArmBanner() {
  const pending = useValue($pendingThread);
  const focused = useValue(host.state.focusedStoredSessionId);
  const onTarget = pending?.sessionId ? focused === pending.sessionId : focused == null;
  if (!pending || !onTarget) {
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

// The row age, the builtin session row's compact spelling: under a minute
// reads "now", then 5m / 2h / 3d. coarseElapsed owns the buckets (the SDK's
// relativeTime renders "3 days ago", which is for scheduled next-runs, not
// row ages).
const AGE_SUFFIX = { day: "d", hour: "h", minute: "m" };

const formatAge = (seconds) => {
  const { unit, value } = coarseElapsed(Date.now() - seconds * 1000);
  return unit === "second" ? "now" : `${value}${AGE_SUFFIX[unit]}`;
};

// One cron result as a document: a mirrored run thread's brief, or a run's own
// final answer, rendered with the same Markdown pipeline core chat uses. The
// composer's absence is deliberate - a run is not a conversation. Reply hands
// the seeded session to core's chat, and exists only when the backend proved
// the mirror (a delivery row plus a live, keyed seed).
function CronReader({ thread }) {
  const scope = useScope();
  const sessionId = thread?.session_id;
  const query = useQuery({
    enabled: Boolean(sessionId) && Boolean(rest),
    queryFn: () => fetchCronResult(sessionId),
    queryKey: ["topoi", "cron", scope, sessionId],
    staleTime: 5_000,
  });
  const doc = query.data;
  const when = thread?.last_active;
  const reply = () => {
    if (!doc?.replyable || !doc.reply_session_id) return;
    // Core's focus moves to the seeded session and the chat tab takes the
    // zone's active slot, so the reader's band moves off on its own. The
    // reader tab stays open behind the chat: nothing to clear here.
    host
      .openSession(doc.reply_session_id, { intent: "tab" })
      .catch((error) => host.notifyError(error, "Could not open the thread"));
  };
  return jsxs("div", {
    className: "topoi-reader",
    children: [
      jsxs("div", {
        className: "topoi-reader-head",
        children: [
          jsx("span", {
            className: "topoi-reader-title",
            children: doc?.title || thread?.title || "Cron result",
          }),
          doc?.replyable
            ? jsx(Button, {
                className: "topoi-reader-reply",
                onClick: reply,
                size: "sm",
                children: [jsx(Codicon, { name: "comment-discussion", size: "0.875rem" }), "Reply"],
              })
            : null,
          when
            ? jsx("span", {
                className: "topoi-reader-when",
                children: formatAge(when),
              })
            : null,
        ],
      }),
      jsx("div", {
        className: "topoi-reader-body",
        children: query.isLoading
          ? jsx("div", { className: "topoi-reader-note", children: "Loading..." })
          : query.error || !doc
            ? jsx("div", {
                className: "topoi-reader-note",
                children: "This result could not be read. It may have been deleted.",
              })
            : doc.markdown
              ? jsx("div", {
                  className: "topoi-reader-markdown",
                  children: jsx(MessageTextContent, { text: doc.markdown }),
                })
              : jsx("div", {
                  className: "topoi-reader-note",
                  children: "This result is empty.",
                }),
      }),
    ],
  });
}

// One thread row, shaped like the builtin sidebar's session row: the date sits
// in a column that never shrinks while the title truncates against it, and a
// status row reserves the dot's cell ahead of the title, so a thread going
// quiet keeps its text still. The dot is core's SessionStatusDot, keyed by the
// thread's stored session id. The sidebar copy carries the app's session
// statuses (the open band and the dot); the topic tab keeps the delete action
// and nothing else.
function ThreadRow({
  deletable = false,
  entries = [],
  hint = null,
  onOpen,
  showStatus = false,
  thread,
}) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const focused = useValue(host.state.focusedStoredSessionId);
  const title = thread.title || thread.session_id;
  // The REST surface ships epoch SECONDS; the age label buckets them app-side.
  const seconds = thread.last_active || thread.started_at;
  const when = seconds ? formatAge(seconds) : null;
  // A thread carries its live tip (session_id) and its lineage root; the
  // focused id and the status map can hold either, so match both.
  // The open band follows the FRONT TAB, not the focus: a cron reader and a chat
  // tile share the workspace zone, and core's focused session keeps pointing at
  // the chat while the reader is fronted - so a focus test alone lit the chat
  // row and the reader row at once (switching tabs cleared neither).
  const readerIds = useValue($cronReaderIds);
  const isReader = readerIds.has(thread.session_id);
  const focusHit =
    focused != null && (thread.session_id === focused || thread.lineage_root === focused);
  // Only rows that CAN be lit subscribe to the layout: the reader's own tab
  // while it is the result being read, and the focused chat's panes (the
  // primary `workspace` chat or its `session-tile:<id>` stack entry).
  const readerTab = useValue(
    isReader ? paneTab(`plugin-workspace:cron-${thread.session_id}`) : NO_TAB,
  );
  const primaryTab = useValue(focusHit ? paneTab("workspace") : NO_TAB);
  const tileTab = useValue(focusHit ? paneTab(`session-tile:${thread.session_id}`) : NO_TAB);
  const rootTab = useValue(
    focusHit && thread.lineage_root ? paneTab(`session-tile:${thread.lineage_root}`) : NO_TAB,
  );
  const readable = paneTabsReadable();
  // Several readers can be open at once, so every row asks about its OWN tab.
  // A doorless host cannot say which of them is in front, so the reader opened
  // last keeps the band there (the old single-id rule).
  const reading = readable
    ? isReader && readerTab
    : isReader && [...readerIds].at(-1) === thread.session_id;
  const fronted = !readable || primaryTab || tileTab || rootTab;
  const opened = showStatus && (reading || (focusHit && fronted));
  // The move sub's targets: every registry entry but the thread's own topic
  // (moving to the same one is a no-op, so it is not offered). A cron result has
  // no move to offer: its topic is the adapter-minted chat_id, and resolution
  // returns that before any binding, so a re-file could never take effect.
  const others = thread.cron_result ? [] : entries.filter((item) => item.id !== thread.topic_id);
  // Core's own dot, keyed by the thread's stored session id: the same primitive
  // the builtin sidebar and the pane tabs render, so a thread can never disagree
  // with them about what it is doing. It resolves idle, draft and every live
  // state itself, and paints an idle mark rather than leaving the cell empty.
  // Deliberately no lineage_root fallback: the store is keyed by the stored id,
  // and the root is the binding key, so a branch row would inherit its parent's
  // status. The import is a hard requirement rather than a feature test: the
  // runtime shim re-exports the SDK by name, so a build without this primitive
  // cannot satisfy it.
  const dot = showStatus
    ? jsx(SessionStatusDot, { storedSessionId: thread.session_id ?? null })
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
              onClick: () => onOpen(thread),
              // A search hit's matched line, on the row's own tooltip: the row
              // keeps its title-and-date shape, and the answer to "why did this
              // match?" is one hover away.
              title: hint || undefined,
              type: "button",
              children: [
                showStatus && jsx("span", { className: "topoi-lead", children: dot }),
                jsx("span", { className: "topoi-row-title", children: title }),
                when && jsx("span", { className: "topoi-row-time", children: when }),
              ],
            }),
          }),
          jsxs(ContextMenuContent, {
            children: [
              jsx(ContextMenuItem, {
                onSelect: () => openThread(thread, "tab"),
                children: [jsx(Codicon, { name: "browser", size: "0.875rem" }), "Open in new tab"],
              }),
              jsx(ContextMenuItem, {
                onSelect: () => openThread(thread, "window"),
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
                      children: [jsx(Codicon, { name: "move", size: "0.875rem" }), "Move to topic"],
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

// A topic's head row: the name opens the topic tab, and the check, the caret and
// the + (a new chat filed under this topic) sit at the right of the name and
// reveal on hover, the builtin sidebar's section affordance. The label keeps the
// pane's own text colour and case.
function SectionHead({ entry, expanded, markable, marking, onMarkRead, onOpenTopic, onToggle }) {
  return jsxs("div", {
    className: "topoi-section-head",
    children: [
      jsxs("button", {
        className: "topoi-topic",
        onClick: onOpenTopic,
        title: "Open topic",
        type: "button",
        children: [
          // The head reserves the rows' own lead cell, so a topic's name and the
          // titles under it share one left edge instead of the rows starting
          // 20px in from their own header. The cell is empty on purpose: the
          // class carries a fixed width, so the label keeps its column whether
          // or not anything paints here.
          jsx("span", { className: "topoi-lead" }),
          jsx("span", { className: "topoi-topic-label", children: entry?.name ?? entry?.id }),
        ],
      }),
      // Marks the rows this section is showing, never the topic's whole history:
      // the ids come from the same visible slice the tree renders, so the button
      // can never clear a thread nobody can see. Mounted even with nothing to
      // mark, so the caret and the + sit at one x across every section.
      jsx("button", {
        "aria-busy": marking || undefined,
        "aria-label": `Mark all threads in ${entry?.name ?? entry?.id} as read`,
        className: "topoi-section-read",
        disabled: !markable || Boolean(marking),
        onClick: onMarkRead,
        title: markable ? "Mark all as read" : "No threads to mark",
        type: "button",
        children: jsx(Codicon, { name: "check", size: "0.75rem" }),
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
        onClick: () => void startNewThread(entry),
        title: "New thread",
        type: "button",
        children: jsx(Codicon, { name: "add", size: "0.75rem" }),
      }),
    ],
  });
}

// A thread's activity stamp in epoch milliseconds. The REST surface ships
// SECONDS; a row with neither stamp reads as undated, never as ancient.
const threadStamp = (thread) => {
  const seconds = thread.last_active || thread.started_at || 0;
  return seconds * 1000;
};

const isRecentThread = (thread, now) => {
  const stamp = threadStamp(thread);
  return stamp === 0 || now - stamp < PANE_ACTIVE_MS;
};

// The rows a section actually shows. Both read buttons mark this set, so neither can
// clear a row the tree does not render, and the cap is applied in one place.
const visibleThreads = (threads, now) =>
  (threads ?? [])
    .filter((thread) => isRecentThread(thread, now))
    .slice(0, SECTION_THREADS);

function TopicSection({ entries, entry, expanded, onOpenTopic, onToggle, threads }) {
  const now = Date.now();
  // Recent threads only, and never more than SECTION_THREADS of them: older
  // rows and the overflow live in the topic tab, which the head opens.
  const shown = visibleThreads(threads, now);
  // Section-local pending, independent of the global button's: `markRows` is called
  // directly rather than through the tree's handler, so marking one topic never
  // leaves the double-check disabled.
  const [marking, setMarking] = useState(false);
  const markShown = async () => {
    if (marking) return;
    setMarking(true);
    try {
      await markRows(shown);
    } finally {
      setMarking(false);
    }
  };
  return jsxs("div", {
    className: "topoi-section",
    children: [
      jsx(SectionHead, {
        entry,
        expanded,
        // The rows this section owns, cap and recency applied, whatever the fold is
        // doing: a collapsed topic still has a mark to clear, and the button stays
        // reachable from the keyboard while it is enabled.
        markable: shown.length > 0,
        marking,
        onMarkRead: () => void markShown(),
        onOpenTopic: onOpenTopic ? () => onOpenTopic(entry) : undefined,
        onToggle,
      }),
      expanded &&
        shown.map((thread) =>
          jsx(ThreadRow, {
            entries,
            key: thread.lineage_root,
            onOpen: (row) => openThread(row, "in-place"),
            showStatus: true,
            thread,
          }),
        ),
    ],
  });
}

// One whole-set search. The key sits under the ["topoi","threads"] prefix on
// purpose: both existing invalidations (`["topoi"]` and `["topoi","threads"]`)
// then refresh a live search for free, so a bind never leaves stale hits.
const THREAD_SEARCH_KEY = (scope, needle) => [
  "topoi",
  "threads",
  scope,
  "search",
  needle,
];
const fetchThreadSearch = (needle) =>
  rest(`/threads?limit=${SEARCH_LIMIT}&offset=0&q=${encodeURIComponent(needle)}`);

// A build that predates the unread acks gets told once instead of failing quietly.
let missingAckWarned = false;
const warnMissingAck = () => {
  if (missingAckWarned) return;
  missingAckWarned = true;
  console.warn("[topoi] read mark: this desktop build exposes no unread ack; dots will lag");
  host.notify({
    kind: "error",
    message: "Marked read, but this desktop build cannot clear the dots.",
  });
};

// The dot has three sources: the watermark the route clears, a per-profile seen count,
// and two renderer sets (durable unread markers plus a transient one for a session that
// finished off screen). Core owns the last two, so ack through its own functions:
// ackStoredSessionId matches the row by any lineage id, while forgetSessionUnread matches
// bucket keys exactly and so needs the durable root as well as the tip.
const ackLocalRead = (rows) => {
  const ack = typeof pluginSdk.ackStoredSessionId === "function" ? pluginSdk.ackStoredSessionId : null;
  const forget =
    typeof pluginSdk.forgetSessionUnread === "function" ? pluginSdk.forgetSessionUnread : null;
  if (!ack && !forget) {
    // One-shot, user-visible: an absent export is otherwise indistinguishable from an
    // ack that ran and did not help, and that ambiguity is what makes this take rounds.
    warnMissingAck();
    return;
  }
  const list = rows ?? [];
  for (const thread of list) {
    if (thread?.session_id && ack) {
      try {
        // No profile hint: the dot resolves through the active gateway profile, so
        // omitting it acks the same bucket the dot paints from.
        ack(thread.session_id);
      } catch {
        // An id core has no row for is core's to ignore - the watermark already landed.
      }
    }
  }
  const candidates = list
    .flatMap((thread) => [thread?.session_id, thread?.lineage_root])
    .filter(Boolean);
  if (forget && candidates.length > 0) {
    try {
      forget(candidates);
    } catch {
      // Same rule: a stale id must never break the mark that already succeeded.
    }
  }
};

// The one write both read buttons share: mark the rows, refetch, and report a
// partial when the backend could not write every id.
async function markRows(rows) {
  const list = rows ?? [];
  // Only the rows that still carry a dot: each one costs a fenced write, and a row
  // already read would be written again for nothing. An absent flag counts as
  // unread, so a build whose rows predate `unread` marks what it always marked
  // instead of silently marking nothing.
  const targets = list.filter((thread) => thread?.unread !== false && thread?.session_id);
  const ids = targets.map((thread) => thread.session_id);
  if (ids.length === 0) {
    // Nothing needs writing, but a row the backend calls read can still paint a
    // finished marker from this renderer, and only this client can clear it.
    ackLocalRead(list);
    return;
  }
  try {
    const result = await markThreadsRead(ids);
    // The ack covers the whole scope, not the written rows: `unread` is the backend
    // watermark, so a read row can still hold a finished marker.
    ackLocalRead(list);
    // Awaited so a caller's pending state spans the repaint, not just the POST.
    await queryClient.invalidateQueries({ queryKey: ["topoi"] });
    if (result && result.ok === false) {
      host.notify({ kind: "error", message: `Marked ${result.marked} of ${ids.length} threads.` });
    }
  } catch (error) {
    host.notifyError(error, "Could not mark the rows as read");
  }
}

// The pane's pinned row: whole-set search plus the global read mark. A sibling of the
// scroll box rather than a sticky child, so it is pinned by layout and needs no
// background or z-index to stay put.
function SearchRow({ markDisabled, marking, onClear, onMarkAll, onTyped, typed }) {
  return jsxs("div", {
    className: "topoi-find",
    onKeyDown: (event) => {
      if (event.key !== "Escape") return;
      if (typed) onClear();
      else event.target?.blur?.();
    },
    role: "search",
    children: [
      jsx(Input, {
        "aria-label": "Search all threads",
        className: "topoi-find-field",
        onChange: (event) => onTyped(event.target.value),
        placeholder: "Search all threads",
        value: typed,
      }),
      typed &&
        jsx("button", {
          "aria-label": "Clear search",
          className: "topoi-find-button",
          onClick: onClear,
          title: "Clear search",
          type: "button",
          children: jsx(Codicon, { name: "close", size: "0.75rem" }),
        }),
      // The double check marks every row the pane is showing - the union of each
      // section's visible slice, or the hits while a search is up.
      jsx("button", {
        "aria-busy": marking || undefined,
        "aria-label": "Mark all as read",
        className: "topoi-find-button",
        disabled: Boolean(marking) || Boolean(markDisabled),
        onClick: onMarkAll,
        title: markDisabled ? "No rows to mark" : "Mark all as read",
        type: "button",
        children: jsx(Codicon, { name: "check-all", size: "0.75rem" }),
      }),
    ],
  });
}

// A result group's head: a label and a count, no controls. SectionHead is the wrong
// shape here, since its caret and + have nothing to fold or file on results, and
// reusing it would tempt a fold-map write from a search. The wrapper copies
// `.topoi-topic`'s own box so a group label lands on the same left edge as the topic
// labels above and below it.
function SearchGroupHead({ count, entry }) {
  return jsx("div", {
    className: "topoi-section-head",
    children: jsxs("span", {
      className: "topoi-search-head",
      children: [
        jsx("span", { className: "topoi-lead" }),
        jsx("span", { className: "topoi-search-name", children: entry?.name ?? entry?.id }),
        jsx("span", { className: "topoi-count", children: count }),
      ],
    }),
  });
}

// Hits replace the tree while a needle is up. Results never read or write the fold
// map, and they bypass both the SECTION_THREADS cap and the recency window, so an
// old transcript hit is visible instead of matched-but-hidden.
function SearchResults({ entries, error, groups, loading, needle, total }) {
  // Counted from the groups, not the raw hit list: a hit whose topic is no longer a
  // live entry is dropped by groupThreads, so a raw count would promise rows that no
  // group renders.
  const shown = groups.reduce((count, group) => count + group.threads.length, 0);
  if (error) {
    return jsx("div", {
      className: "topoi-note",
      children: "The topoi backend could not be reached.",
    });
  }
  if (loading) return jsx(EmptyState, { title: "Searching" });
  if (groups.length === 0) {
    return jsx(EmptyState, {
      description: `No thread in a topic mentions "${needle}", in any message.`,
      title: "No matches",
    });
  }
  return jsxs("div", {
    children: [
      groups.map((group) =>
        jsxs(
          "div",
          {
            className: "topoi-section",
            children: [
              jsx(SearchGroupHead, { count: group.threads.length, entry: group.entry }),
              group.threads.map((thread) =>
                jsx(ThreadRow, {
                  entries,
                  // A transcript hit carries its matched line; a title-only match
                  // has none, and the row leaves the tooltip off.
                  hint: thread.match,
                  key: thread.lineage_root,
                  onOpen: (row) => openThread(row, "in-place"),
                  showStatus: true,
                  thread,
                }),
              ),
            ],
          },
          group.entry.id,
        ),
      ),
      total > shown &&
        jsx("div", {
          className: "topoi-note",
          children: `Showing ${shown} of ${total}`,
        }),
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
  // Fold state is a per-machine preference and survives a reload. The map holds
  // folded ids only: absence means open, so a fresh install starts with every topic
  // expanded and the map stays small. An older map still reads correctly (a stored
  // `false` is folded, a stored `true` is open under `!== false`), so no migration.
  const [expanded, setExpanded] = useState(() => storage?.get("expanded", {}) ?? {});
  const [typed, setTyped] = useState("");
  const [needle, setNeedle] = useState("");
  const [marking, setMarking] = useState(false);
  // A keystroke is not a query: the field follows every character, the request
  // waits out the same gap the topic tab's search uses. The row stays mounted
  // through the error and loading states, so a dead backend never takes the field
  // away while it is being typed in.
  useEffect(() => {
    const next = typed.trim();
    if (next.length < SEARCH_MIN_CHARS) {
      setNeedle("");
      return undefined;
    }
    const timer = setTimeout(() => setNeedle(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const searching = needle.length >= SEARCH_MIN_CHARS;
  const searchQuery = useQuery({
    // One character is a whole-listing scan for nothing.
    enabled: searching,
    // The last answer stays painted while the next lands, so typing never blanks
    // the pane for a round trip.
    placeholderData: (previous) => previous,
    queryFn: () => fetchThreadSearch(needle),
    queryKey: THREAD_SEARCH_KEY(scope, needle),
    staleTime: 0,
  });

  const entries = topicsQuery.data?.entries ?? [];
  const threads = threadsQuery.data?.threads ?? [];
  const groups = groupThreads(entries, threads);
  const now = Date.now();
  // The union of every section's visible slice. Fold-independent: a folded section still
  // owns its rows, the same way its own check stays live, and an all-folded tree must not
  // leave the global button disabled.
  const visibleRows = groups.flatMap((group) => visibleThreads(group.threads, now));
  const hits = searchQuery.data?.threads ?? [];
  // An empty head per registry entry is the tree's shape; a result list shows only the
  // topics that matched.
  const hitGroups = groupThreads(entries, hits).filter((group) => group.threads.length > 0);
  // What a search actually renders: `hits` minus any row whose topic is no longer a
  // live entry, which groupThreads drops. Counting raw hits would enable the button
  // over a row nobody can see, while the body says "No matches".
  const shownHits = hitGroups.flatMap((group) => group.threads);
  const failed = Boolean(topicsQuery.error || threadsQuery.error);
  const loading = topicsQuery.isLoading || threadsQuery.isLoading;
  const markVisible = async (rows) => {
    if (marking) return;
    setMarking(true);
    try {
      await markRows(rows);
    } finally {
      setMarking(false);
    }
  };
  // Absence means open, so the map is the exception list rather than a state for
  // every topic. `current` is the value inside the updater, never the render's
  // `expanded`, or a burst of clicks would fold from a stale read. Opening deletes
  // the key, which keeps the map one-way and small.
  const isOpen = (id) => expanded[id] !== false;
  const toggle = (id) =>
    setExpanded((current) => {
      const next = { ...current };
      if (current[id] !== false) next[id] = false;
      else delete next[id];
      storage?.set("expanded", next);
      return next;
    });

  // The tree keeps its shipped shape: one TopicSection per registry entry, then
  // the zero-thread state. Keyed by topic id, because TopicSection holds its own
  // pending state.
  const tree = [
    groups.map((group) =>
      jsx(
        TopicSection,
        {
          entries,
          entry: group.entry,
          expanded: isOpen(group.entry.id),
          onOpenTopic: openTopicTab,
          onToggle: () => toggle(group.entry.id),
          threads: group.threads,
        },
        group.entry.id,
      ),
    ),
    threads.length === 0 &&
      jsx(
        EmptyState,
        {
          description: "Threads show up here once a chat is added to a topic.",
          title: "No threads yet",
        },
        "empty",
      ),
  ];

  // The pinned row is a sibling of the scroll box, so it never scrolls with the tree.
  // The body branches: hits while a needle is up, the tree otherwise, and the error and
  // loading states render inside the scroll area rather than replacing the pane, so a
  // dead backend does not take the search field away with it.
  const body = searching
    ? jsx(SearchResults, {
        entries,
        error: searchQuery.error,
        groups: hitGroups,
        loading: Boolean(searchQuery.isLoading && !searchQuery.data),
        needle,
        total: searchQuery.data?.total ?? hits.length,
      })
    : failed
      ? jsx(EmptyState, {
          description:
            "The topoi backend could not be reached. Check that the plugin is enabled on the gateway.",
          title: "Topics unavailable",
        })
      : loading
        ? jsx(EmptyState, { title: "Loading topics" })
        : tree;

  return jsxs("div", {
    className: "topoi-tree",
    children: [
      // Visible rows only, matching the per-topic check. While a search is up the tree
      // is replaced by results, so the rendered hits are what the pane shows then. A
      // failed listing renders no rows at all, so it disables rather than acting on
      // cached data.
      jsx(SearchRow, {
        // A failed search keeps its old hits as `placeholderData`, so the error gate
        // is what stops this enabling over rows the body has already replaced.
        markDisabled:
          failed ||
          Boolean(searching && searchQuery.error) ||
          (searching ? shownHits.length : visibleRows.length) === 0,
        marking,
        onClear: () => setTyped(""),
        onMarkAll: () => void markVisible(searching ? shownHits : visibleRows),
        onTyped: setTyped,
        typed,
      }),
      jsx(ScrollArea, { className: "topoi-scroll", children: body }),
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
  // Whole-state, last-writer-wins registry writes, painted before they are sent:
  // one write is on the wire at a time and the newest request wins, so a burst of
  // moves can never interleave two writes. `confirmed` is the last registry the
  // server stored and the revert target; `pending` the newest unsent request.
  const confirmed = useRef(null);
  const pending = useRef(null);
  const draining = useRef(null);

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

  // The server's own copy is the revert target: the query's own answers seed it,
  // and a successful write while nothing is queued keeps it current.
  useEffect(() => {
    if (data && !pending.current && !draining.current) confirmed.current = data;
  }, [data]);

  // The registry as the cache holds it, which is what a click builds on: the
  // optimistic paint lands there first, so two clicks in one frame still chain.
  const registry = () => qc.getQueryData(TOPICS_KEY(scope)) ?? { entries, home_id: homeId };

  const paint = (next) => qc.setQueryData(TOPICS_KEY(scope), next);

  // The write loop. A refused write drops the queue and puts the page back on the
  // last registry the server confirmed, so the order the user saw reverted and the
  // toast carries the reason.
  const flush = () => {
    if (draining.current) return draining.current;
    const task = (async () => {
      let failed = false;
      try {
        while (pending.current) {
          const { label, payload } = pending.current;
          pending.current = null;
          try {
            const stored = await putTopics(payload);
            confirmed.current = stored ?? payload;
            // A newer click already painted its own order: keep it.
            if (!pending.current) paint(confirmed.current);
          } catch (err) {
            failed = true;
            pending.current = null;
            host.notifyError(err, label);
            if (confirmed.current) paint(confirmed.current);
          }
        }
      } finally {
        draining.current = null;
      }
      // Threads and topic tabs come from the same writes (a delete prunes its
      // bindings, archive drops a listing), so one refetch closes the round.
      if (!failed) qc.invalidateQueries({ queryKey: ["topoi"] });
      return !failed;
    })();
    draining.current = task;
    return task;
  };

  // Paint first, send after: the rows land where the click asked for them in the
  // same frame, and the PUT is what catches up behind them.
  const save = (next, label = "Could not save topics") => {
    const current = registry();
    const target = {
      entries: next.entries ?? current.entries ?? [],
      home_id: next.home_id ?? current.home_id,
    };
    paint(target);
    pending.current = { label, payload: target };
    return flush();
  };

  const addTopic = () => {
    const name = newName.trim();
    const id = newId.trim();
    // The id is the locked prefix plus the user's suffix; a bare t_ is not an id.
    if (!name || id.length <= ID_PREFIX.length || topicIdProblem(id, entries)) return;
    setNewName("");
    setNewId(ID_PREFIX);
    return save({ entries: [...(registry().entries ?? []), { id, name }] });
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
    const list = registry().entries ?? [];
    const entry = list.find((item) => item.id === id);
    if (entry && entry.name === name) return;
    return save({
      entries: list.map((item) => (item.id === id ? { ...item, name } : item)),
    });
  };

  const toggleArchive = (id) =>
    save({
      entries: (registry().entries ?? []).map((item) => {
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

  // A reorder is optimistic: the rows swap in the click's own frame and the PUT
  // follows in the background, so rapid clicks chain on the painted order.
  const move = (id, direction) => {
    const list = registry().entries ?? [];
    const index = list.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    return save({ entries: next }, "Could not reorder topics");
  };

  const removeTopic = async (entry) => {
    const remaining = (registry().entries ?? []).filter((item) => item.id !== entry.id);
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
    runAction = typeof ctx.runAction === "function" ? ctx.runAction : null;
    ctx.onDispose(() => {
      // The atom only, so PENDING_THREAD_KEY survives: the durable mirror is what
      // lets a reload or a plugin swap restore an in-flight arm, which
      // restorePendingThread reads. setPendingThread would clear the key too.
      $pendingThread.set(null);
      rest = null;
      storage = null;
      runAction = null;
    });
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    ctx.onDispose(() => style.remove());

    // An arm a previous session persisted survives the restart or reload
    // that brought this register() back.
    restorePendingThread();

    // The home default's exclusion set, seeded before the first arm can read it:
    // armHomeDefault reads it through knownFromCache on the very first mint, which
    // can precede watchHomeDefault's first listing read.
    const focusedAtLoad = host.state?.focusedStoredSessionId?.get?.() ?? null;
    if (focusedAtLoad) liveChatIds.add(focusedAtLoad);
    void knownSessionIds().then((ids) => {
      for (const id of ids ?? []) liveChatIds.add(id);
    });

    // The home default arms the primary draft from the cache, because the arm has
    // to exist before a send can beat it. Warm both keys here so a collapsed
    // Topics column - which never mounts the pane's queries - can still default a
    // chat, and so watchNewThreads' "already filed" guard has a listing to read.
    if (rest) {
      for (const [queryKey, queryFn] of [
        [TOPICS_KEY(scopeNow()), fetchTopics],
        [THREADS_KEY(scopeNow()), fetchThreads],
      ]) {
        void queryClient.prefetchQuery({ queryKey, queryFn, staleTime: 30_000 }).catch(() => {});
      }
    }

    // Registry changes arrive over the gateway event stream; thread lists and
    // open topic tabs refresh on the gateway's own sessions.changed. Bindings
    // need no event: they resolve server-side on every /threads read.
    ctx.onEvent("plugin.topoi.topics.changed", () =>
      queryClient.invalidateQueries({ queryKey: ["topoi"] }),
    );
    ctx.onEvent("sessions.changed", () => {
      queryClient.invalidateQueries({ queryKey: ["topoi", "threads"] });
      queryClient.invalidateQueries({ queryKey: ["topoi", "topic"] });
      queryClient.invalidateQueries({ queryKey: ["topoi", "cron"] });
      // Only the armed chat's own movement settles it: this event fires for every
      // session in the house, cron traffic included, and each stray call would be
      // two reads for nothing. A send-then-switch is covered by the focus
      // listener's own departed settle.
      const armed = $pendingThread.get();
      const focusedNow = host.state?.focusedStoredSessionId?.get?.() ?? null;
      if (armed?.awaitTurn && armed.sessionId === focusedNow) void settleHomeArm();
    });

    ctx.onDispose(watchNewThreads());
    ctx.onDispose(watchHomeDefault());
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
