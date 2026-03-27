# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A TypeScript MCP server for BMC Track-It 2021, packaged as a `.mcpb` file for Claude Desktop. It runs as a local stdio child process — one instance per user machine — and exposes 32 tools covering tickets, assignments, solutions, search, notes, attachments, status changes, and priority hierarchy.

Read `BOOTSTRAP.md` before starting any implementation work. It documents the non-obvious Track-It API quirks (auth format, POST-for-update, spaced field names, the `priorityheirarchy` typo, etc.) that are not in the official docs.

## Project layout

```
src/
  auth.ts            — OAuth2 token cache (password grant + refresh token)
  trackit-client.ts  — All Track-It HTTP calls; one export per API operation
  server-stdio.ts    — MCP server: tool registration + StdioServerTransport
connector/
  manifest.json      — MCPB manifest; all 5 credentials are user_config fields
scripts/
  build-connector.mjs — esbuild bundle → ZIP → .mcpb (no external zip dep)
```

## Build commands

```bash
npm install          # first time only
npm run bundle       # compile + bundle + package → connector/trackit-mcp.mcpb
npm run build        # tsc only (type-check + emit to dist/)
npx tsc --noEmit     # type-check only
```

`npm run dev` is for local smoke-testing only; it requires environment variables set (see below).

## Architecture notes

- **Stdio transport only.** Claude Desktop runs the server as a child process; stdout is the MCP JSON-RPC channel. Never write to stdout — use `console.error()` for diagnostics (Claude Desktop's embedded runtime routes this to the MCP log; `process.stderr.write()` does not appear there).
- **No `node_modules` in the connector.** esbuild bundles everything into a single `server.js`. The MCPB archive contains only `manifest.json` + `server.js`.
- **`${user_config.fieldname}` substitution** works in manifest `env` values AND `args`. Credentials flow in as environment variables. The supported path variable is `${__dirname}` — it expands to the connector's installation directory at runtime. The `mcp_config` args use `"${__dirname}/server.js"` so that Node.js receives an absolute path regardless of the process working directory (Claude Desktop spawns from `C:\Windows\system32` on Windows).
- **`cwd` is NOT a valid `mcp_config` field.** Claude Desktop's manifest validator will reject it. Use `${__dirname}` in args instead.
- **`child_process.spawn()` and `fs` writes are sandboxed** in Claude Desktop's embedded Node.js. Don't add them.
- **`node:` URL-scheme prefix is NOT supported** in Claude Desktop's embedded Node.js runtime. The MCP SDK uses `import process from 'node:process'` which esbuild would compile to a top-level `require("node:process")` — failing silently before error handlers are registered. The build script uses a `strip-node-prefix` esbuild plugin to remap all `node:*` imports to their bare-name equivalents (e.g. `process`, `https`). Do not remove this plugin.
- **Zod v4 is installed.** `z.record()` requires two arguments: `z.record(z.string(), z.unknown())`. The single-argument form from Zod v3 does not compile.

## Version management — REQUIRED before every push

The version appears in three places and must be kept in sync. Before committing and pushing any change, increment the patch version (`zz` in `xx.yy.zz`) in all three:

1. `package.json` → `"version"` field
2. `src/server-stdio.ts` → `const SERVER_VERSION = "..."`
3. `connector/manifest.json` → `"version"` field

Do this as part of the same commit as the change, not as a separate commit.

## Track-It API key rules (from BOOTSTRAP.md)

- Username format: `GROUP\DOMAIN\username` (backslashes, GROUP can have spaces)
- Create = `POST /tickets`, Update = `POST /tickets/{id}`, Delete = `POST /tickets/{id}/Delete`
- Pagination is path segments `/{pageSize}/{pageNumber}` — use `0/0` for all records
- Field names have spaces: `"Assigned Tech"`, `"Note Type"`, etc.
- `priorityheirarchy` is the correct (misspelled) endpoint name
- Priority hierarchy takes integer IDs: `DepartmentId`, `CategoryId`, `LocationId`, `RequestorId`
- Assignment notes have no `Private` field; ticket notes do
- `get_module_fields` must be called before any create/update to get exact field names
