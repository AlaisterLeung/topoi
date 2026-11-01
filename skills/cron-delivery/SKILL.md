---
name: cron-delivery
description: "Use when a cron job must deliver into a topoi topic. Forces attach_to_session, then verifies the seeded thread instead of the delivery ledger."
version: 1.0.0
author: Alaister LJ Leung
tags: [topoi, cron, delivery, threads]
---

# Cron delivery into a topoi topic

## When to use

Any `cronjob` create or update with `deliver=topoi:<topic>`, or a scheduled run that exists while the topic shows nothing.

## The rule

A topoi delivery is visible only when the run opens a reply-able thread in that topic. `TopoiAdapter.send()` has no socket: it logs `[topoi] delivery -> <topic>`, mints a message id, and returns `SendResult(success=True)`. Nothing is pushed and the adapter stores nothing. Clients list a topic from the session store, so a delivered run must have seeded a session there:

- good: a `source: topoi` session with `chat_id=<topic>` and `thread_id=th_<epoch>_<hex6>`, seeded by the core after `create_handoff_thread`. The brief lands as its first user turn, prefixed `[Cron delivery: <job name>]`.
- invisible: a bare `source: cron` run session. The listing files it under a topic only when its id is `cron_<job id>_<stamp>`; current core mints `local-<hash>` ids, so an unseeded run resolves to no topic and appears in no listing at all.

## What to do

1. Set `attach_to_session: true` on every job that delivers to a topoi topic and was created outside a topoi chat (desktop, CLI, API). It is the only opt-in that makes the core open a thread for an explicit `platform:chat_id` target.
2. Jobs created from inside a topoi chat can leave it off: `deliver=origin` resolves to the topoi home topic and seeds on the origin match.
3. Keep `failure_deliver` on the same topic so a failed run's notice is filed the same way instead of vanishing.
4. `[SILENT]` seeds nothing, by design. An empty topic after quiet ticks is correct.
5. A manual `cronjob run` re-anchors an interval schedule: `every 180m` restarts its clock from the fire.

## Verification, never the ledger

`last_delivery_error: null` and `delivery_outcome: delivered` prove only that the adapter returned success. Check the session store for the seed:

```bash
python3 - <<'EOF'
import sqlite3
con = sqlite3.connect("file:/home/alaister/.hermes/state.db?mode=ro", uri=True)
con.row_factory = sqlite3.Row
for row in con.execute(
    "select id, chat_id, thread_id, message_count, started_at from sessions "
    "where source='topoi' and chat_id='t_alerts' order by started_at desc limit 3"):
    print(dict(row))
EOF
```

A working delivery shows the topic id, a `th_` thread id, and `message_count` 1 holding the seeded brief. Prove it with a run that will not be silent: `hermes cron run` executes on the standalone rail with no live adapters, no thread and no seed, so it cannot prove the path. Fire through the running gateway (`cronjob(action='run')`) and check afterwards.

## Reading the failures

- Run exists, ledger says delivered, topic empty: no seed. The job lacks `attach_to_session`, or the target named a topic the registry does not hold (the adapter's `validate_target_ref` rejects an unknown id with a reason).
- Topic shows a run row but no thread: the seed was deleted or archived, so the listing falls back to the run row. Unarchive it or re-fire.
- Seed exists but Reply is missing: the pairing row in `~/.hermes/plugin-data/topoi/cron_thread.db` was never written, which happens when the send carried no `job_id` in metadata. It costs the reply, never the delivery.

## Constraints on the plugin code

- The delivery pairing is `cron_thread.db` (`thread_id`, `topic_id`, `job_id`), written from `send()` metadata. `create_handoff_thread` cannot be the hook: it has no job id.
- The listing withholds the `source: cron` row when a live seed backs it. Fail open on every miss: silent run, failed send, deleted or archived seed, unreadable store.
- `source: topoi` alone is not a cron result, the New thread flow mints the same source. Key cron branches on the pairing row.
- A bundled skill is registered in `register(ctx)` through `ctx.register_skill(name, path, description, frontmatter)`; it is read-only, is not copied into `~/.hermes/skills/`, and resolves as `topoi:<name>`.

## Checklist

- [ ] `attach_to_session: true` for desktop, CLI and API created jobs.
- [ ] `failure_deliver` points at the same topoi topic.
- [ ] One non-silent run verified a `source: topoi` seeded session for the topic.
- [ ] Silence still means no seed: no `[SILENT]` run polluted the topic.
