# TrackIt-MCP

An MCP (Model Context Protocol) server that exposes BMC Track-It 2021 to AI assistants (Claude Code, Claude Desktop, etc.) over streamable HTTP.

## Features

- **32 tools** covering Tickets, Assignments, Solutions, Search, and more
- **Per-user authentication** — each MCP client connects with their own Track-It credentials; all actions are attributed to the real technician
- **OAuth 2.0 flow** — MCP clients that support OAuth (Claude Desktop) authenticate via an HTML login form; a long-lived UUID token is issued and persists across server restarts
- **Token caching + JIT refresh** — Track-It bearer tokens are cached and refreshed transparently using `refresh_token`; users are never prompted to re-authenticate mid-session
- **Encrypted persistent sessions** — OAuth sessions survive server restarts via AES-256-GCM encrypted storage
- **Plain HTTP** on the internal network — no TLS required for corporate intranet use

## Architecture

```
MCP Client (Claude Desktop — OAuth flow)
    │
    │  Browser redirect → GET /authorize (HTML login form)
    │  POST /authorize → auth code → POST /token → UUID token
    │  HTTPS POST /mcp  +  Authorization: Bearer <uuid>
    ▼
trackit-mcp  (this server, port 3000, HTTPS)
    │
    │  Track-It bearer token (obtained via password grant, refreshed via refresh_token)
    ▼
Track-It WebAPI  (http://awsc-trackit-02.acmenetwork.com/TrackIt/WebApi)

─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

MCP Client (Claude Code — legacy Basic/Bearer auth)
    │
    │  HTTPS POST /mcp  +  Authorization: Basic <base64("GROUP\DOMAIN\user:pass")>
    ▼
trackit-mcp  (this server, port 3000, HTTPS)
    │
    │  Track-It bearer token (obtained + cached from /WebApi/token)
    ▼
Track-It WebAPI  (http://awsc-trackit-02.acmenetwork.com/TrackIt/WebApi)
```

---

## Server Setup (Windows Server)

### Prerequisites

1. **Node.js 20+** — download from https://nodejs.org
2. **PM2** — `npm install -g pm2`

### Install

```cmd
cd D:\src\TrackIt-MCP
npm install
```

### Configure

```cmd
copy .env.example .env
notepad .env
```

Edit `.env`:
```
TRACKIT_BASE_URL=http://awsc-trackit-02.acmenetwork.com/TrackIt/WebApi
PORT=3000
TOKEN_TTL_MS=1680000
TOKEN_STORE_SECRET=<long-random-string>   # required — encrypts the OAuth session store
MCP_SERVER_URL=https://awsc-trackit-02.acmenetwork.com:3000  # used in OAuth discovery
OUR_TOKEN_TTL_MS=7776000000               # optional — OAuth token lifetime, default 90 days
TLS_CERT_PATH=certs/server.cert           # path to TLS certificate (PEM)
TLS_KEY_PATH=certs/server.key             # path to TLS private key (PEM)
```

### Set up TLS

The server runs HTTPS when `TLS_CERT_PATH` and `TLS_KEY_PATH` are set in `.env`.

**Option A — Self-signed certificate (quick start / testing)**

```cmd
npm run generate-cert
```

This creates `certs/server.key` and `certs/server.cert` (valid 365 days). MCP clients will reject self-signed certs unless the cert is trusted. On the client machine, run once as Administrator:

```powershell
Import-Certificate -FilePath certs\server.cert -CertStoreLocation Cert:\LocalMachine\Root
```

**Option B — Internal CA certificate (recommended for production)**

Request a certificate from your CA for the server's hostname, then place the PEM files anywhere accessible to the server process and set `TLS_CERT_PATH` / `TLS_KEY_PATH` in `.env` accordingly. No other changes needed.

### Build

```cmd
npm run build
```

### Run (development)

```cmd
npm run dev
```

### Run (production with PM2)

```cmd
mkdir logs
pm2 start ecosystem.config.js
pm2 save

:: Auto-start on Windows boot — follow the printed instructions:
pm2 startup
```

