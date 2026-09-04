# 2oBrain

A facts+nodes "second brain": atomic, dated, sourced facts in Postgres
(Supabase), grouped into nodes (projects, people, topics), searchable by
any MCP client (Claude, or anything else that speaks MCP), with a local
dashboard for search/capture/maintenance and an interactive force-directed
graph of how your nodes connect.

Not a note-taking app. Not a wiki. Every fact has a date and a source,
always — no fact is "recalled" from an LLM's memory, only ever retrieved
from what was actually written down.

## Architecture

- **`scripts/db/`** — the engine. CLI scripts, one job each: `remember.mjs`
  writes a fact, `search.mjs` finds facts+pages (hybrid vector+full-text),
  `timeline.mjs` lists a node's history, `merge-nodes.mjs`/`node-link.mjs`
  manage the node graph, `doctor.mjs` checks integrity, and a dozen more.
  Every script is a normal Node CLI — run it directly, no framework.
- **`scripts/db/server/`** — a local Hono server that exposes those same
  scripts over HTTP for a browser dashboard (`scripts/db/server/public/`):
  search with LLM-synthesized answers, a live d3-force graph of your nodes,
  fact capture, node maintenance.
- **`deno-deploy/mcp-server/`** and **`supabase/functions/mcp-server/`** —
  two interchangeable hosted MCP servers (pick one, or run both) that expose
  `search`/`remember` to any MCP client over the network — Claude Desktop,
  Claude Code, Claude Chat/Cowork, or anything else that speaks MCP.
- **`scripts/hooks/`** — a Claude Code `Stop` hook (nudges you to capture a
  fact before closing a turn) and a git `post-commit` hook (reloads
  page embeddings when you commit a `.md` file).
- **`skills/`** — `segundo-cerebro-capture` (when/how to save a fact from
  a session that has DB access) and `extract-code-facts` (extract facts
  from a session that has *no* access to this repo — another project,
  a remote container — as JSON you bring back and ingest later).

## Quick start

Follow `CLAUDE.md` — it's an interview script. Open this repo in Claude
Code and it will walk you through: creating the Supabase project and
applying `scripts/db/schema.sql`, filling in `.env` (see `.env.example`),
choosing which MCP server to deploy (or skipping that and using the
dashboard/CLI only), and writing your own `SOUL.md`/`USER.md` so the
assistant knows who it's working with.

## What doesn't ship here

Your own facts, nodes, and any narrative `.md` pages (`daily/`, `guides/`,
`people/`, `projects/`, `wiki/`) are yours — this repo ships empty
(gitignored by default, see `.gitignore`). `SOUL.md`/`USER.md`/`MEMORY.md`
ship as blank templates the interview script fills in with you, not a
worked example.

## License

MIT — see `LICENSE`.
