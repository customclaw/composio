import { Type } from "@sinclair/typebox";
import type { ComposioClient } from "../client.js";
import type { ComposioConfig } from "../types.js";

/**
 * Tool parameters for composio_execute_tool
 */
export const ComposioExecuteToolSchema = Type.Object({
  tool_slug: Type.String({
    description: "Tool slug from composio_search_tools results (e.g., 'GMAIL_SEND_EMAIL')",
  }),
  arguments: Type.Unknown({
    description: "Tool arguments matching the tool's parameter schema",
  }),
  user_id: Type.String({
    description: "Required user ID for session scoping.",
  }),
  connected_account_id: Type.Optional(
    Type.String({
      description: "Optional connected account ID to pin execution to a specific account when multiple are connected",
    })
  ),
});

/**
 * Create the composio_execute_tool tool
 */
export function createComposioExecuteTool(client: ComposioClient, _config: ComposioConfig) {
  return {
    name: "composio_execute_tool",
    label: "Composio Execute Tool",
    description:
      "Execute a single Composio tool. Use composio_search_tools first to find the UPPERCASE tool slug " +
      "and parameter schema. The toolkit must be connected — use composio_manage_connections to check " +
      "status or create an auth link. If execution fails with auth errors, prompt the user to reconnect.",
    parameters: ComposioExecuteToolSchema,

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const toolSlug = String(params.tool_slug || "").trim();
      if (!toolSlug) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "tool_slug is required" }, null, 2) }],
          details: { error: "tool_slug is required" },
        };
      }

      let rawArgs = params.arguments;
      if (typeof rawArgs === "string") {
        try { rawArgs = JSON.parse(rawArgs); } catch {}
      }
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};

      const userId = typeof params.user_id === "string" ? params.user_id.trim() : "";
      if (!userId) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "user_id is required" }, null, 2) }],
          details: { error: "user_id is required" },
        };
      }
      const connectedAccountId =
        typeof params.connected_account_id === "string" ? params.connected_account_id : undefined;

      try {
        const result = await client.executeTool(toolSlug, args, userId, connectedAccountId);

        const response = {
          tool_slug: toolSlug,
          success: result.success,
          ...(result.success ? { data: result.data } : { error: result.error }),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: response,
        };
      } catch (err) {
        const errorResponse = {
          tool_slug: toolSlug,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }],
          details: errorResponse,
        };
      }
    },
  };
}
