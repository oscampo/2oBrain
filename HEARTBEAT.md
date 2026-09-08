# HEARTBEAT.md

Session-triggered schedules for Claude. These are cadence-prompted checks
that fire at turn/session boundaries **while the harness is open**, nothing
runs while the laptop sleeps or the app is closed. (Always-on 24/7
schedules are what a hosted service provides; this file is the honest
desktop contract.)

This file ships with the checks the scaffold's own scripts already
support, every one of them DISABLED by default (see "Enabling a new
check" below) so nothing runs until you've actually chosen it, same
spirit as `MEMORY.md` and the `usuario` category shipping blank: this is a
menu of switches, not a worked example of what your day should look like.
The install interview (`CLAUDE.md`, Fase 5) walks through them with you.
Add more rows here as you find other real recurring checks worth running,
never invent one speculatively.

Deliberately separate from `MEMORY.md`: that file is meant to be pruned
and rewritten as it goes stale ("cut what no longer earns its place"), a
due-check list is closer to configuration than to memory, it should not be
at risk of getting edited away during a normal `MEMORY.md` cleanup pass.

(Vocabulary note, 2026-09-08: earlier drafts called each row a "job",
inherited from an unrelated prior project -- "check" is what a row
actually is here, a periodic verification, not a background task with its
own lifecycle. Renamed throughout.)

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

## Due-check list

**At every session start and turn boundary: go through every row below.
For each one with Enabled = `yes` whose cadence condition is met right
now, run its `What` action in this turn, before responding to anything
else that isn't the row's own trigger.** Not a suggestion, not something
to skim past under the silence contract, not conditional on whether it
"feels" relevant this time -- every enabled, due row, every time.

| Check | Cadence (session-triggered) | Enabled | What |
| --- | --- | --- | --- |
| ambient-delta | every session start + turn boundary | no | `node scripts/db/delta.mjs --quiet`, pull "what changed since my last wake" (new records/pages) since the last run on this machine (`state/delta-state.local.json`). Zero-LLM. Stay silent when empty. |
| brain-hygiene | weekly-equivalent | no | `node scripts/db/doctor.mjs`; relay anything not OK. |
| check-2obrain-updates | weekly-equivalent | no | `node scripts/db/check-for-updates.mjs --json`; about the tool itself (2oBrain), not the user's own data -- compares the local `VERSION` against the latest tag on `oscampo/2oBrain` (`git ls-remote --tags`, no remote/token needed). Only surface if `hasUpdate` is true; never applies anything by itself, see CLAUDE.md "Mantenimiento: revisar e instalar actualizaciones". |
| commitments-check | first session of the day | no | `node scripts/db/list-commitments.mjs` (query against `records`, not `MEMORY.md` prose); surface anything due or overdue. |
| memory-prune | weekly-equivalent | no | The `MEMORY.md` maintenance ritual (promote / demote / cut). |
| morning-briefing | first session of the day | no | One screen: due today, waiting on, worth knowing. No filler, a skipped briefing costs less than an empty one. If you've connected mail/calendar tools, use them to complement it; if not, skip that part rather than guessing. |

Cadence bookkeeping lives in `state/heartbeat-state.local.json`
(machine-local, not committed).

## Enabling a new check

Every new check ships DISABLED. The enable ritual is per-check, not
per-session: run the check manually first, confirm the output is worth
delivering, then (and only then) flip its Enabled cell to `yes`. Each
check earns its own flip on its own evidence, never flip one on the
strength of another's test. This section is about onboarding a check
that doesn't exist yet in the table above -- it has nothing to do with
what runs at a normal session start, that's what the due-check list
above is for.
