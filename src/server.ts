import "dotenv/config";
import { randomUUID } from "crypto";
import https from "https";
import fs from "fs";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { parseBasicAuth, getBearerToken, invalidateToken, getTrackItTokenForSession } from "./auth.js";
import { TokenStore } from "./token-store.js";
import { createOAuthRouter } from "./oauth.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerSolutionTools } from "./tools/solutions.js";
import { registerMiscTools } from "./tools/misc.js";

// ---------------------------------------------------------------------------
// Version — read once from package.json so health check and MCP metadata stay
// in sync without manual updates
// ---------------------------------------------------------------------------
const SERVER_VERSION: string = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")) as { version: string }
).version;

// Catch anything that escapes route handlers (e.g. async bugs in the MCP SDK)
process.on("unhandledRejection", (reason) => {
  console.error("[trackit-mcp] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[trackit-mcp] uncaughtException:", err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Validate required config at startup
// ---------------------------------------------------------------------------
if (!process.env.TRACKIT_BASE_URL) {
  console.error("ERROR: TRACKIT_BASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!process.env.TOKEN_STORE_SECRET) {
  console.error("ERROR: TOKEN_STORE_SECRET is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const SERVER_INSTRUCTIONS =
  "This server exposes BMC Track-It 2021 ITSM operations. " +
  "Before creating tickets or assignments, call get_module_fields " +
  "(moduleSequence=1 for Tickets, 2 for Assignments) to discover available " +
  "field names. Use the search tool to find records by keyword before looking " +
  "up by ID. All write operations are attributed to the authenticated user. " +
  "When investigating a specific ticket or assignment, always follow get_ticket " +
  "or get_assignment with get_ticket_notes or get_assignment_notes to see the " +
  "full history and work log — field values alone rarely tell the whole story.";

// ---------------------------------------------------------------------------
// Token store (encrypted persistent sessions)
// ---------------------------------------------------------------------------
const tokenStore = new TokenStore(process.env.TOKEN_STORE_SECRET);

// Prune expired sessions every hour
setInterval(() => {
  const pruned = tokenStore.prune();
  if (pruned > 0) console.log(`[token-store] pruned ${pruned} expired sessions`);
}, 3_600_000);

// ---------------------------------------------------------------------------
// UUID pattern — used to distinguish our OAuth tokens from legacy base64 creds
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  creds: { username: string; password: string } | null;
  ourToken: string | null;
}

const sessions = new Map<string, Session>();

/**
 * Build a new McpServer with all tools bound to the given getToken factory.
 * Credentials (legacy or OAuth) are captured in the closure at session-creation time.
 */
function createMcpServer(getToken: () => Promise<string>): McpServer {
  const server = new McpServer(
    { name: "trackit-mcp", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerTicketTools(server, getToken);
  registerAssignmentTools(server, getToken);
  registerSolutionTools(server, getToken);
  registerMiscTools(server, getToken);

  return server;
}

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for HTML form POST

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "trackit-mcp",
    version: SERVER_VERSION,
    activeSessions: sessions.size,
    storedTokens: tokenStore.size(),
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.0 endpoints (DCR, authorize, token, discovery)
// ---------------------------------------------------------------------------
app.use("/", createOAuthRouter(tokenStore));

// ---------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------
app.post("/mcp", async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const method   = (req.body as { method?: string } | undefined)?.method ?? "(unknown)";
  console.log(`[mcp] ${sessionId ? `session:${sessionId.slice(0, 8)}` : "new-session"} → ${method}`);

  // --- Existing session: route request to its transport ---
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired. Re-initialize the MCP connection." });
      return;
    }
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      console.error(`[mcp] error in session ${sessionId.slice(0, 8)} (${method}):`, err);
      next(err);
    }
    return;
  }

  // --- New session (initialize request) ---
  // Determine auth mode: OAuth UUID token or legacy Basic/Bearer base64 creds
  const authHeader = req.headers.authorization as string | undefined;

  let getToken: () => Promise<string>;
  let sessionCreds: { username: string; password: string } | null = null;
  let sessionOurToken: string | null = null;

  if (authHeader?.startsWith("Bearer ") && UUID_RE.test(authHeader.slice(7).trim())) {
    // OAuth mode — Bearer <our-uuid>
    const ourToken = authHeader.slice(7).trim();
    const record = tokenStore.get(ourToken);
    if (!record) {
      res.status(401).json({ error: "Invalid or expired OAuth token. Please re-authenticate." });
      return;
    }
    sessionOurToken = ourToken;
    getToken = async () => getTrackItTokenForSession(tokenStore, ourToken);
  } else {
    // Legacy mode — Basic or Bearer <base64(GROUP\DOMAIN\user:password)>
    const creds = parseBasicAuth(authHeader) ?? { username: "", password: "" };
    sessionCreds = creds;
    getToken = async () => {
      if (!creds.username) {
        throw new Error(
          "No credentials provided. Set one of the following headers on your MCP client:\n" +
            "  Authorization: Basic <base64(credentials)>\n" +
            "  Authorization: Bearer <base64(credentials)>  (for API-key-style clients)\n" +
            "Credential format: 'TRACK-IT GROUP\\DOMAIN\\username:password'\n" +
            "Example:           'HELP DESK\\CONTOSO\\jsmith:password'"
        );
      }
      try {
        return await getBearerToken(creds.username, creds.password);
      } catch (err: unknown) {
        invalidateToken(creds.username);
        const msg = err instanceof Error ? err.message : "Unknown authentication error";
        throw new Error(`Track-It authentication failed for '${creds.username}': ${msg}`);
      }
    };
  }

  let assignedSessionId: string | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      assignedSessionId = randomUUID();
      return assignedSessionId;
    },
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, creds: sessionCreds, ourToken: sessionOurToken });
      const user = sessionOurToken
        ? `OAuth:${tokenStore.get(sessionOurToken)?.username ?? "unknown"}`
        : (sessionCreds?.username || "(anonymous)");
      console.log(`[session] created ${id} for user '${user}' — total sessions: ${sessions.size}`);
    },
  });

  transport.onclose = () => {
    if (assignedSessionId) {
      sessions.delete(assignedSessionId);
      console.log(`[session] closed ${assignedSessionId} — total sessions: ${sessions.size}`);
    }
  };

  const server = createMcpServer(getToken);
  res.on("close", () => transport.close());
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: unknown) {
    console.error(`[mcp] error during initialize (${method}):`, err);
    next(err);
  }
});

