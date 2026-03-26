/**
 * Miscellaneous tools: search, module fields, attachments,
 * priority hierarchy, and technician logout.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../trackit-client.js";

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function registerMiscTools(
  server: McpServer,
  getToken: () => Promise<string>
) {
  // -------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------
  server.registerTool(
    "search",
    {
      description:
        "Search across Track-It records by keyword. Use ModuleId to restrict the search: 1=Tickets, 2=Assignments, 3=Solutions. Leave ModuleId unset to search all modules. Mode controls search behavior (0=default). Returns matched records with field values.",
      inputSchema: {
        term: z.string().describe("Search term or keywords"),
        moduleId: z
          .number()
          .int()
          .optional()
          .describe("Module to search: 1=Tickets, 2=Assignments, 3=Solutions. Omit to search all."),
        mode: z
          .number()
          .int()
          .optional()
          .default(0)
          .describe("Search mode (0 = default)"),
        pageSize: z
          .number()
          .int()
          .min(0)
          .default(25)
          .describe("Results per page. 0 = all."),
        pageNumber: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Page number. 0 = all."),
        maxContentLength: z
          .number()
          .int()
          .optional()
          .describe("Max characters per result field. -1 = all."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ term, moduleId, mode, pageSize, pageNumber, maxContentLength }) =>
      ok(
        await api.search(await getToken(), {
          Term: term,
          ...(moduleId !== undefined ? { ModuleId: moduleId } : {}),
          Mode: mode,
          PageSize: pageSize,
          PageNumber: pageNumber,
          ...(maxContentLength !== undefined ? { MaxContentLength: maxContentLength } : {}),
        })
      )
  );

  // -------------------------------------------------------------------
  // get_module_fields
  // -------------------------------------------------------------------
  server.registerTool(
    "get_module_fields",
    {
      description:
        "Get the list of all available fields (with their Sequence IDs and Display Names) for a Track-It module. Call this before create_ticket or create_assignment to discover what field names to use in the properties map. Common module sequences: 1=Tickets, 2=Assignments.",
      inputSchema: {
        moduleSequence: z
          .number()
          .int()
          .describe(
            "Module sequence ID. Use 1 for Tickets, 2 for Assignments."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ moduleSequence }) =>
      ok(await api.getModuleFields(await getToken(), moduleSequence))
  );

  // -------------------------------------------------------------------
  // get_attachment
  // -------------------------------------------------------------------
  server.registerTool(
    "get_attachment",
    {
      description:
        "Get details of a specific attachment by its ID. Returns field values including file name, type, and content metadata. Attachment IDs are found via get_ticket_attachments or get_assignment_attachments.",
      inputSchema: {
        attachmentId: z.number().int().describe("Attachment ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ attachmentId }) =>
      ok(await api.getAttachment(await getToken(), attachmentId))
  );

  // -------------------------------------------------------------------
  // get_priority_hierarchy
  // -------------------------------------------------------------------
  server.registerTool(
    "get_priority_hierarchy",
    {
      description:
        "Get the calculated priority for a ticket based on the combination of department, category, location, and requestor. Useful for determining the correct priority when creating a ticket.",
      inputSchema: {
        departmentId: z
          .number()
          .int()
          .optional()
          .describe("Department ID"),
        categoryId: z
          .number()
          .int()
          .optional()
          .describe("Category ID"),
        locationId: z
          .number()
          .int()
          .optional()
          .describe("Location ID"),
        requestorId: z
          .number()
          .int()
          .optional()
          .describe("Requestor (user) ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ departmentId, categoryId, locationId, requestorId }) =>
      ok(
        await api.getPriorityHierarchy(await getToken(), {
          DepartmentId: departmentId,
          CategoryId: categoryId,
          LocationId: locationId,
          RequestorId: requestorId,
        })
      )
  );

  // -------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------
  server.registerTool(
    "logout",
    {
      description:
        "Log out the current technician session from Track-It. This invalidates the bearer token on the Track-It server side.",
      inputSchema: {},
    },
    async () => ok(await api.logout(await getToken()))
  );
}
