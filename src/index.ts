import { composioPluginConfigSchema, parseComposioConfig } from "./config.js";
import { createComposioClient } from "./client.js";
import { createComposioSearchTool } from "./tools/search.js";
import { createComposioExecuteTool } from "./tools/execute.js";
import { createComposioConnectionsTool } from "./tools/connections.js";
import { registerComposioCli } from "./cli.js";

const LEGACY_ENTRY_FLAT_CONFIG_KEYS = [
  "apiKey",
  "defaultUserId",
  "allowedToolkits",
  "blockedToolkits",
  "readOnlyMode",
  "sessionTags",
  "allowedToolSlugs",
  "blockedToolSlugs",
] as const;
const LEGACY_SHAPE_ERROR = "Legacy Composio config shape detected. Run 'openclaw composio setup'.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasLegacyFlatEntryConfig(config: unknown): boolean {
  const root = isRecord(config) ? config : undefined;
  const plugins = isRecord(root?.plugins) ? root.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const composioEntry = isRecord(entries?.composio) ? entries.composio : undefined;
  if (!composioEntry) return false;
  return LEGACY_ENTRY_FLAT_CONFIG_KEYS.some((key) => key in composioEntry);
}

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
    if (hasLegacyFlatEntryConfig(api?.config)) {
      throw new Error(LEGACY_SHAPE_ERROR);
    }

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