### Verify

```
curl https://localhost:3000/health
```

> If using a self-signed cert and curl rejects it, add `-k` for the health check only:
> `curl -k https://localhost:3000/health`

Expected: `{"status":"ok","server":"trackit-mcp","version":"1.0.0","activeSessions":0,"storedTokens":0}`

---

## Connecting MCP Clients

### Credential format

Track-It usernames follow a three-part format:

```
<Track-It Group>\<Windows Domain>\<username>:<password>
```

For example, technician `jsmith` in the **Help Desk** group on the **CONTOSO** domain:

```
HELP DESK\CONTOSO\jsmith:yourpassword
```

That full string is base64-encoded and used as the credential payload (see below).

### Generating your base64 credential string

```powershell
# Windows PowerShell:
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('HELP DESK\CONTOSO\jsmith:yourpassword'))
```

```bash
# Git Bash / WSL / Mac:
echo -n 'HELP DESK\CONTOSO\jsmith:yourpassword' | base64
```

### Choosing Basic vs Bearer

The server accepts the base64 credential string in **either** header format — use whichever your MCP client supports:

| Header | Use when |
|--------|----------|
| `Authorization: Basic <b64>` | Client supports standard HTTP Basic Auth |
| `Authorization: Bearer <b64>` | Client only supports API-key / Bearer token configuration |

Both headers carry the **same** base64 payload. The server decodes and authenticates identically regardless of which prefix is used.

### Claude Code

```bash
claude mcp add --transport http --scope user trackit \
  https://awsc-trackit-02.acmenetwork.com:3000/mcp \
  --header "Authorization: Basic <paste-base64-output-here>"
```

Or project-locally (inside a project directory):

```bash
claude mcp add --transport http trackit \
  https://awsc-trackit-02.acmenetwork.com:3000/mcp \
  --header "Authorization: Basic <paste-base64-output-here>"
```

### Claude Desktop

**Use Basic Auth** (same as Claude Code above):

1. Open Claude Desktop settings
2. Go to **Connectors** → **Add custom connector**
3. Set URL to: `https://awsc-trackit-02.acmenetwork.com:3000/mcp`
4. Add header: `Authorization: Basic <base64("TRACK-IT GROUP\DOMAIN\username:password")>`
   (or `Authorization: Bearer <same-base64>` if the client only supports Bearer)

> **Why not OAuth for internal deployments?**
> Claude Desktop's OAuth flow routes the token exchange through `claude.ai` servers, which cannot reach an internal corporate network. If you connect without an Authorization header, the browser will redirect to claude.ai for the callback and time out. Use Basic Auth instead — it works identically and routes entirely over your internal network.

### MCP Inspector (for testing)

```bash
npx @modelcontextprotocol/inspector
```
Select "Streamable HTTP", paste `https://localhost:3000/mcp` (or `http://` if running without TLS), then add the Authorization header before connecting.

### OAuth 2.0 Flow (internet-accessible deployments only)

> **Internal network note:** Claude Desktop's OAuth flow routes the authorization code exchange through `claude.ai` servers. If this server is on a private/corporate network, the exchange will time out because `claude.ai` cannot reach it. Use Basic Auth instead (see Claude Desktop section above).

For internet-accessible deployments, MCP clients that support OAuth 2.0 will automatically:

1. Discover the OAuth server at `/.well-known/oauth-authorization-server`
2. Register a client at `POST /register` (DCR)
3. Redirect the user to `GET /authorize` — an HTML login form asking for Track-It credentials
4. POST credentials back; the server authenticates against Track-It and issues a short-lived auth code
5. Exchange the auth code for a long-lived UUID token at `POST /token`
6. Store the UUID token and use it for all subsequent MCP requests

**Long-lived sessions:** The issued token is valid for 90 days (configurable via `OUR_TOKEN_TTL_MS`). The server silently refreshes the underlying Track-It token using `refresh_token` whenever it's within 60 seconds of expiry — users are never prompted to re-authenticate during a session.

