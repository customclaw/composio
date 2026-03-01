import { composioPluginConfigSchema, parseComposioConfig } from "./config.js";
import { createComposioClient } from "./client.js";
import { createComposioSearchTool } from "./tools/search.js";
import { createComposioExecuteTool } from "./tools/execute.js";
import { createComposioConnectionsTool } from "./tools/connections.js";
import { registerComposioCli } from "./cli.js";

/**
 * Multi-Account Composio Plugin for OpenClaw
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
  name: "Multi-Account Composio Plugin for OpenClaw",
  description:
    "Access 1000+ third-party tools via Multi-Account Composio Plugin for OpenClaw. " +
    "Search, authenticate, and execute tools for Gmail, Slack, GitHub, Notion, and more.",
  configSchema: composioPluginConfigSchema,

  register(api: any) {
    const config = parseComposioConfig(api.pluginConfig);
    let client: ReturnType<typeof createComposioClient> | null = null;

    const ensureClient = () => {
      if (!config.apiKey) {
        throw new Error(
          "Composio API key required. Run 'openclaw composio setup' or set COMPOSIO_API_KEY."
        );
      }
      if (!client) {
        client = createComposioClient(config);
      }
      return client;
    };

    // Register CLI commands even without API key so setup/status tooling remains available.
    api.registerCli(
      ({ program }: { program: any }) =>
        registerComposioCli({
          program,
          getClient: config.apiKey ? ensureClient : undefined,
          config,
          logger: api.logger,
        }),
      { commands: ["composio"] }
    );

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

    // Register tools (lazily create client on first use)
    api.registerTool({
      ...createComposioSearchTool(ensureClient(), config),
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        return createComposioSearchTool(ensureClient(), config).execute(toolCallId, params);
      },
    });

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

    api.logger.info("[composio] Plugin registered with 3 tools and CLI commands");
  },
};

export default composioPlugin;
