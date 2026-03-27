// src/server-stdio.ts
// Local stdio MCP server — used by the MCPB connector.
//
// Claude Desktop runs this as a child process (via the connector's entry_point).
// All configuration arrives as environment variables from the connector manifest.
// No HTTP server, no OAuth, no TLS complexity — pure stdio JSON-RPC.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBearerToken, invalidateToken } from "./auth.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerSolutionTools } from "./tools/solutions.js";
import { registerMiscTools } from "./tools/misc.js";

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
// Validate environment
// ---------------------------------------------------------------------------
if (!process.env.TRACKIT_BASE_URL) {
  process.stderr.write("[trackit-mcp] ERROR: TRACKIT_BASE_URL is not set.\n");
  process.exit(1);
}

const GROUP    = (process.env.TRACKIT_GROUP    ?? "").trim();
const DOMAIN   = (process.env.TRACKIT_DOMAIN   ?? "").trim();
const USERNAME = (process.env.TRACKIT_USERNAME ?? "").trim();
const PASSWORD =  process.env.TRACKIT_PASSWORD ?? "";

if (!GROUP || !DOMAIN || !USERNAME || !PASSWORD) {
  process.stderr.write(
    "[trackit-mcp] ERROR: Missing credentials " +
    "(TRACKIT_GROUP, TRACKIT_DOMAIN, TRACKIT_USERNAME, TRACKIT_PASSWORD).\n"
  );
  process.exit(1);
}

const fullUsername = `${GROUP}\\${DOMAIN}\\${USERNAME}`;

// ---------------------------------------------------------------------------
// Token factory — wraps getBearerToken with cache invalidation on failure
// ---------------------------------------------------------------------------
const getToken = async (): Promise<string> => {
  try {
    return await getBearerToken(fullUsername, PASSWORD);
  } catch (err: unknown) {
    invalidateToken(fullUsername);
    const msg = err instanceof Error ? err.message : "Unknown error";
    throw new Error(`Track-It authentication failed for '${fullUsername}': ${msg}`);
  }
};

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "trackit-mcp", version: "1.0.0" },
  { instructions: SERVER_INSTRUCTIONS }
);

registerTicketTools(server, getToken);
registerAssignmentTools(server, getToken);
registerSolutionTools(server, getToken);
registerMiscTools(server, getToken);

// ---------------------------------------------------------------------------
// Connect via stdio (Claude Desktop manages the process lifetime)
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    "[trackit-mcp] Fatal: " +
    (err instanceof Error ? err.message : String(err)) + "\n"
  );
  process.exit(1);
});