// Reject non-POST on /mcp
app.all("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST." });
});

// JSON catch-all — prevents HTML 404s from breaking the MCP client's JSON parsers
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Express error handler — logs to console and returns JSON (not an HTML stack trace)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[trackit-mcp] unhandled route error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_server_error", message: msg });
  }
});

const { TLS_CERT_PATH, TLS_KEY_PATH } = process.env;

function logStartup(proto: string) {
  console.log(`trackit-mcp v${SERVER_VERSION} listening on ${proto}://0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint:  ${proto}://0.0.0.0:${PORT}/mcp`);
  console.log(`  Health check:  ${proto}://0.0.0.0:${PORT}/health`);
  console.log(`  OAuth login:   ${proto}://0.0.0.0:${PORT}/authorize`);
  console.log(`  Track-It API:  ${process.env.TRACKIT_BASE_URL}`);
}

if (TLS_CERT_PATH && TLS_KEY_PATH) {
  let key: Buffer, cert: Buffer;
  try {
    key = fs.readFileSync(TLS_KEY_PATH);
    cert = fs.readFileSync(TLS_CERT_PATH);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Failed to load TLS certificate files: ${msg}`);
    process.exit(1);
  }
  https.createServer({ key, cert }, app).listen(PORT, () => logStartup("https"));
} else {
  console.warn("WARNING: TLS_CERT_PATH / TLS_KEY_PATH not set — running plain HTTP (not recommended for production)");
  app.listen(PORT, () => logStartup("http"));
}
