# 2oBrain

A facts+nodes "second brain": atomic, dated, sourced facts in Postgres
(Supabase), grouped into nodes (projects, people, topics), searchable by
any MCP client (Claude, or anything else that speaks MCP), with a local
dashboard for search/capture/maintenance and an interactive force-directed
graph of how your nodes connect.

Not a note-taking app. Not a wiki. Every fact has a date and a source,
always, no fact is "recalled" from an LLM's memory, only ever retrieved
from what was actually written down.

## Access it from anywhere

The database is the single source of truth, not any one app or machine.
Once a hosted MCP server is deployed (Fase 7 of the install), the same
`search`/`remember` reach whatever client you're in, Claude Code, Claude
Chat, Claude Cowork, a generic MCP-speaking CLI, desktop or mobile, with
no separate sync step and no client-specific setup beyond connecting to
the one URL. This isn't aspirational: the same design was verified live
across all four of those surfaces (Code, Chat, Cowork, a generic CLI) and
from a phone, before this scaffold existed. No client gets a special path
or a degraded one; the MCP server is the same thin layer for all of them.

## Architecture

- **`scripts/db/`**, the engine. CLI scripts, one job each: `remember.mjs`
  writes a fact, `search.mjs` finds facts+pages (hybrid vector+full-text),
  `timeline.mjs` lists a node's history, `merge-nodes.mjs`/`node-link.mjs`
  manage the node graph, `doctor.mjs` checks integrity, and a dozen more.
  Every script is a normal Node CLI, run it directly, no framework.
- **`scripts/db/server/`**, a local Hono server that exposes those same
  scripts over HTTP for a browser dashboard (`scripts/db/server/public/`):
  search with LLM-synthesized answers, a live d3-force graph of your nodes,
  fact capture, node maintenance.
- **`deno-deploy/mcp-server/`** and **`supabase/functions/mcp-server/`**,
  two interchangeable hosted MCP servers (pick one, or run both) that expose
  `search`/`remember` to any MCP client over the network, Claude Desktop,
  Claude Code, Claude Chat/Cowork, or anything else that speaks MCP.
- **`scripts/hooks/`**, a Claude Code `Stop` hook (nudges you to capture a
  fact before closing a turn), a `UserPromptSubmit` hook (detects a
  day-start greeting and forces a review of `MEMORY.md`'s startup checklist,
  deterministically, not by hoping Claude remembers), and a git
  `post-commit` hook (reloads page embeddings when you commit a `.md` file).
- **`skills/`**, `segundo-cerebro-capture` (when/how to save a fact from
  a session that has DB access) and `extract-code-facts` (extract facts
  from a session that has *no* access to this repo, another project,
  a remote container, as JSON you bring back and ingest later).

## Quick start

Tell your coding agent (Claude Code, or anything similarly capable):

```
Sigue las instrucciones definidas aquí: https://github.com/oscampo/2oBrain
```

That single message is meant to be enough, even in a brand new session
with nothing cloned yet. Before anything else, the agent should:

1. Check whether `git` is installed (`git --version`); if not, install it
   for the detected OS itself, not ask you to go do it.
2. Clone this repo (`git clone https://github.com/oscampo/2oBrain.git`)
   into a sensible folder, `./2oBrain/` by default unless that collides
   with something already there.
3. Detach it from this repo (`git remote remove origin`), inside the new
   folder: a clone keeps pointing at `oscampo/2oBrain` by default, and
   your copy is meant to become fully yours, not a fork someone could
   confuse for a place to push back to.
4. Move into that folder and continue from `CLAUDE.md`, which is a guided
   installation script, not documentation to read passively.

From there, `CLAUDE.md` takes over end to end: creating the Supabase
project and applying `scripts/db/schema.sql`, filling in `.env` (see
`.env.example`), choosing which MCP server to deploy (or skipping that
and using the dashboard/CLI only), and writing your own `SOUL.md`/
`USER.md` so the assistant knows who it's working with.

Once installed, reopen your agent **from inside this cloned folder** in
future sessions, that's what makes your `SOUL.md`/`USER.md`/`MEMORY.md`
identity persist turn to turn instead of starting over each time.

## What doesn't ship here

Your own facts, nodes, and any narrative `.md` pages (`daily/`, `guides/`,
`people/`, `projects/`, `wiki/`) are yours, this repo ships empty
(gitignored by default, see `.gitignore`). `SOUL.md`/`USER.md`/`MEMORY.md`
ship as blank templates the interview script fills in with you, not a
worked example.

## License

MIT, see `LICENSE`.
