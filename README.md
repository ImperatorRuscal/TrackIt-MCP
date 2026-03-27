# TrackIt-MCP

A [Model Context Protocol](https://modelcontextprotocol.io/) connector for **BMC Track-It! 2021**, packaged as a `.mcpb` file for [Claude Desktop](https://claude.ai/download).

Once installed, Claude can look up tickets, add notes, change statuses, create and update work items, search the knowledge base, and more — all through natural language, without leaving the chat window.

---

## What it can do

| Category | Operations |
|---|---|
| **Tickets** | Get, create, update, delete, change status, close |
| **Ticket notes** | List all notes, get single note, add note |
| **Ticket attachments** | List attachments |
| **Assignments** | Get, create, update, delete, change status, close |
| **Assignment notes** | List all notes, get single note, add note |
| **Assignment attachments** | List, predecessors, successors |
| **Solutions** | Get article, list attachments |
| **Search** | Full-text search across tickets, assignments, or both |
| **Field discovery** | Get valid field names before writing |
| **Priority suggestion** | Suggest priority from department/category/location/requestor |
| **Raw attachments** | Retrieve attachment by ID |

---

## Requirements

- **Claude Desktop** (Mac or Windows)
- **Node.js 18+** on each user's machine (used to run `server.js` inside the connector)
- Network access to the Track-It WebAPI (`http://your-server/TrackIt/WebApi`)

---

## Installation

### Option A — Install the pre-built connector (end users)

1. Download `trackit-mcp.mcpb` from the [Releases](../../releases) page.
2. Open **Claude Desktop** → Settings → **Connectors**.
3. Click **Install connector** and select `trackit-mcp.mcpb`.
4. Fill in the five configuration fields:

| Field | Example | Notes |
|---|---|---|
| Track-It API Base URL | `http://awsc-trackit-02/TrackIt/WebApi` | No trailing slash |
| Track-It Group | `HELP DESK` | Can contain spaces |
| Windows Domain | `ACMENETWORK` | |
| Username | `jsmith` | Login name only, no domain prefix |
| Password | `••••••••` | Your Windows password |

5. Claude will confirm the connector is active. Start a conversation and ask something like: *"Find open tickets assigned to me"* or *"What's the status of ticket 1234?"*

### Option B — Build from source (developers)

```bash
git clone https://github.com/ImperatorRuscal/TrackIt-MCP.git
cd TrackIt-MCP
npm install
npm run bundle
```

This produces `connector/trackit-mcp.mcpb`. Install it in Claude Desktop as above.

---

## How it works

```
Claude Desktop
    │
    │  spawns as child process
    ▼
server.js  (bundled Node.js MCP server)
    │
    │  stdio JSON-RPC (MCP protocol)
    │
    │  HTTP requests
    ▼
Track-It WebAPI  (http://your-server/TrackIt/WebApi)
```

The connector runs **locally on each user's machine** as a stdio MCP server. Claude Desktop spawns `server.js` (embedded in the `.mcpb` package) and communicates over stdin/stdout using the MCP protocol. The server authenticates to Track-It using OAuth2 password grant, caches tokens in memory, and silently refreshes them using the refresh token before they expire.

There is no cloud component and no data leaves your network.

---

## Authentication details

Track-It uses OAuth2 with a non-standard username format:

```
GROUP\DOMAIN\username
```

For example: `HELP DESK\ACMENETWORK\jsmith`

The connector assembles this automatically from the three separate configuration fields. Tokens are cached in memory per session (~30 minute lifetime) and renewed via refresh token without re-prompting for credentials.

---

## Example conversations

> **"Show me ticket 4821 and its full history"**

Claude will fetch the ticket, then immediately fetch all notes (the work log), and present a readable summary.

> **"Create a ticket: printer on 3rd floor not working, assign to helpdesk, priority High"**

Claude will first call `get_module_fields` to discover the exact field names, then create the ticket with the correct field values.

> **"Add a work note to ticket 4821: replaced toner cartridge, 15 minutes"**

Claude adds a note with the duration attached.

> **"What tickets are assigned to Sarah that have been open more than a week?"**

Claude searches for open tickets and filters by assignee.

> **"Close assignment 217 with a note that the issue was resolved"**

Claude closes the assignment and attaches a closing note in one step.

---

## Development

### Project structure

```
src/
  auth.ts              OAuth2 token management (password grant + refresh)
  trackit-client.ts    HTTP client — one function per Track-It API endpoint
  server-stdio.ts      MCP server — tool definitions and handlers

connector/
  manifest.json        MCPB manifest (user_config fields, env var wiring)

scripts/
  build-connector.mjs  esbuild bundle + ZIP packager (no external zip dep)
```

### Scripts

```bash
npm run bundle      # Full build: TypeScript → bundle → .mcpb
npm run build       # TypeScript compile only (outputs to dist/)
npx tsc --noEmit    # Type-check without emitting
```

### Environment variables (for local testing)

```bash
TRACKIT_BASE_URL=http://your-server/TrackIt/WebApi
TRACKIT_GROUP=HELP DESK
TRACKIT_DOMAIN=YOURDOMAIN
TRACKIT_USERNAME=jsmith
TRACKIT_PASSWORD=yourpassword

node connector/server.js   # should print: [trackit-mcp] v1.x.x started
```

### Track-It API quirks

A few non-obvious things baked into `trackit-client.ts`:

- **Create and update both use POST** — `POST /tickets` creates, `POST /tickets/{id}` updates. There is no PUT or PATCH.
- **Delete is also POST** — `POST /tickets/{id}/Delete`, not the HTTP DELETE method.
- **Pagination is in the path** — `GET /tickets/{id}/Notes/{pageSize}/{pageNumber}`. Use `0/0` to return all records.
- **Field names have spaces** — `"Assigned Tech"`, `"Note Type"`, `"Activity Code"`. These must be copied exactly.
- **`priorityheirarchy` is misspelled** in the API — that's the correct endpoint name.
- **Priority hierarchy takes IDs** — `DepartmentId`, `CategoryId`, `LocationId` are integers, not name strings.
- **Assignment notes have no `Private` flag** — only ticket notes support `Private: boolean`.

See `BOOTSTRAP.md` for the complete reference.

---

## License

MIT
