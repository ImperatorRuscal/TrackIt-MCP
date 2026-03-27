# Track-It MCP Bootstrap Notes

Prompt-feeding knowledge base for building an MCP integration against BMC Track-It 2021.
These are the non-obvious things discovered through trial and error — not in the official docs.

---

## Track-It WebAPI location

- Base URL pattern: `http://SERVER/TrackIt/WebApi`
- Example: `http://awsc-trackit-02.acmenetwork.com/TrackIt/WebApi`
- Swagger UI is at: `http://SERVER/TrackIt/WebApi/swagger/ui/index`
- No trailing slash on the base URL — appending a trailing slash causes 404s on some endpoints

---

## Authentication

### Token endpoint
```
POST {TRACKIT_BASE_URL}/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=GROUP%5cDOMAIN%5cuser&password=PASS
```

### Username format — critical
The username must be in the format: `GROUP\DOMAIN\username`
- `GROUP` = the Track-It group name (e.g. `HELP DESK`) — can contain spaces
- `DOMAIN` = Windows domain (e.g. `ACMENETWORK`)
- `username` = Windows login name
- Separator is a backslash `\`, not forward slash
- Example: `HELP DESK\ACMENETWORK\jsmith`

### Token response
```json
{
  "access_token": "...",
  "token_type": "bearer",
  "expires_in": 1799,
  "refresh_token": "..."
}
```
- `expires_in` is approximately 1799 seconds (~30 minutes)
- `refresh_token` is present and **works** — use it to silently renew sessions
- Track-It does not advertise refresh token support in its Swagger docs; it works anyway

### Token refresh
```
POST {TRACKIT_BASE_URL}/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=TOKEN
```
Returns a new `access_token` and `refresh_token`.

### Using the token
All API calls use: `Authorization: Bearer {access_token}`

### Cache strategy that works
- Cache tokens per username (keyed by lowercase username)
- Invalidate ~60–120 seconds before expiry (don't wait for expiry exactly)
- On any 401 response: invalidate the cache entry and re-authenticate before retrying
- In-process in-memory cache is sufficient; no persistence needed per session

---

## API conventions — non-obvious

### Create and update both use POST
- Create: `POST /tickets` with body
- Update: `POST /tickets/{id}` with body
  (Not PUT. Not PATCH. POST again.)

### Delete is also POST
- `POST /tickets/{id}/Delete`
  (Not the DELETE HTTP method)

### Pagination convention
- Endpoints that return lists take `/{pageSize}/{pageNumber}` as **path segments**, not query params
- `pageSize=0, pageNumber=0` returns all records (no pagination)
- Example: `GET /tickets/{id}/Notes/0/0`

### Field names use spaces
- API returns fields as generic key-value pairs where keys have spaces
- Example: `"Note Type"`, `"Activity Code"`, `"Work Phone"`, `"Assigned Tech"`
- These are not camelCase or snake_case — copy field names exactly as returned

### Field discovery before write operations
- Before creating or updating, call `GET /module/{moduleSequence}/fields`
- Returns the full list of valid field names and their metadata
- Module sequences: **1 = Tickets**, **2 = Assignments** (check Swagger for others)
- Without this step an LLM will hallucinate field names and writes will fail

### `priorityheirarchy` typo in the API
- The endpoint name has a spelling error: **heirarchy** (not hierarchy)
- `POST /priorityheirarchy` — spell it wrong or it won't work

---

## Endpoint reference (all confirmed working)

### Tickets
| Method | Path | Notes |
|--------|------|-------|
| POST | `/tickets` | Create. Body: `{Properties: {...}, OptionalParams: {...}}` |
| GET | `/tickets/{id}` | Get single ticket |
| POST | `/tickets/{id}` | Update. Same body shape as create |
| GET | `/tickets/{id}/Notes/{pageSize}/{pageNumber}` | Note list. Query: `maxContentLength`, `SystemNote` |
| GET | `/tickets/Note/{noteId}` | Single note by ID |
| POST | `/tickets/{id}/AddNote` | Add note. Body: NoteDto |
| GET | `/tickets/{id}/Attachments/{pageSize}/{pageNumber}` | |
| GET | `/tickets/{id}/Assignments/{pageSize}/{pageNumber}` | Child assignments |
| POST | `/tickets/{id}/ChangeStatus` | Body: `{StatusName, Note?: NoteDto}` |
| POST | `/tickets/{id}/Close` | Body: `{Note?: NoteDto}` (can be empty `{}`) |
| POST | `/tickets/{id}/Delete` | No body needed |
| GET | `/tickets/Templates` | Available ticket templates |

### Assignments
| Method | Path | Notes |
|--------|------|-------|
| POST | `/assignments` | Create |
| GET | `/assignments/{id}` | Get |
| POST | `/assignments/{id}` | Update |
| GET | `/assignments/{id}/Notes/{pageSize}/{pageNumber}` | |
| GET | `/assignments/Note/{noteId}` | |
| POST | `/assignments/{id}/AddNote` | |
| GET | `/assignments/{id}/Attachments/{pageSize}/{pageNumber}` | |
| POST | `/assignments/{id}/ChangeStatus` | |
| POST | `/assignments/{id}/Close` | |
| POST | `/assignments/{id}/Delete` | |
| GET | `/assignments/{id}/Predecessors/{pageSize}/{pageNumber}` | |
| GET | `/assignments/{id}/Successors/{pageSize}/{pageNumber}` | |
| GET | `/assignments/Templates` | |

### Solutions
| Method | Path |
|--------|------|
| GET | `/solutions/{id}` |
| GET | `/solutions/{id}/Attachments/{pageSize}/{pageNumber}` |

### Misc
| Method | Path | Notes |
|--------|------|-------|
| GET | `/attachment/{attachmentId}` | Raw attachment by ID |
| GET | `/module/{moduleSequence}/fields` | Field schema for module |
| POST | `/searches` | Full-text search across modules |
| POST | `/priorityheirarchy` | Suggest priority from dept/category/location/requestor |
| GET | `/technicians/logout` | Invalidate server-side session |

### Search body shape
```json
{
  "Term": "keyword",
  "ModuleId": 1,
  "Mode": 0,
  "PageSize": 25,
  "PageNumber": 0,
  "MaxContentLength": 500
}
```
`ModuleId` 1 = Tickets, 2 = Assignments. Omit to search all modules.

### NoteDto shape
```json
{
  "Note Type": "Work Note",
  "Activity Code": "...",
  "Note": "text of the note",
  "Duration": "00:30",
  "Private": false
}
```
All fields optional — `Note` alone is the minimum for a useful note.

### Create/Update body shape
```json
{
  "Properties": {
    "Summary": "...",
    "Priority": "...",
    "Assigned Tech": "..."
  },
  "OptionalParams": {
    "Param1": null,
    "Param2": null,
    "Note": { "Note": "optional inline note on create/update" }
  }
}
```

---

## LLM system instructions that produced good results

Include all of these in the MCP server's `instructions` field:

1. **Discover fields before writing**: Call `get_module_fields` (moduleSequence=1 for Tickets, 2 for Assignments) before any create or update. Use the returned field names exactly.

2. **Search before ID lookup**: Use the search tool to find records by keyword rather than guessing IDs.

3. **Always fetch notes after fetching a record**: Field values on a ticket or assignment rarely tell the whole story. After every `get_ticket` or `get_assignment`, immediately call `get_ticket_notes` or `get_assignment_notes`. The notes contain the actual work log, diagnosis history, and decisions.

4. **Write attribution**: All write operations (create, update, notes) are attributed to the authenticated user, so no need to include an author field.

---

## MCP connector (MCPB) — what actually works for Claude Desktop

### Architecture decision
- **Stdio transport, not HTTP streaming** — Claude Desktop runs the MCP server as a local child process. The Claude.ai web UI tries to reach MCP servers from the public internet, so an intranet HTTP server will never be reachable from the web UI.
- Run the full MCP server logic locally on each user's machine via the MCPB connector.

### MCPB format
- A `.mcpb` file is a ZIP archive renamed to `.mcpb`
- Contains: `manifest.json` + `server.js` (no `node_modules` required if you bundle)
- Use esbuild to bundle all dependencies into a single `server.js`:
  ```
  npx esbuild src/server-stdio.ts --bundle --platform=node --target=node18 --format=cjs --outfile=connector/server.js
  ```

### manifest.json required fields
```json
{
  "manifest_version": "0.3",
  "name": "your-connector-id",
  "display_name": "Human-readable name",
  "version": "1.0.0",
  "server": {
    "type": "node",
    "entry_point": "server.js",
    "mcp_config": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "SOME_HARDCODED_URL": "https://...",
        "USER_VALUE": "${user_config.fieldname}"
      }
    }
  },
  "user_config": {
    "fieldname": {
      "type": "string",
      "title": "Label shown in UI",
      "description": "Helper text",
      "required": true,
      "sensitive": true
    }
  }
}
```
- `command` is **required** — the schema rejects manifests without it
- `entry_point` and `command/args` can coexist; `command/args` takes precedence for execution
- `${user_config.fieldname}` substitution works in `env` values; it does **not** work in `args`
- `"sensitive": true` on a user_config field masks the value in the UI

### Things that don't work
- `${__dirname}` in `args` — not substituted, passed as a literal string
- `child_process.spawn()` — Claude Desktop's embedded Node.js sandboxes this module; any connector that tries to spawn a subprocess will silently fail with no error output
- `fs` module writes — may also be sandboxed; don't rely on file I/O in connector code
- Remote HTTP MCP servers from Claude.ai web — intranet servers are unreachable; only works if the server has a public URL

### Node.js built-ins that are confirmed available in the embedded runtime
`https`, `http`, `readline`, `Buffer`, `URL`, `process`, `crypto`

---

## Environment variables needed for stdio connector

```
TRACKIT_BASE_URL=http://SERVER/TrackIt/WebApi   # Track-It API, no trailing slash
TRACKIT_GROUP=HELP DESK                          # Track-It group name
TRACKIT_DOMAIN=YOURDOMAIN                        # Windows domain
TRACKIT_USERNAME=jsmith                          # Login name only, no domain prefix
TRACKIT_PASSWORD=...                             # Windows password
TOKEN_TTL_MS=1680000                             # Optional, default 28 min (28 * 60 * 1000)
```
