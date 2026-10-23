/**
 * Topoi dashboard plugin - topics tab and card.
 *
 * Manages the topic registry (create, rename, reorder, archive, delete, set home),
 * a Recent Threads card that groups the listed threads by topic, and a compact
 * topic overview with thread counts above the dashboard's session list.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;

  const { React } = SDK;
  const e = React.createElement;
  const { useState, useEffect, useCallback, useMemo, useRef } = SDK.hooks;
  const { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Input } =
    SDK.components;
  const { timeAgo } = SDK.utils;

  const API = "/api/plugins/topoi";
  const FALLBACK_HOME = "t_system";
  const RECENT_PER_TOPIC = 4;
  const THREAD_PAGE = 500;

  // Extract human-readable error messages:
  // fetchJSON throws Error("<status>: <raw body>") and FastAPI responds with {"detail": "<message>"}
  function parseApiErrorMessage(err) {
    const raw = err && err.message ? String(err.message) : String(err || "");
    const match = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
    const body = match ? match[2] : raw;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.detail === "string") return parsed.detail;
    } catch {
      /* not JSON, fall through to the raw body */
    }
    return body || raw;
  }

  // Topic ids are set by the user at creation and never edited afterwards
  // (CONTRACT.md section 1). The t_ prefix is locked into the field: the user
  // types the suffix and cannot remove or alter the prefix.
  const ID_PREFIX = "t_";
  function topicIdProblem(id, entries) {
    if (!/^t_[a-z0-9_]+$/.test(id)) {
      return "After t_, use lowercase letters, digits and underscores.";
    }
    if (entries.some(function (entry) {
      return entry.id === id;
    })) {
      return "A topic with that id already exists.";
    }
    return "";
  }

  // Promise-based confirm over the host's ConfirmDialog so a call site reads
  // as confirm.ask({...}).then(function (ok) { ... }).
  function useConfirm() {
    const [request, setRequest] = useState(null);
    const resolver = useRef(null);
    const ask = useCallback(function (spec) {
      return new Promise(function (resolve) {
        resolver.current = resolve;
        setRequest(spec);
      });
    }, []);
    const settle = useCallback(function (ok) {
      const resolve = resolver.current;
      resolver.current = null;
      setRequest(null);
      if (resolve) resolve(ok);
    }, []);
    const dialogProps = useMemo(
      function () {
        if (!request) return null;
        return {
          open: true,
          title: request.title,
          description: request.description,
          confirmLabel: request.confirmLabel || "Confirm",
          destructive: true,
          onConfirm: function () {
            settle(true);
          },
          onCancel: function () {
            settle(false);
          },
        };
      },
      [request, settle],
    );
    return { ask: ask, dialogProps: dialogProps };
  }

  // Rebuild an entry without its archived flag; the store normalizes a false
  // archived away anyway, but sending the key only when true keeps the wire
  // shape honest.
  function entryArchived(entry, archived) {
    const next = { id: entry.id, name: entry.name };
    if (archived) next.archived = true;
    return next;
  }

  function entryNamed(entry, name) {
    const next = { id: entry.id, name: name };
    if (entry.archived) next.archived = true;
    return next;
  }

  // Where home_id goes when the home topic is deleted: the first live entry,
  // else the default home id. A removed topic must never stay the home.
  function fallbackHome(entries) {
    const live = entries.filter(function (e) {
      return !e.archived;
    });
    const pool = live.length > 0 ? live : entries;
    return pool.length > 0 ? pool[0].id : FALLBACK_HOME;
  }

  // Every glyph is imported from the official lucide package on the esm.sh
  // CDN: the plugin SDK exposes no icon surface (its components map is DS
  // primitives only), so the bundle fetches icon nodes at runtime instead of
  // carrying path data. lucide 0.577.0 is the version the dashboard host
  // itself ships, and the vanilla package exports dependency-free icon nodes,
  // so no second React copy comes along. A failed import simply leaves its
  // spot empty. Icons render at 12px, which the DS Button's own
  // [&>svg]:size-3 rule also enforces inside the row actions.
  const ICON_URLS = {
    star: "https://esm.sh/lucide@0.577.0/dist/esm/icons/star.js",
    package: "https://esm.sh/lucide@0.577.0/dist/esm/icons/package.js",
    "arrow-up": "https://esm.sh/lucide@0.577.0/dist/esm/icons/arrow-up.js",
    "arrow-down": "https://esm.sh/lucide@0.577.0/dist/esm/icons/arrow-down.js",
    pencil: "https://esm.sh/lucide@0.577.0/dist/esm/icons/pencil.js",
    house: "https://esm.sh/lucide@0.577.0/dist/esm/icons/house.js",
    archive: "https://esm.sh/lucide@0.577.0/dist/esm/icons/archive.js",
    "archive-restore": "https://esm.sh/lucide@0.577.0/dist/esm/icons/archive-restore.js",
    "trash-2": "https://esm.sh/lucide@0.577.0/dist/esm/icons/trash-2.js",
    check: "https://esm.sh/lucide@0.577.0/dist/esm/icons/check.js",
    x: "https://esm.sh/lucide@0.577.0/dist/esm/icons/x.js",
  };

  const iconNodes = {};

  function loadIconNode(name) {
    if (!iconNodes[name]) {
      iconNodes[name] = import(ICON_URLS[name])
        .then(function (mod) {
          return mod.default;
        })
        .catch(function () {
          return null;
        });
    }
    return iconNodes[name];
  }

  function Icon(props) {
    const [node, setNode] = useState(null);
    useEffect(
      function () {
        let alive = true;
        loadIconNode(props.name).then(function (loaded) {
          if (alive) setNode(loaded);
        });
        return function () {
          alive = false;
        };
      },
      [props.name],
    );
    if (!node) return null;
    return e(
      "svg",
      {
        className: "shrink-0",
        width: 12,
        height: 12,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      node.map(function (part, i) {
        return e(part[0], { key: i, ...part[1] }, part[2]);
      }),
    );
  }

  function TopicRow(props) {
    const topic = props.topic;
    const head = [];
    if (props.editing) {
      head.push(
        e(Input, {
          key: "name",
          value: props.draftName,
          autoFocus: true,
          maxLength: 120,
          className: "h-8 w-56",
          "aria-label": "Topic name",
          onChange: function (e) {
            props.onDraftChange(e.target.value);
          },
          onKeyDown: function (e) {
            if (e.key === "Enter") props.onSaveEdit();
            else if (e.key === "Escape") props.onCancelEdit();
          },
        }),
      );
    } else {
      head.push(e("span", { key: "name", className: "text-sm font-medium" }, topic.name));
    }
    head.push(
      e("span", { key: "id", className: "ml-3 font-mono text-xs text-muted-foreground" }, topic.id),
    );
    head.push(
      e(
        "span",
        {
          key: "count",
          className: "ml-3 text-xs text-muted-foreground",
        },
        props.threadCount + (props.threadCount === 1 ? " thread" : " threads"),
      ),
    );

    // The inline font, letter-spacing and size override the DS badge's
    // compressed look, and a Lucide glyph leads the badge text.
    if (props.isHome) {
      head.push(
        e(
          Badge,
          {
            key: "home",
            tone: "secondary",
            title: "Home topic",
            style: { fontFamily: "inherit", letterSpacing: "normal" },
            className: "text-sm gap-1",
          },
          e(Icon, { key: "home-icon", name: "star" }),
          "Home",
        ),
      );
    }
    if (topic.archived) {
      head.push(
        e(
          Badge,
          {
            key: "archived",
            tone: "warning",
            style: { fontFamily: "inherit", letterSpacing: "normal" },
            className: "text-sm gap-1",
          },
          e(Icon, { key: "archived-icon", name: "package" }),
          "Archived",
        ),
      );
    }

    const actions = [];
    if (props.editing) {
      actions.push(
        e(
          Button,
          {
            key: "save",
            size: "sm",
            ghost: true,
            disabled: !props.draftName.trim(),
            onClick: props.onSaveEdit,
            "aria-label": "Save",
            title: "Save",
          },
          e(Icon, { name: "check" }),
        ),
      );
      actions.push(
        e(
          Button,
          {
            key: "cancel",
            size: "sm",
            ghost: true,
            onClick: props.onCancelEdit,
            "aria-label": "Cancel",
            title: "Cancel",
          },
          e(Icon, { name: "x" }),
        ),
      );
    } else {
      actions.push(
        e(
          Button,
          {
            key: "rename",
            size: "sm",
            ghost: true,
            onClick: props.onStartEdit,
            "aria-label": "Rename this topic",
            title: "Rename this topic",
          },
          e(Icon, { name: "pencil" }),
        ),
      );
      actions.push(
        e(
          Button,
          {
            key: "home",
            size: "sm",
            ghost: true,
            disabled: props.isHome,
            onClick: props.onSetHome,
            "aria-label": props.isHome ? "This is the home topic" : "Set home",
            title: props.isHome ? "This is the home topic" : "Set as home topic",
          },
          e(Icon, { name: "house" }),
        ),
      );
      const dangerLabel =
        props.threadCount > 0
          ? topic.archived
            ? "Unarchive this topic"
            : "Archive this topic"
          : "Delete this topic";
      const dangerIcon =
        props.threadCount > 0
          ? topic.archived
            ? "archive-restore"
            : "archive"
          : "trash-2";
      actions.push(
        e(
          Button,
          {
            key: props.threadCount > 0 ? "archive" : "delete",
            size: "sm",
            ghost: true,
            destructive: true,
            onClick: props.threadCount > 0 ? props.onToggleArchive : props.onDelete,
            "aria-label": dangerLabel,
            title: dangerLabel,
          },
          e(Icon, { name: dangerIcon }),
        ),
      );
      actions.push(
        e(
          Button,
          {
            key: "up",
            size: "sm",
            ghost: true,
            disabled: props.first,
            onClick: function () {
              props.onMove(-1);
            },
            "aria-label": "Move up",
            title: "Move up",
          },
          e(Icon, { name: "arrow-up" }),
        ),
      );
      actions.push(
        e(
          Button,
          {
            key: "down",
            size: "sm",
            ghost: true,
            disabled: props.last,
            onClick: function () {
              props.onMove(1);
            },
            "aria-label": "Move down",
            title: "Move down",
          },
          e(Icon, { name: "arrow-down" }),
        ),
      );
    }

    return e(
      "li",
      {
        className:
          "flex flex-wrap items-center gap-2 border-b border-border/40 py-2 last:border-b-0",
      },
      head,
      e("div", { className: "ml-auto flex flex-wrap items-center gap-1" }, actions),
    );
  }

  function ThreadRow(props) {
    const thread = props.thread;
    const title = thread.title || "(untitled session)";

    return e(
      "li",
      {
        key: thread.session_id,
        className: "flex flex-wrap items-center gap-2 py-1.5",
      },
      e("span", { className: "min-w-0 flex-1 truncate text-sm" }, title),
      e(
        "span",
        { className: "shrink-0 text-xs text-muted-foreground" },
        thread.last_active ? timeAgo(thread.last_active) : "",
      ),
    );
  }

  function ThreadsCard(props) {
    const groups = props.groups;
    const inTopic = props.topics.reduce(function (sum, topic) {
      return sum + (groups.byTopic[topic.id] || []).length;
    }, 0);
    const totalLabel = inTopic + (inTopic === 1 ? " thread" : " threads");

    if (props.threads.length === 0) {
      return e(
        Card,
        null,
        e(
          CardHeader,
          null,
          e(CardTitle, { className: "text-sm" }, "Recent Threads"),
          e("p", { className: "text-xs text-muted-foreground" }, totalLabel),
        ),
        e(
          CardContent,
          { className: "pt-0" },
          e(
            "p",
            { className: "text-sm text-muted-foreground" },
            "No threads yet. Threads appear here once a chat is added to a topic.",
          ),
        ),
      );
    }

    const section = function (name, rows) {
      if (!rows || rows.length === 0) return null;
      const recent = rows.slice(0, RECENT_PER_TOPIC);
      return e(
        "div",
        { key: name, className: "flex flex-col" },
        e(
          "div",
          { className: "flex items-baseline gap-2 pb-1" },
          e(
            "span",
            {
              className: "text-md font-semibold tracking-wide text-muted-foreground",
            },
            name,
          ),
          e("span", { className: "text-sm text-muted-foreground" }, String(rows.length)),
        ),
        e(
          "ul",
          { className: "flex flex-col" },
          recent.map(function (thread) {
            return e(ThreadRow, {
              key: thread.session_id,
              thread: thread,
            });
          }),
        ),
      );
    };
    const anyInTopic = props.topics.some(function (topic) {
      return (groups.byTopic[topic.id] || []).length > 0;
    });
    return e(
      Card,
      null,
      e(
        CardHeader,
        null,
        e(CardTitle, { className: "text-sm" }, "Recent Threads"),
        e("p", { className: "text-xs text-muted-foreground" }, totalLabel),
      ),
      e(
        CardContent,
        { className: "flex flex-col gap-3 pt-0" },
        anyInTopic
          ? props.topics.map(function (topic) {
              return section(topic.name, groups.byTopic[topic.id]);
            })
          : e(
              "p",
              { className: "text-sm text-muted-foreground" },
              "No threads yet. Start working with your agents.",
            ),
      ),
    );
  }

  function TopicsPage() {
    const confirm = useConfirm();
    const [state, setState] = useState(null);
    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [newName, setNewName] = useState("");
    // The id field opens on the locked t_ prefix; the suffix is the user's part.
    const [newId, setNewId] = useState("t_");
    const [editing, setEditing] = useState(null);
    // The registry the page paints, kept beside the render state so a click that
    // lands before React re-renders still builds on what the last click painted.
    const stateRef = useRef(null);
    // Whole-state, last-writer-wins: one write is on the wire at a time and the
    // newest request wins, so a burst of moves can never interleave two writes.
    // `confirmed` is the last registry the server stored (the revert target),
    // `pending` the newest request it has not answered yet.
    const confirmed = useRef(null);
    const pending = useRef(null);
    const draining = useRef(null);
    const threadsStale = useRef(false);

    const paint = useCallback(function (next) {
      stateRef.current = next;
      setState(next);
    }, []);

    const load = useCallback(async function () {
      return Promise.all([
        SDK.fetchJSON(API + "/topics"),
        SDK.fetchJSON(API + "/threads?limit=" + THREAD_PAGE),
      ])
        .then(function (results) {
          confirmed.current = results[0];
          // A write already on its way owns the order: it paints the newer one.
          if (!pending.current) paint(results[0]);
          const list = (results[1] && results[1].threads) || [];
          setThreads(list);
          setError(null);
          return true;
        })
        .catch(function (err) {
          setError(parseApiErrorMessage(err));
          return false;
        })
        .then(function (ok) {
          setLoading(false);
          return ok;
        });
    }, [paint]);

    useEffect(
      function () {
        load();
      },
      [load],
    );

    // The write loop. A refused write drops the queue and puts the page back on
    // the last registry the server confirmed, so the order the user saw reverted
    // and the banner names the server's reason; nothing re-sends a lost request.
    const flush = useCallback(
      function () {
        if (draining.current) return draining.current;
        const task = (async function () {
          let failed = false;
          try {
            while (pending.current) {
              const want = pending.current;
              pending.current = null;
              try {
                const stored = await SDK.fetchJSON(API + "/topics", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(want),
                });
                confirmed.current = stored;
                setError(null);
                // A newer click already painted its own order: keep it.
                if (!pending.current) paint(stored);
              } catch (err) {
                failed = true;
                pending.current = null;
                setError(parseApiErrorMessage(err));
                if (confirmed.current) paint(confirmed.current);
              }
            }
          } finally {
            draining.current = null;
          }
          if (failed) {
            threadsStale.current = false;
            return false;
          }
          // A delete prunes its bindings in the same write, so the session
          // grouping is refetched with the registry; a reorder moves no thread.
          if (!threadsStale.current) return true;
          threadsStale.current = false;
          return load();
        })();
        draining.current = task;
        return task;
      },
      [load, paint],
    );

    // Paint first, send after: the rows land where the click asked for them in
    // the same frame, and the PUT is what catches up behind them.
    const save = useCallback(
      function (next, opts) {
        const target = { ...next };
        if (!(opts && opts.reload === false)) threadsStale.current = true;
        paint(target);
        pending.current = target;
        return flush();
      },
      [flush, paint],
    );

    const createTopic = function () {
      const name = newName.trim();
      const id = newId.trim();
      const current = stateRef.current;
      // The id is the locked prefix plus the user's suffix; a bare t_ is not an id.
      if (!name || id.length <= ID_PREFIX.length || !current) return;
      // A repeat click reads the painted registry, so a double add cannot mint
      // the same id twice.
      if (topicIdProblem(id, current.entries)) return;
      const entry = { id: id, name: name };
      save({ ...current, entries: current.entries.concat([entry]) }).then(function (ok) {
        if (ok) {
          setNewName("");
          setNewId(ID_PREFIX);
        }
      });
    };

    const renameTopic = function (id, name) {
      const trimmed = (name || "").trim();
      const current = stateRef.current;
      if (!trimmed || !current) return;
      save({
        ...current,
        entries: current.entries.map(function (entry) {
          return entry.id === id ? entryNamed(entry, trimmed) : entry;
        }),
      }).then(function (ok) {
        if (ok) setEditing(null);
      });
    };

    const setHome = function (id) {
      const current = stateRef.current;
      if (!current) return;
      return save({ ...current, home_id: id });
    };

    const toggleArchive = function (topic) {
      const current = stateRef.current;
      if (!current) return;
      return save({
        ...current,
        entries: current.entries.map(function (entry) {
          return entry.id === topic.id ? entryArchived(entry, !entry.archived) : entry;
        }),
      });
    };

    const requestDelete = function (topic) {
      confirm
        .ask({
          title: "Delete topic?",
          description:
            '"' +
            topic.name +
            '" leaves the registry and sessions grouped under it become untagged' +
            (stateRef.current && stateRef.current.home_id === topic.id
              ? ". It is the current home, so the home moves to another topic"
              : "") +
            ".",
          confirmLabel: "Delete",
        })
        .then(function (ok) {
          const current = stateRef.current;
          if (!ok || !current) return;
          const entries = current.entries.filter(function (entry) {
            return entry.id !== topic.id;
          });
          const next = { ...current, entries: entries };
          if (current.home_id === topic.id) next.home_id = fallbackHome(entries);
          return save(next);
        });
    };

    // A reorder is optimistic: the rows swap in the click's own frame and the
    // PUT follows in the background. Nothing disables while it runs, so rapid
    // clicks chain on the painted order and only the last one hits the wire
    // twice - the queue's newest-wins rule collapses the rest.
    const moveTopic = function (id, dir) {
      const current = stateRef.current;
      if (!current) return;
      const index = current.entries.findIndex(function (entry) {
        return entry.id === id;
      });
      const target = index + dir;
      if (index < 0 || target < 0 || target >= current.entries.length) return;
      const entries = current.entries.slice();
      const moved = entries[index];
      entries[index] = entries[target];
      entries[target] = moved;
      return save({ ...current, entries: entries }, { reload: false });
    };

    const groups = useMemo(
      function () {
        const byTopic = {};
        const live = new Set(
          (state && state.entries ? state.entries : []).map(function (e) {
            return e.id;
          }),
        );

        for (const thread of threads) {
          if (thread.topic_id && live.has(thread.topic_id)) {
            if (!byTopic[thread.topic_id]) byTopic[thread.topic_id] = [];
            byTopic[thread.topic_id].push(thread);
          }
        }

        return { byTopic: byTopic };
      },
      [threads, state],
    );

    if (loading && !state) {
      return e("div", { className: "p-6 text-sm text-muted-foreground" }, "Loading topics\u2026");
    }

    const entries = (state && state.entries) || [];
    // The id field always shows the locked t_ prefix, so the user's part is
    // the suffix; a problem line renders only once a suffix exists.
    const idSuffix = newId.startsWith(ID_PREFIX) ? newId.slice(ID_PREFIX.length) : "";
    const idProblem = idSuffix ? topicIdProblem(newId, entries) : "";

    return e(
      "div",
      { className: "hermes-topoi flex flex-col gap-4" },
      error
        ? e(
            "div",
            {
              className:
                "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
              role: "alert",
            },
            error,
          )
        : null,
      e(
        Card,
        null,
        e(
          CardHeader,
          null,
          e(CardTitle, { className: "text-sm" }, "Registry"),
          e(
            "p",
            { className: "text-xs text-muted-foreground" },
            entries.length + (entries.length === 1 ? " topic" : " topics"),
          ),
        ),
        e(
          CardContent,
          { className: "flex flex-col gap-3 pt-0" },
          e(
            "div",
            { className: "flex flex-wrap items-center gap-2" },
            e(Input, {
              value: newName,
              placeholder: "New topic name",
              maxLength: 120,
              className: "h-8 w-64",
              "aria-label": "New topic name",
              onChange: function (e) {
                setNewName(e.target.value);
              },
              onKeyDown: function (e) {
                if (e.key === "Enter") createTopic();
              },
            }),
            e(Input, {
              value: newId,
              maxLength: 64,
              className: "h-8 w-48",
              "aria-label": "New topic id",
              onChange: function (e) {
                // Lock the t_ prefix
                const raw = e.target.value;
                const suffix = raw.startsWith(ID_PREFIX)
                  ? raw.slice(ID_PREFIX.length)
                  : raw.replace(/^t_?/, "");
                setNewId(ID_PREFIX + suffix);
              },
              onKeyDown: function (e) {
                if (e.key === "Enter") createTopic();
              },
            }),
            e(
              Button,
              {
                size: "sm",
                disabled: !newName.trim() || !idSuffix || !!idProblem,
                onClick: createTopic,
              },
              "Add topic",
            ),
            e(
              Button,
              {
                size: "sm",
                ghost: true,
                disabled: loading,
                onClick: function () {
                  load();
                },
                title: "Reload the registry and the session list",
              },
              "Refresh",
            ),
          ),
          idProblem
            ? e("p", { className: "text-xs text-destructive" }, idProblem)
            : null,
          entries.length === 0
            ? e(
                "p",
                { className: "text-sm text-muted-foreground" },
                "No topics. Add one to give sessions a group.",
              )
            : e(
                "ul",
                { className: "flex flex-col" },
                entries.map(function (topic, index) {
                  return e(TopicRow, {
                    key: topic.id,
                    topic: topic,
                    first: index === 0,
                    last: index === entries.length - 1,
                    isHome: !!(state && state.home_id === topic.id),
                    threadCount: (groups.byTopic[topic.id] || []).length,
                    editing: !!(editing && editing.id === topic.id),
                    draftName: editing && editing.id === topic.id ? editing.name : topic.name,
                    onDraftChange: function (name) {
                      setEditing({ id: topic.id, name: name });
                    },
                    onStartEdit: function () {
                      setEditing({ id: topic.id, name: topic.name });
                    },
                    onCancelEdit: function () {
                      setEditing(null);
                    },
                    onSaveEdit: function () {
                      renameTopic(topic.id, editing ? editing.name : topic.name);
                    },
                    onSetHome: function () {
                      setHome(topic.id);
                    },
                    onToggleArchive: function () {
                      toggleArchive(topic);
                    },
                    onDelete: function () {
                      requestDelete(topic);
                    },
                    onMove: function (dir) {
                      moveTopic(topic.id, dir);
                    },
                  });
                }),
              ),
        ),
      ),
      e(ThreadsCard, {
        threads: threads,
        topics: entries,
        groups: groups,
      }),
      confirm.dialogProps ? e(ConfirmDialog, confirm.dialogProps) : null,
    );
  }

  // The sessions:top slot: a compact topic overview above the dashboard's session list.
  function TopicsSlotCard() {
    const [state, setState] = useState(null);
    const [threads, setThreads] = useState([]);
    useEffect(function () {
      let live = true;
      Promise.all([
        SDK.fetchJSON(API + "/topics"),
        SDK.fetchJSON(API + "/threads?limit=" + THREAD_PAGE),
      ])
        .then(function (results) {
          if (!live) return;
          setState(results[0]);
          setThreads((results[1] && results[1].threads) || []);
        })
        .catch(function () {
          /* leave the page exactly as it was */
        });
      return function () {
        live = false;
      };
    }, []);
    if (!state) return null;
    const entries = state.entries || [];
    const counts = {};
    for (const thread of threads) {
      if (thread.topic_id) counts[thread.topic_id] = (counts[thread.topic_id] || 0) + 1;
    }
    return e(
      Card,
      { className: "hermes-topoi-slot" },
      e(
        CardHeader,
        { className: "flex-row items-center justify-between gap-3 py-3" },
        e(CardTitle, { className: "text-sm" }, "Topics"),
        e(
          "a",
          {
            href: "/topics",
            className: "text-xs text-muted-foreground underline-offset-2 hover:underline",
          },
          "Manage topics",
        ),
      ),
      e(
        CardContent,
        { className: "flex flex-wrap gap-2 pt-0" },
        entries.length === 0
          ? e("span", { className: "text-xs text-muted-foreground" }, "No topics yet.")
          : entries.map(function (topic) {
              return e(
                "a",
                {
                  key: topic.id,
                  href: "/topics",
                  className:
                    "inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-xs" +
                    (topic.archived ? " text-muted-foreground" : ""),
                },
                topic.archived ? e(Badge, { tone: "warning" }, topic.name) : topic.name,
                e("span", { className: "text-muted-foreground" }, String(counts[topic.id] || 0)),
                state.home_id === topic.id
                  ? e(
                      "span",
                      {
                        className: "text-muted-foreground",
                      },
                      "home",
                    )
                  : null,
              );
            }),
      ),
    );
  }

  window.__HERMES_PLUGINS__.register("topoi", TopicsPage);
  window.__HERMES_PLUGINS__.registerSlot("topoi", "sessions:top", TopicsSlotCard);
})();
