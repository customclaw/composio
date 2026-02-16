import { composioPluginConfigSchema, parseComposioConfig } from "./config.js";
import { createComposioClient } from "./client.js";
import { createComposioSearchTool } from "./tools/search.js";
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

    api.logger.info("[composio] Plugin registered with 3 tools and CLI commands");
  },
};

export default composioPlugin;
