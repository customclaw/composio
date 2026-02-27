import { Type } from "@sinclair/typebox";
import type { ComposioClient } from "../client.js";
import type { ComposioConfig } from "../types.js";

/**
 * Tool parameters for composio_manage_connections
 */
const ActionDescription =
  "Action to perform: 'status' to check connections, 'create' to initiate auth, " +
  "'list' to list toolkits, 'accounts' to inspect connected accounts";

const UserIdRequiredField = Type.String({
  description: "Required user ID for session scoping.",
});

const UserIdOptionalField = Type.Optional(
  Type.String({
    description: "Optional user ID filter for accounts lookup.",
  })
);

const ToolkitField = Type.Optional(
  Type.String({
    description: "Toolkit name (e.g., 'github', 'gmail')",
  })
);

const ToolkitsField = Type.Optional(
  Type.Array(Type.String(), {
    description: "Multiple toolkits to check status for",
  })
);

export const ComposioManageConnectionsToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list", { description: ActionDescription }),
    user_id: UserIdRequiredField,
  }),
  Type.Object({
    action: Type.Literal("create", { description: ActionDescription }),
    toolkit: Type.String({
      description: "Toolkit name for 'create' action (e.g., 'github', 'gmail')",
    }),
    user_id: UserIdRequiredField,
  }),
  Type.Object({
    action: Type.Literal("status", { description: ActionDescription }),
    toolkit: ToolkitField,
    toolkits: ToolkitsField,
    user_id: UserIdRequiredField,
  }),
  Type.Object({
    action: Type.Literal("accounts", { description: ActionDescription }),
    toolkit: ToolkitField,
    toolkits: ToolkitsField,
    user_id: UserIdOptionalField,
    statuses: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional connection statuses filter for 'accounts' (e.g., ['ACTIVE'])",
      })
    ),
  }),
]);

/**
 * Create the composio_manage_connections tool
 */
export function createComposioConnectionsTool(client: ComposioClient, _config: ComposioConfig) {
  return {
    name: "composio_manage_connections",
    label: "Composio Manage Connections",
    description:
      "Manage Composio toolkit connections. Use action='status' to check if a toolkit is connected, " +
      "action='create' to generate an auth URL when disconnected, action='list' to see available toolkits, " +
      "or action='accounts' to inspect connected accounts across user IDs. " +
      "Check connection status before executing tools with composio_execute_tool.",
    parameters: ComposioManageConnectionsToolSchema,

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = String(params.action || "status");
      const userId = typeof params.user_id === "string" ? params.user_id.trim() : "";
      const requiresUserId = action === "list" || action === "status" || action === "create";
      if (requiresUserId && !userId) {
        const errorResponse = {
          action,
          error: "user_id is required for this action",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }],
          details: errorResponse,
        };
      }

      try {
        switch (action) {
          case "list": {
            const toolkits = await client.listToolkits(userId);
            const response = {
              action: "list",
              count: toolkits.length,
              toolkits,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "accounts": {
            let toolkits: string[] | undefined;
            if (typeof params.toolkit === "string" && params.toolkit.trim()) {
              toolkits = [params.toolkit.trim()];
            } else if (Array.isArray(params.toolkits)) {
              toolkits = params.toolkits.filter((t): t is string => typeof t === "string" && t.trim() !== "");
            }

            const statuses = Array.isArray(params.statuses)
              ? params.statuses.filter((s): s is string => typeof s === "string" && s.trim() !== "")
              : ["ACTIVE"];

            const accounts = await client.listConnectedAccounts({
              toolkits,
              userIds: userId ? [userId] : undefined,
              statuses,
            });

            const response = {
              action: "accounts",
              count: accounts.length,
              accounts: accounts.map((a) => ({
                id: a.id,
                toolkit: a.toolkit,
                user_id: a.userId,
                status: a.status,
                auth_config_id: a.authConfigId,
              })),
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "create": {
            const toolkit = String(params.toolkit || "").trim();
            if (!toolkit) {
              return {
                content: [
                  { type: "text", text: JSON.stringify({ error: "toolkit is required for 'create' action" }, null, 2) },
                ],
                details: { error: "toolkit is required for 'create' action" },
              };
            }

            const result = await client.createConnection(toolkit, userId);
            if ("error" in result) {
              return {
                content: [{ type: "text", text: JSON.stringify({ action: "create", toolkit, error: result.error }, null, 2) }],
                details: { action: "create", toolkit, error: result.error },
              };
            }

            const response = {
              action: "create",
              toolkit,
              authUrl: result.authUrl,
              instructions: `Open the auth URL to connect ${toolkit}. After authentication, the connection will be active.`,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "status":
          default: {
            // Collect toolkits to check
            let toolkitsToCheck: string[] | undefined;

            if (typeof params.toolkit === "string" && params.toolkit.trim()) {
              toolkitsToCheck = [params.toolkit.trim()];
            } else if (Array.isArray(params.toolkits)) {
              toolkitsToCheck = params.toolkits.filter((t): t is string => typeof t === "string" && t.trim() !== "");
            }

            const statuses = await client.getConnectionStatus(toolkitsToCheck, userId);
            const disconnectedToolkits = statuses.filter((s) => !s.connected).map((s) => s.toolkit);
            const hints: Array<{ toolkit: string; connected_user_ids: string[]; message: string }> = [];

            for (const toolkit of disconnectedToolkits) {
              const activeUserIds = await client.findActiveUserIdsForToolkit(toolkit);
              const otherUserIds = activeUserIds.filter((uid) => uid !== userId);
              if (otherUserIds.length === 0) continue;
              hints.push({
                toolkit,
                connected_user_ids: otherUserIds,
                message:
                  `'${toolkit}' has ACTIVE accounts under other user_id(s): ${otherUserIds.join(", ")}. ` +
                  "Use a matching user_id to check that scope.",
              });
            }

            const response = {
              action: "status",
              checked_user_id: statuses[0]?.userId,
              count: statuses.length,
              connections: statuses.map((s) => ({
                toolkit: s.toolkit,
                connected: s.connected,
              })),
              ...(hints.length > 0 ? { hints } : {}),
            };
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }
        }
      } catch (err) {
        const errorResponse = {
          action,
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
