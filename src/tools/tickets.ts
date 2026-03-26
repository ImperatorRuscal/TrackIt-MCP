import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../trackit-client.js";

// Shared schema fragments
const paginationSchema = {
  pageSize: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of records to return. 0 returns all."),
  pageNumber: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Page number. 0 returns all."),
};

const noteSchema = z.object({
  "Note Type": z
    .string()
    .optional()
    .describe("Note type label (e.g. 'Resolution', 'User Note')"),
  "Activity Code": z.string().optional().describe("Activity code string"),
  Note: z.string().optional().describe("Note body text"),
  Duration: z
    .string()
    .optional()
    .describe("Time spent, e.g. '0:30' for 30 minutes"),
  Private: z.boolean().optional().describe("Whether this note is private"),
});

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function registerTicketTools(
  server: McpServer,
  getToken: () => Promise<string>
) {
  // -------------------------------------------------------------------
  // get_ticket_templates
  // -------------------------------------------------------------------
  server.registerTool(
    "get_ticket_templates",
    {
      description:
        "Returns all active Ticket Templates. Use this to discover available templates and their default field values before creating a ticket.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(await api.getTicketTemplates(await getToken()))
  );

  // -------------------------------------------------------------------
  // get_ticket
  // -------------------------------------------------------------------
  server.registerTool(
    "get_ticket",
    {
      description:
        "Get all fields and values for a specific ticket by its numeric ID. Returns sequence IDs, display names, and values for every field. When investigating an issue, follow up with get_ticket_notes to see the full history and resolution notes.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const result = await api.getTicket(await getToken(), id);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
          {
            type: "text" as const,
            text: "Tip: call get_ticket_notes with this ticket ID to retrieve the full history, work log, and resolution notes.",
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------
  // create_ticket
  // -------------------------------------------------------------------
  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a new ticket. The Properties object is a key-value map where keys are field Display Names (e.g. 'Subject', 'Priority', 'Requestor', 'Category') and values are the desired field values. Call get_ticket_templates or get_module_fields (moduleSequence=1 for Tickets) first to discover available field names.",
      inputSchema: {
        properties: z
          .record(z.unknown())
          .describe(
            "Key-value map of field Display Name or Sequence ID to value. Example: { \"Subject\": \"Printer not working\", \"Priority\": \"High\" }"
          ),
      },
    },
    async ({ properties }) =>
      ok(
        await api.createTicket(await getToken(), { Properties: properties })
      )
  );

  // -------------------------------------------------------------------
  // update_ticket
  // -------------------------------------------------------------------
  server.registerTool(
    "update_ticket",
    {
      description:
        "Update fields on an existing ticket. Only supply fields you want to change in the properties map. Keys are field Display Names or Sequence IDs.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
        properties: z
          .record(z.unknown())
          .describe("Fields to update (Display Name or Sequence ID → value)"),
        note: noteSchema
          .optional()
          .describe("Optional note to attach alongside the update"),
      },
    },
    async ({ id, properties, note }) =>
      ok(
        await api.updateTicket(await getToken(), id, {
          Properties: properties,
          ...(note ? { OptionalParams: { Note: note } } : {}),
        })
      )
  );

  // -------------------------------------------------------------------
  // get_ticket_notes
  // -------------------------------------------------------------------
  server.registerTool(
    "get_ticket_notes",
    {
      description:
        "Get all notes (including resolution notes and history) for a ticket. Set systemNote=true to also return automated system notes. Use maxContentLength=-1 to retrieve full note text.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
        ...paginationSchema,
        maxContentLength: z
          .number()
          .int()
          .optional()
          .describe(
            "Maximum characters of note content to return. -1 returns all."
          ),
        systemNote: z
          .boolean()
          .optional()
          .describe("Include system-generated notes (default: false)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber, maxContentLength, systemNote }) =>
      ok(
        await api.getTicketNotes(
          await getToken(),
          id,
          pageSize,
          pageNumber,
          maxContentLength,
          systemNote
        )
      )
  );

  // -------------------------------------------------------------------
  // get_ticket_note_by_id
  // -------------------------------------------------------------------
  server.registerTool(
    "get_ticket_note_by_id",
    {
      description:
        "Get a single ticket note by its Note ID. Returns all fields for that specific note record.",
      inputSchema: {
        noteId: z.number().int().describe("Note ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ noteId }) =>
      ok(await api.getTicketNoteById(await getToken(), noteId))
  );

  // -------------------------------------------------------------------
  // add_ticket_note
  // -------------------------------------------------------------------
  server.registerTool(
    "add_ticket_note",
    {
      description:
        "Add a new note to a ticket. Use this to log work, update status, or record communications. The note will be attributed to the authenticated technician.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
        note: noteSchema.describe("Note content and metadata"),
      },
    },
    async ({ id, note }) =>
      ok(await api.addTicketNote(await getToken(), id, note))
  );

  // -------------------------------------------------------------------
  // get_ticket_attachments
  // -------------------------------------------------------------------
  server.registerTool(
    "get_ticket_attachments",
    {
      description:
        "List all attachments linked to a ticket. Returns attachment metadata; use get_attachment to retrieve the content of a specific attachment.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
        ...paginationSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber }) =>
      ok(
        await api.getTicketAttachments(await getToken(), id, pageSize, pageNumber)
      )
  );

  // -------------------------------------------------------------------
  // get_ticket_assignments
  // -------------------------------------------------------------------
  server.registerTool(
    "get_ticket_assignments",
    {
      description:
        "List all Assignments linked to a ticket (work orders derived from this ticket).",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
        ...paginationSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber }) =>
      ok(
        await api.getTicketAssignments(
          await getToken(),
          id,
          pageSize,
          pageNumber
        )
      )
  );

  // -------------------------------------------------------------------
  // change_ticket_status
  // -------------------------------------------------------------------
  server.registerTool(
    "change_ticket_status",
    {
      description:
        "Change a ticket's status to a specific named status. Use close_ticket instead if you want to close/resolve using the default closed status.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID"),
        statusName: z
          .string()
          .describe("Exact status name, e.g. 'In Progress', 'Pending'"),
        note: noteSchema
          .optional()
          .describe("Optional note to record with the status change"),
      },
    },
    async ({ id, statusName, note }) =>
      ok(
        await api.changeTicketStatus(await getToken(), id, {
          StatusName: statusName,
          ...(note ? { Note: note } : {}),
        })
      )
  );

  // -------------------------------------------------------------------
  // close_ticket
  // -------------------------------------------------------------------
  server.registerTool(
    "close_ticket",
    {
      description:
        "Close/resolve a ticket using the default 'Closed' status. Optionally attach a resolution note describing how the issue was resolved. This is the primary way to mark tickets as resolved.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID to close"),
        note: noteSchema
          .optional()
          .describe(
            "Resolution note. Recommended: set Note Type to 'Resolution' and provide the resolution description in the Note field."
          ),
      },
    },
    async ({ id, note }) =>
      ok(
        await api.closeTicket(await getToken(), id, note ? { Note: note } : undefined)
      )
  );

  // -------------------------------------------------------------------
  // delete_ticket
  // -------------------------------------------------------------------
  server.registerTool(
    "delete_ticket",
    {
      description:
        "Permanently delete a ticket. This action cannot be undone. Confirm with the user before calling this tool.",
      inputSchema: {
        id: z.number().int().describe("Ticket ID to delete"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => ok(await api.deleteTicket(await getToken(), id))
  );
}
