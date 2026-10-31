# Lore graph for station personas

Status: planned, not built.

## Goal

Give each host persona a knowledge graph of station lore (places, people, past shows, running jokes, facts the DJ may mention) so generated scripts can draw on real, approved detail and sound richer. The graph is written by the station team and read by the script writer. It never invents facts.

## What exists today

- `lib/personas.js` holds static presets: link templates, time-of-day lines, station IDs, a persona instruction string and delivery settings. Nothing is per-persona lore.
- `lib/host.js` builds the language-model prompt from `persona` (free text, up to 1000 characters). That is the only hook for extra context today.
- Scripts are drafted from persona briefs in the Studio (see `docs/SCRIPTS.md`). `lib/mcp-tools.js` exposes station actions to chat assistants over the HTTP API.

## Proposed design

**Data model** (one JSON file per station, same pattern as the hub, until the database item in the roadmap lands):

- `nodes`: `{ id, type, name, aliases[], summary, personaIds[], source, approved }`. `type` is one of `person`, `place`, `event`, `show`, `running_joke`, `fact`.
- `edges`: `{ from, to, relation, note }`, for example `person -- hosted --> show`, `event -- happened_at --> place`.
- `source` records the file and row/line the node came from. Only nodes with `approved: true` reach a script.

**Scoping:** a node with `personaIds: []` is station-wide. Otherwise only the named personas see it.

**Import formats:**

- CSV with a header: `type,name,aliases,summary,relation_to,relation,persona,approved`. One row is one node, plus an optional edge to an existing node name. Quoted fields and `;` inside `aliases` are supported.
- TXT in a simple block form: a line `## Name [type]`, then the summary as free text, then `- relation: Other node` lines for edges. Blank lines separate blocks.
- Both parsers reject unknown types, duplicate names, and edges to missing nodes, and report line numbers. Nothing is written on any error (all or nothing).

**Retrieval for scripts:** given a persona and a brief, select approved nodes for that persona and their direct neighbours, rank by name or alias match in the brief, and cap the total (for example 1500 characters) so prompts stay small. The selected facts go into the prompt as a labelled "Station lore (use only these facts)" block. Writers are told not to add facts beyond it.

**Explorer tool:**

- CLI: `node bin/lore.js import <file.csv|file.txt> --station <id>`, `node bin/lore.js search <text>`, `node bin/lore.js show <name>` (node, its edges and neighbours), `node bin/lore.js path <a> <b>`. Output is plain text.
- Optional read-only MCP tools (`lore_search`, `lore_show`) so a chat assistant can answer questions about the lore. These must not write.
- A later UI view in the Studio is out of scope for the first version.

## Acceptance tests (to write with the build)

1. A CSV and a TXT sample with the same content import to the same graph.
2. A bad row (unknown type, missing edge target, duplicate name) fails the whole import with the line number, and the stored graph is unchanged.
3. A persona-scoped node is not returned for another persona's brief.
4. An unapproved node is never returned to script generation, but is visible to the explorer with a flag.
5. Retrieval output stays under the character cap.
6. `npm test` still passes.

## Open questions for the station owner

- Who approves lore: one person, or a list of reviewers?
- Is lore allowed to mention real people and past incidents? If so, the review rules need to cover that.
- Should lore be editable in the UI, or only imported from files?