---

## Available Tools

### Discovery (start here)

| Tool | Description |
|------|-------------|
| `search` | Search tickets, assignments, or solutions by keyword. ModuleId: 1=Tickets, 2=Assignments, 3=Solutions |
| `get_module_fields` | List all available field names for a module. Call before create_ticket/create_assignment |

### Tickets

| Tool | Description |
|------|-------------|
| `get_ticket_templates` | List active ticket templates |
| `get_ticket` | Get all fields for a ticket by ID |
| `create_ticket` | Create a new ticket |
| `update_ticket` | Update ticket fields |
| `get_ticket_notes` | Get all notes/history for a ticket |
| `get_ticket_note_by_id` | Get a single note by Note ID |
| `add_ticket_note` | Add a note to a ticket |
| `get_ticket_attachments` | List attachments on a ticket |
| `get_ticket_assignments` | List assignments linked to a ticket |
| `change_ticket_status` | Change ticket status by name |
| `close_ticket` | Close/resolve a ticket (with optional resolution note) |
| `delete_ticket` | Permanently delete a ticket |

### Assignments

| Tool | Description |
|------|-------------|
| `get_assignment_templates` | List active assignment templates |
| `get_assignment` | Get all fields for an assignment by ID |
| `create_assignment` | Create a new assignment |
| `update_assignment` | Update assignment fields |
| `get_assignment_notes` | Get all notes for an assignment |
| `get_assignment_note_by_id` | Get a single assignment note |
| `add_assignment_note` | Add a note to an assignment |
| `get_assignment_attachments` | List attachments on an assignment |
| `change_assignment_status` | Change assignment status |
| `close_assignment` | Close an assignment |
| `delete_assignment` | Permanently delete an assignment |
| `get_assignment_predecessors` | Get predecessor assignments |
| `get_assignment_successors` | Get successor assignments |

### Solutions

| Tool | Description |
|------|-------------|
| `get_solution` | Get a solution from the knowledge base by ID |
| `get_solution_attachments` | List attachments on a solution |

### Other

| Tool | Description |
|------|-------------|
| `get_attachment` | Get attachment details by ID |
| `get_priority_hierarchy` | Calculate priority based on dept/category/location/requestor |
| `logout` | Log out the current technician session |

---

## Track-It Field Model

Track-It uses a **metadata-driven field model** — fields are identified by Display Name or Sequence ID rather than fixed property names. This means:

1. **Before creating a ticket**: call `get_module_fields(moduleSequence=1)` to see all available field names
2. **Pass fields as a dictionary**: `{"Subject": "Printer broken", "Priority": "High", "Requestor": "John Smith"}`
3. **Field names are case-sensitive** and match the Display Names shown in Track-It

---

## Troubleshooting

**401 from MCP server**: Your Basic Auth header is missing or malformed. The credential string must be `TRACK-IT GROUP\DOMAIN\username:password` — all three parts are required (e.g. `HELP DESK\CONTOSO\jsmith:password`), base64-encoded.

**401 from Track-It**: Your Track-It credentials are wrong, or your account doesn't have API access. Verify by logging into Track-It directly.

**Connection refused**: Check that PM2 has the server running (`pm2 list`) and the Windows Firewall allows inbound on port 3000.

**Token errors mid-session**: Track-It tokens expire after 30 minutes. The MCP server caches tokens for 28 minutes, so this should be rare. If it happens, the next tool call will re-authenticate automatically.

**OAuth login form shows "Invalid credentials"**: Verify the Track-It Group, Domain, and username are correct. The username format is `GROUP\DOMAIN\username` — all three parts are required. Ensure the `TRACKIT_BASE_URL` in `.env` points to the correct Track-It server.

**MCP client keeps prompting to re-authenticate**: The server may have restarted and lost in-memory sessions. Sessions are persisted to the encrypted `data/token-store.enc` file — verify `TOKEN_STORE_SECRET` hasn't changed and the `data/` directory is writable.
