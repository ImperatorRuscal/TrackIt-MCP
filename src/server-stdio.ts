#!/usr/bin/env node
/**
 * Track-It 2021 MCP Server — stdio transport
 * Runs as a child process inside Claude Desktop via the MCPB connector.
 * All credentials come in via environment variables set by manifest.json user_config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as client from "./trackit-client.js";

const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `
You are connected to a BMC Track-It 2021 help-desk system.

Rules you must follow on every interaction:

1. DISCOVER FIELDS BEFORE WRITING: Before any create or update operation on a ticket or assignment,
   call get_module_fields (moduleSequence=1 for Tickets, 2 for Assignments). Use the returned field
   names exactly as returned — they contain spaces and are case-sensitive.

2. SEARCH BEFORE ID LOOKUP: Use search_records to find tickets or assignments by keyword.
   Do not guess IDs.

3. ALWAYS FETCH NOTES AFTER FETCHING A RECORD: After every get_ticket or get_assignment call,
   immediately call get_ticket_notes or get_assignment_notes. The notes contain the actual work
   log, diagnosis history, and decisions. Field values alone rarely tell the full story.

4. WRITE ATTRIBUTION: All write operations are automatically attributed to the authenticated user.
   Do not include author fields.
`.trim();

const server = new McpServer(
  { name: "trackit-mcp", version: SERVER_VERSION },
  { instructions: INSTRUCTIONS }
);

// ─── Helper ───────────────────────────────────────────────────────────────────

function text(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: str }] };
}

function noteSchema() {
  return z
    .object({
      note: z.string().describe('Text of the note'),
      noteType: z.string().optional().describe('Note type, e.g. "Work Note"'),
      activityCode: z.string().optional(),
      duration: z.string().optional().describe('Duration string, e.g. "00:30"'),
      private: z.boolean().optional(),
    })
    .optional()
    .describe("Optional note to attach to this operation");
}

function buildNoteDto(n?: {
  note: string;
  noteType?: string;
  activityCode?: string;
  duration?: string;
  private?: boolean;
}): Record<string, unknown> | undefined {
  if (!n) return undefined;
  return {
    Note: n.note,
    ...(n.noteType ? { "Note Type": n.noteType } : {}),
    ...(n.activityCode ? { "Activity Code": n.activityCode } : {}),
    ...(n.duration ? { Duration: n.duration } : {}),
    ...(n.private !== undefined ? { Private: n.private } : {}),
  };
}

// ─── Misc / Discovery ────────────────────────────────────────────────────────

server.tool(
  "get_module_fields",
  "Get field schema for a module. moduleSequence=1 for Tickets, 2 for Assignments. " +
    "ALWAYS call this before create or update operations to get exact field names.",
  { moduleSequence: z.number().int().describe("1=Tickets, 2=Assignments") },
  async ({ moduleSequence }) => text(await client.getModuleFields(moduleSequence))
);

server.tool(
  "search_records",
  "Full-text search across Track-It modules. " +
    "moduleId=1 for Tickets, 2 for Assignments; omit to search all modules.",
  {
    term: z.string().describe("Search keyword or phrase"),
    moduleId: z.number().int().optional().describe("1=Tickets, 2=Assignments; omit for all"),
    pageSize: z.number().int().optional().default(25),
    pageNumber: z.number().int().optional().default(0),
    maxContentLength: z.number().int().optional().default(500),
  },
  async ({ term, moduleId, pageSize, pageNumber, maxContentLength }) =>
    text(await client.search(term, moduleId, pageSize, pageNumber, maxContentLength))
);

server.tool(
  "get_priority_hierarchy",
  "Suggest a priority given integer IDs for department, category, location, and/or requestor. " +
    "All parameters are optional but at least one is needed for a useful result.",
  {
    departmentId: z.number().int().optional().describe("Department ID"),
    categoryId: z.number().int().optional().describe("Category ID"),
    locationId: z.number().int().optional().describe("Location ID"),
    requestorId: z.number().int().optional().describe("Requestor user ID"),
  },
  async ({ departmentId, categoryId, locationId, requestorId }) =>
    text(await client.getPriorityHierarchy(departmentId, categoryId, locationId, requestorId))
);

server.tool(
  "get_attachment",
  "Retrieve a raw attachment by its attachment ID.",
  { attachmentId: z.number().int() },
  async ({ attachmentId }) => text(await client.getAttachment(attachmentId))
);

// ─── Tickets ─────────────────────────────────────────────────────────────────

server.tool(
  "get_ticket",
  "Get a ticket by ID. After calling this, ALWAYS call get_ticket_notes to get the full work history.",
  { id: z.number().int().describe("Ticket ID") },
  async ({ id }) => text(await client.getTicket(id))
);

server.tool(
  "create_ticket",
  "Create a new ticket. FIRST call get_module_fields(1) to get valid field names. " +
    "Properties keys must match exactly (they contain spaces).",
  {
    properties: z
      .record(z.string(), z.unknown())
      .describe('Ticket fields, e.g. { "Summary": "...", "Priority": "...", "Assigned Tech": "..." }'),
    optionalParams: z.record(z.string(), z.unknown()).optional(),
    note: noteSchema(),
  },
  async ({ properties, optionalParams, note }) => {
    const noteDto = buildNoteDto(note);
    const params = { ...(optionalParams ?? {}), ...(noteDto ? { Note: noteDto } : {}) };
    return text(await client.createTicket(properties, params));
  }
);

server.tool(
  "update_ticket",
  "Update an existing ticket. FIRST call get_module_fields(1) to get valid field names. " +
    "Only include fields you want to change.",
  {
    id: z.number().int().describe("Ticket ID"),
    properties: z.record(z.string(), z.unknown()).describe("Fields to update"),
    optionalParams: z.record(z.string(), z.unknown()).optional(),
    note: noteSchema(),
  },
  async ({ id, properties, optionalParams, note }) => {
    const noteDto = buildNoteDto(note);
    const params = { ...(optionalParams ?? {}), ...(noteDto ? { Note: noteDto } : {}) };
    return text(await client.updateTicket(id, properties, params));
  }
);

server.tool(
  "delete_ticket",
  "Permanently delete a ticket. This cannot be undone.",
  { id: z.number().int().describe("Ticket ID") },
  async ({ id }) => text(await client.deleteTicket(id))
);

server.tool(
  "change_ticket_status",
  "Change the status of a ticket.",
  {
    id: z.number().int(),
    statusName: z.string().describe("New status name"),
    note: noteSchema(),
  },
  async ({ id, statusName, note }) =>
    text(await client.changeTicketStatus(id, statusName, buildNoteDto(note)))
);

server.tool(
  "close_ticket",
  "Close a ticket.",
  {
    id: z.number().int(),
    note: noteSchema(),
  },
  async ({ id, note }) => text(await client.closeTicket(id, buildNoteDto(note)))
);

server.tool(
  "get_ticket_notes",
  "Get all notes for a ticket. Always call this after get_ticket — notes contain the full work log.",
  {
    id: z.number().int(),
    maxContentLength: z.number().int().optional().default(2000),
    includeSystemNotes: z.boolean().optional().default(false),
  },
  async ({ id, maxContentLength, includeSystemNotes }) =>
    text(await client.getTicketNotes(id, maxContentLength, includeSystemNotes))
);

server.tool(
  "get_ticket_note",
  "Get a single ticket note by note ID.",
  { noteId: z.number().int() },
  async ({ noteId }) => text(await client.getTicketNote(noteId))
);

server.tool(
  "add_ticket_note",
  "Add a note to a ticket.",
  {
    id: z.number().int(),
    note: z.string().describe("Note text"),
    noteType: z.string().optional().describe('e.g. "Work Note"'),
    activityCode: z.string().optional(),
    duration: z.string().optional().describe('e.g. "00:30"'),
    private: z.boolean().optional(),
  },
  async ({ id, note, noteType, activityCode, duration, private: priv }) => {
    const dto: Record<string, unknown> = { Note: note };
    if (noteType) dto["Note Type"] = noteType;
    if (activityCode) dto["Activity Code"] = activityCode;
    if (duration) dto["Duration"] = duration;
    if (priv !== undefined) dto["Private"] = priv;
    return text(await client.addTicketNote(id, dto));
  }
);

server.tool(
  "get_ticket_attachments",
  "List attachments on a ticket.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getTicketAttachments(id))
);

server.tool(
  "get_ticket_assignments",
  "List child assignments linked to a ticket.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getTicketAssignments(id))
);

server.tool(
  "get_ticket_templates",
  "List available ticket templates.",
  {},
  async () => text(await client.getTicketTemplates())
);

// ─── Assignments ─────────────────────────────────────────────────────────────

server.tool(
  "get_assignment",
  "Get an assignment by ID. After calling this, ALWAYS call get_assignment_notes.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getAssignment(id))
);

server.tool(
  "create_assignment",
  "Create a new assignment. FIRST call get_module_fields(2) to get valid field names.",
  {
    properties: z.record(z.string(), z.unknown()).describe("Assignment fields"),
    optionalParams: z.record(z.string(), z.unknown()).optional(),
    note: noteSchema(),
  },
  async ({ properties, optionalParams, note }) => {
    const noteDto = buildNoteDto(note);
    const params = { ...(optionalParams ?? {}), ...(noteDto ? { Note: noteDto } : {}) };
    return text(await client.createAssignment(properties, params));
  }
);

server.tool(
  "update_assignment",
  "Update an existing assignment. FIRST call get_module_fields(2) to get valid field names.",
  {
    id: z.number().int(),
    properties: z.record(z.string(), z.unknown()).describe("Fields to update"),
    optionalParams: z.record(z.string(), z.unknown()).optional(),
    note: noteSchema(),
  },
  async ({ id, properties, optionalParams, note }) => {
    const noteDto = buildNoteDto(note);
    const params = { ...(optionalParams ?? {}), ...(noteDto ? { Note: noteDto } : {}) };
    return text(await client.updateAssignment(id, properties, params));
  }
);

server.tool(
  "delete_assignment",
  "Permanently delete an assignment.",
  { id: z.number().int() },
  async ({ id }) => text(await client.deleteAssignment(id))
);

server.tool(
  "change_assignment_status",
  "Change the status of an assignment.",
  {
    id: z.number().int(),
    statusName: z.string(),
    note: noteSchema(),
  },
  async ({ id, statusName, note }) =>
    text(await client.changeAssignmentStatus(id, statusName, buildNoteDto(note)))
);

server.tool(
  "close_assignment",
  "Close an assignment.",
  {
    id: z.number().int(),
    note: noteSchema(),
  },
  async ({ id, note }) => text(await client.closeAssignment(id, buildNoteDto(note)))
);

server.tool(
  "get_assignment_notes",
  "Get all notes for an assignment. Always call this after get_assignment.",
  {
    id: z.number().int(),
    maxContentLength: z.number().int().optional().default(2000),
    includeSystemNotes: z.boolean().optional().default(false),
  },
  async ({ id, maxContentLength, includeSystemNotes }) =>
    text(await client.getAssignmentNotes(id, maxContentLength, includeSystemNotes))
);

server.tool(
  "get_assignment_note",
  "Get a single assignment note by note ID.",
  { noteId: z.number().int() },
  async ({ noteId }) => text(await client.getAssignmentNote(noteId))
);

server.tool(
  "add_assignment_note",
  "Add a note to an assignment. Assignment notes do not support a Private flag.",
  {
    id: z.number().int(),
    note: z.string(),
    noteType: z.string().optional(),
    activityCode: z.string().optional(),
    duration: z.string().optional(),
  },
  async ({ id, note, noteType, activityCode, duration }) => {
    const dto: Record<string, unknown> = { Note: note };
    if (noteType) dto["Note Type"] = noteType;
    if (activityCode) dto["Activity Code"] = activityCode;
    if (duration) dto["Duration"] = duration;
    return text(await client.addAssignmentNote(id, dto));
  }
);

server.tool(
  "get_assignment_attachments",
  "List attachments on an assignment.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getAssignmentAttachments(id))
);

server.tool(
  "get_assignment_predecessors",
  "List predecessor assignments.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getAssignmentPredecessors(id))
);

server.tool(
  "get_assignment_successors",
  "List successor assignments.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getAssignmentSuccessors(id))
);

server.tool(
  "get_assignment_templates",
  "List available assignment templates.",
  {},
  async () => text(await client.getAssignmentTemplates())
);

// ─── Solutions ───────────────────────────────────────────────────────────────

server.tool(
  "get_solution",
  "Get a solution article by ID.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getSolution(id))
);

server.tool(
  "get_solution_attachments",
  "List attachments on a solution article.",
  { id: z.number().int() },
  async ({ id }) => text(await client.getSolutionAttachments(id))
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't corrupt the MCP JSON-RPC stream on stdout
  process.stderr.write(`[trackit-mcp] v${SERVER_VERSION} started\n`);
}

main().catch((err) => {
  process.stderr.write(`[trackit-mcp] fatal: ${err}\n`);
  process.exit(1);
});
