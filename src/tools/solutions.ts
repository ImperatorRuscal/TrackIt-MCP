import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../trackit-client.js";

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function registerSolutionTools(
  server: McpServer,
  getToken: () => Promise<string>
) {
  server.registerTool(
    "get_solution",
    {
      description:
        "Get all fields of a specific solution from the Track-It knowledge base by its Solution ID. Solutions are reusable resolution records. Use the search tool to find solutions by keyword first.",
      inputSchema: {
        solutionId: z.number().int().describe("Solution ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ solutionId }) =>
      ok(await api.getSolution(await getToken(), solutionId))
  );

  server.registerTool(
    "get_solution_attachments",
    {
      description:
        "List all attachments linked to a solution. Use get_attachment to retrieve content.",
      inputSchema: {
        id: z.number().int().describe("Solution ID"),
        pageSize: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Records to return. 0 = all."),
        pageNumber: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Page number. 0 = all."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, pageSize, pageNumber }) =>
      ok(
        await api.getSolutionAttachments(await getToken(), id, pageSize, pageNumber)
      )
  );
}
