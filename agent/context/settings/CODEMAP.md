# Settings Agent — CODEMAP (catalog CLI)

```
node $CLOUD_PI_CATALOG agents list
node $CLOUD_PI_CATALOG agents get <id-or-slug>
node $CLOUD_PI_CATALOG agents create --name NAME [--short S] [--color emerald] [--headline ...] [--description ...] [--role TEXT | --role-file PATH] [--repo owner/name] [--branch main] [--live-url URL]
node $CLOUD_PI_CATALOG agents update <id> [--name ...] [--role TEXT | --role-file PATH]
node $CLOUD_PI_CATALOG agents attach <id> [--skill slug] [--mcp slug]
node $CLOUD_PI_CATALOG agents detach <id> [--skill slug] [--mcp slug]
node $CLOUD_PI_CATALOG agents delete <id>

node $CLOUD_PI_CATALOG skills list
node $CLOUD_PI_CATALOG skills get <id-or-slug>
node $CLOUD_PI_CATALOG skills install [--file PATH | --url URL | --content MD] [--name slug] [--description ...]
node $CLOUD_PI_CATALOG skills install-impeccable [--force]
node $CLOUD_PI_CATALOG skills install-scrapling [--force]
node $CLOUD_PI_CATALOG skills delete <id-or-slug>
node $CLOUD_PI_CATALOG skills rescan

node $CLOUD_PI_CATALOG mcp list
node $CLOUD_PI_CATALOG mcp get <id-or-slug>
node $CLOUD_PI_CATALOG mcp add --name NAME [--command CMD] [--args "..."] [--url URL] [--env JSON] [--description ...]
node $CLOUD_PI_CATALOG mcp update <id> [...]
node $CLOUD_PI_CATALOG mcp delete <id-or-slug>
```

`--skill` and `--mcp` may repeat. `agents create` gives the new agent the shared
`/storage/workspace` folder until a maintainer adds it to `server/paths.mjs`; warn the
operator that a new agent needs its own workspace before it edits files (see
[agent/AGENT_BLUEPRINT.md](../../AGENT_BLUEPRINT.md) § 3.1).

Concept → command:

| Operator says | Run |
|---------------|-----|
| "what does X have?" | `agents get X` (skills + mcp arrays) |
| "give X the Y skill" | `skills list` (is Y installed?) → `agents attach X --skill Y` |
| "install this skill from URL/file" | `skills install --url … --name slug` → then attach |
| "add an MCP server" | `mcp add …` → `agents attach X --mcp slug` |
| "refresh Scrapling / Impeccable" | `skills install-scrapling --force` / `skills install-impeccable --force` |
| "new agent" | follow AGENT_BLUEPRINT; `agents create --role-file …` is only step 5 |
