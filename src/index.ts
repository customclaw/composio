import { composioPluginConfigSchema, parseComposioConfig } from "./config.js";
import { createComposioClient } from "./client.js";
import { createComposioExecuteTool } from "./tools/execute.js";
import { createComposioConnectionsTool } from "./tools/connections.js";
import { registerComposioCli } from "./cli.js";

/**
 * Composio Tool Router Plugin for OpenClaw
 *
 * Provides access to 1000+ third-party tools through Composio's unified interface.
 * Tools include: Gmail, Slack, GitHub, Notion, Linear, Jira, and many more.
 *
 * Configuration (in openclaw config):
 * ```json
 * {
 *   "plugins": {
 *     "composio": {
 *       "enabled": true,
 *       "apiKey": "your-composio-api-key"
 *     }
 *   }
 * }
 * ```
 *
 * Or set COMPOSIO_API_KEY environment variable.
 */
const composioPlugin = {
  id: "composio",
  name: "Composio Tool Router",
  description:
    "Access 1000+ third-party tools via Composio Tool Router. " +
    "Search, authenticate, and execute tools for Gmail, Slack, GitHub, Notion, and more.",
  configSchema: composioPluginConfigSchema,

  register(api: any) {
    const config = parseComposioConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.debug("[composio] Plugin disabled in config");
      return;
    }

    if (!config.apiKey) {
      api.logger.warn(
        "[composio] No API key configured. Set COMPOSIO_API_KEY env var or plugins.composio.apiKey in config."
      );
      return;
    }

    let client: ReturnType<typeof createComposioClient> | null = null;

    const ensureClient = () => {
      if (!client) {
        client = createComposioClient(config);
      }
      return client;
    };

    // Register tools (lazily create client on first use)
    api.registerTool({
      ...createComposioExecuteTool(ensureClient(), config),
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        return createComposioExecuteTool(ensureClient(), config).execute(toolCallId, params);
      },
    });

    api.registerTool({
      ...createComposioConnectionsTool(ensureClient(), config),
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        return createComposioConnectionsTool(ensureClient(), config).execute(toolCallId, params);
      },
    });

    // Register CLI commands
    api.registerCli(
      ({ program }: { program: any }) =>
        registerComposioCli({
          program,
          client: ensureClient(),
          config,
          logger: api.logger,
        }),
      { commands: ["composio"] }
    );

    // Inject agent instructions via before_agent_start hook
    api.on("before_agent_start", () => {
      return {
        prependContext: `<composio-tools>
You have access to Composio tools for third-party integrations (Gmail, Sentry, etc.).

## Usage
1. Use \`composio_manage_connections\` with action="status" to check if a toolkit is connected. Use action="create" to generate an auth URL if needed.
2. Use \`composio_execute_tool\` with a tool_slug and arguments to execute actions.

## Common tool slugs
- GMAIL_FETCH_EMAILS, GMAIL_SEND_EMAIL, GMAIL_GET_PROFILE
- SENTRY_LIST_ISSUES, SENTRY_GET_ISSUE

Tool slugs are uppercase. If a tool fails with auth errors, prompt the user to connect the toolkit.
</composio-tools>`,
      };
    });

    api.logger.info("[composio] Plugin registered with 2 tools and CLI commands");
  },
};

export default composioPlugin;
