# HEARTBEAT.md

Session-triggered schedules for Claude. These are cadence-prompted jobs
that fire at turn/session boundaries **while the harness is open**, nothing
runs while the laptop sleeps or the app is closed. (Always-on 24/7
schedules are what a hosted service provides; this file is the honest
desktop contract.)

This file ships empty of real jobs, on purpose, same as
`SOUL.md`/`USER.md`/`MEMORY.md`: it's a template for a pattern, not a
worked example. Add jobs here as you find real recurring checks worth
running (a delta pull, a health check, a briefing), never invent one
speculatively.

Deliberately separate from `MEMORY.md`: that file is meant to be pruned
and rewritten as it goes stale ("cut what no longer earns its place"), a
due-job list is closer to configuration than to memory, it should not be
at risk of getting edited away during a normal `MEMORY.md` cleanup pass.

## The silence contract

Most checks should produce **no visible output**. Deliver only when at
least one is true: something is time-sensitive and the user does not know
yet; a watched thing changed materially; a scheduled deliverable is due;
something failed in a way the user must decide about. Otherwise: work
silently, write to memory, stay quiet. Never narrate quiet-hours state.

## Before anything

Verify the time first with your OS's local `date` command, never compute
it in your head or assume a timezone override works correctly (some
shells silently return the wrong time with a bad `TZ=` value instead of
erroring, verify once, don't assume). Quiet hours: pick a window that
matches how the user actually works (e.g. 23:00-08:00 local, proactive
output waits; direct requests are always answered regardless of the hour).

## Due-job list

Checked at session start and turn boundaries. Every job ships DISABLED,
the enable ritual is per-job, not per-session: run the job manually
first, confirm the output is worth delivering, then (and only then) flip
its Enabled cell to `yes`. Each job earns its own flip on its own
evidence, never flip one on the strength of another's test.

| Job | Cadence (session-triggered) | Enabled | What |
| --- | --- | --- | --- |
| _(none yet, add your own)_ | | no | |

Cadence bookkeeping lives in `state/heartbeat-state.local.json`
(machine-local, not committed).
