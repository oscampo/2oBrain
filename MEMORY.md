# MEMORY.md

Hot durable state for Claude. Loaded every session. **Never loaded in
shared or group contexts — that is a security boundary, not a
preference.**

Keep this file under one screen (~8KB). The session-start digest reads it
every session; an unread memory file is not memory. When a section
outgrows a screen, move the body to `memory/reference/` and leave a
one-line pointer.

---

## Al iniciar sesión

*(Optional: note any scheduled/recurring check to run at session start —
e.g. a due-job list, a delta check. Leave empty if none yet.)*

## Standing rules learned from corrections

Format: one line, dated, imperative, with the bug it prevents:

*(Empty at install. Add one every time a correction should generalize
beyond the single conversation it happened in — never invent one ahead of
a real correction.)*

## What is always worth writing down

- Corrections the principal makes (these become standing rules)
- Commitments made in either direction, with dates
- Preferences stated once that should never need restating
- Facts about people and projects the principal works with

## Active context

*(Empty.)*

## Open commitments

Things Claude said it would do and has not finished, and things others owe
the principal. A promise not in this file will be forgotten, and being
forgotten is how an agent loses trust.

*(Empty.)*

## Critical events

Append-only, ISO-timestamped. Never rewrite an entry — the old entry being
wrong is itself information.

*(Empty.)*

## Maintenance

Weekly (or when this file exceeds a screen): promote durable knowledge
either as a dated fact via `remember.mjs`, or by editing/creating a page
under `daily/guides/people/projects/wiki` and committing; demote cold
detail to `memory/reference/`; cut what no longer earns its place.
Promotion needs a quoted line from a daily note or conversation — if you
cannot quote it, it does not go in. Memory that is never pruned stops
being read.
