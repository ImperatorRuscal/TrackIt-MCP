import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../trackit-client.js";

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
  "Note Type": z.string().optional(),
  "Activity Code": z.string().optional(),
  Note: z.string().optional(),
  Duration: z.string().optional(),
});

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function registerAssignmentTools(
  server: McpServer,
  getToken: () => Promise<string>
) {
  // -------------------------------------------------------------------
  // get_assignment_templates
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment_templates",
    {
      description:
        "Returns all active Assignment Templates. Call this before creating an assignment to discover available templates and default field values.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(await api.getAssignmentTemplates(await getToken()))
  );

  // -------------------------------------------------------------------
  // get_assignment
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment",
    {
      description:
        "Get all fields and values for a specific assignment by its numeric ID. When investigating an assignment, follow up with get_assignment_notes to see the full work log and history.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const result = await api.getAssignment(await getToken(), id);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
          {
            type: "text" as const,
            text: "Tip: call get_assignment_notes with this assignment ID to retrieve the full work log and history.",
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------
  // create_assignment
  // -------------------------------------------------------------------
  server.registerTool(
    "create_assignment",
    {
      description:
        "Create a new assignment (work order). The properties map uses field Display Names as keys. Call get_assignment_templates or get_module_fields (moduleSequence=2 for Assignments) to discover available fields.",
      inputSchema: {
        properties: z
          .record(z.unknown())
          .describe(
            "Key-value map of field Display Name or Sequence ID to value"
          ),
      },
    },
    async ({ properties }) =>
      ok(
        await api.createAssignment(await getToken(), { Properties: properties })
      )
  );

  // -------------------------------------------------------------------
  // update_assignment
  // -------------------------------------------------------------------
  server.registerTool(
    "update_assignment",
    {
      description:
        "Update fields on an existing assignment. Only supply fields you want to change.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
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
        await api.updateAssignment(await getToken(), id, {
          Properties: properties,
          ...(note ? { OptionalParams: { Note: note } } : {}),
        })
      )
  );

  // -------------------------------------------------------------------
  // get_assignment_notes
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment_notes",
    {
      description:
        "Get all notes and history entries for an assignment. Use maxContentLength=-1 for full note text.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
        ...paginationSchema,
        maxContentLength: z
          .number()
          .int()
          .optional()
          .describe("Max characters of note text. -1 returns all."),
        systemNote: z
          .boolean()
          .optional()
          .describe("Include system-generated notes"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber, maxContentLength, systemNote }) =>
      ok(
        await api.getAssignmentNotes(
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
  // get_assignment_note_by_id
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment_note_by_id",
    {
      description: "Get a single assignment note by its Note ID.",
      inputSchema: {
        noteId: z.number().int().describe("Note ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ noteId }) =>
      ok(await api.getAssignmentNoteById(await getToken(), noteId))
  );

  // -------------------------------------------------------------------
  // add_assignment_note
  // -------------------------------------------------------------------
  server.registerTool(
    "add_assignment_note",
    {
      description: "Add a note to an assignment to log work or communications.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
        note: noteSchema.describe("Note content"),
      },
    },
    async ({ id, note }) =>
      ok(await api.addAssignmentNote(await getToken(), id, note))
  );

  // -------------------------------------------------------------------
  // get_assignment_attachments
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment_attachments",
    {
      description:
        "List all attachments linked to an assignment. Use get_attachment to retrieve content.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
        ...paginationSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber }) =>
      ok(
        await api.getAssignmentAttachments(
          await getToken(),
          id,
          pageSize,
          pageNumber
        )
      )
  );

  // -------------------------------------------------------------------
  // change_assignment_status
  // -------------------------------------------------------------------
  server.registerTool(
    "change_assignment_status",
    {
      description:
        "Change an assignment's status to a specific named status.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
        statusName: z
          .string()
          .describe("Exact status name, e.g. 'In Progress'"),
        note: noteSchema.optional().describe("Optional note for this change"),
      },
    },
    async ({ id, statusName, note }) =>
      ok(
        await api.changeAssignmentStatus(await getToken(), id, {
          StatusName: statusName,
          ...(note ? { Note: note } : {}),
        })
      )
  );

  // -------------------------------------------------------------------
  // close_assignment
  // -------------------------------------------------------------------
  server.registerTool(
    "close_assignment",
    {
      description:
        "Close an assignment using the default 'Closed' status. Attach a resolution note to document completion.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID to close"),
        note: noteSchema.optional().describe("Completion/resolution note"),
      },
    },
    async ({ id, note }) =>
      ok(
        await api.closeAssignment(
          await getToken(),
          id,
          note ? { Note: note } : undefined
        )
      )
  );

  // -------------------------------------------------------------------
  // delete_assignment
  // -------------------------------------------------------------------
  server.registerTool(
    "delete_assignment",
    {
      description:
        "Permanently delete an assignment. Cannot be undone. Confirm with the user first.",
      inputSchema: {
        id: z.number().int().describe("Assignment ID to delete"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => ok(await api.deleteAssignment(await getToken(), id))
  );

  // -------------------------------------------------------------------
  // get_assignment_predecessors
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment_predecessors",
    {
      description:
        "Get all predecessor assignments for a given assignment (assignments that must complete before this one can start).",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
        ...paginationSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber }) =>
      ok(
        await api.getAssignmentPredecessors(
          await getToken(),
          id,
          pageSize,
          pageNumber
        )
      )
  );

  // -------------------------------------------------------------------
  // get_assignment_successors
  // -------------------------------------------------------------------
  server.registerTool(
    "get_assignment_successors",
    {
      description:
        "Get all successor assignments for a given assignment (assignments that cannot start until this one completes).",
      inputSchema: {
        id: z.number().int().describe("Assignment ID"),
        ...paginationSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber }) =>
      ok(
        await api.getAssignmentSuccessors(
          await getToken(),
          id,
          pageSize,
          pageNumber
        )
      )
  );
}
