import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { ComposioClient } from "./client.js";
import type { ComposioConfig } from "./types.js";
import {
  isRecord,
  normalizeToolkitSlug,
} from "./utils.js";

interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface RegisterCliOptions {
  program: any;
  getClient?: () => ComposioClient;
  config: ComposioConfig;
  logger: PluginLogger;
}

const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const COMPOSIO_PLUGIN_ID = "composio";

function normalizePluginIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function requireUserId(
  rawUserId: unknown,
  logger: PluginLogger,
  commandUsage: string
): string | null {
  const userId = String(rawUserId || "").trim();
  if (userId) return userId;
  logger.error(`--user-id is required. Usage: ${commandUsage}`);
  return null;
}

async function readOpenClawConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Register Composio CLI commands
 */
export function registerComposioCli({ program, getClient, config, logger }: RegisterCliOptions) {
  const composio = program.command("composio").description("Manage Composio Tool Router connections");
  const requireClient = (): ComposioClient | null => {
    if (!config.enabled) {
      logger.error("Composio plugin is disabled");
      return null;
    }
    if (!getClient) {
      logger.error("Composio API key is not configured. Run 'openclaw composio setup' first.");
      return null;
    }
    try {
      return getClient();
    } catch (err) {
      logger.error(`Failed to initialize Composio client: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  // openclaw composio setup
  composio
    .command("setup")
    .description("Create or update Composio config in ~/.openclaw/openclaw.json")
    .option("-c, --config-path <path>", "OpenClaw config file path", DEFAULT_OPENCLAW_CONFIG_PATH)
    .option("--api-key <apiKey>", "Composio API key")
    .option("-y, --yes", "Skip prompts and use defaults/provided values")
    .action(async (options: {
      configPath: string;
      apiKey?: string;
      yes?: boolean;
    }) => {
      const configPath = path.resolve(options.configPath || DEFAULT_OPENCLAW_CONFIG_PATH);

      try {
        const openClawConfig = await readOpenClawConfig(configPath);
        const plugins = isRecord(openClawConfig.plugins) ? { ...openClawConfig.plugins } : {};
        let updatedPluginSystemEnabled = false;
        let addedToAllowlist = false;
        let removedFromDenylist = false;

        if (plugins.enabled === false) {
          plugins.enabled = true;
          updatedPluginSystemEnabled = true;
        }

        const allow = normalizePluginIdList(plugins.allow);
        if (allow && allow.length > 0) {
          const hasExactComposio = allow.includes(COMPOSIO_PLUGIN_ID);
          const normalizedAllow = allow.filter((id) => id.toLowerCase() !== COMPOSIO_PLUGIN_ID);
          normalizedAllow.push(COMPOSIO_PLUGIN_ID);
          plugins.allow = Array.from(new Set(normalizedAllow));
          if (!hasExactComposio) {
            addedToAllowlist = true;
          }
        }

        const deny = normalizePluginIdList(plugins.deny);
        if (deny && deny.length > 0) {
          const filteredDeny = deny.filter((id) => id.toLowerCase() !== COMPOSIO_PLUGIN_ID);
          if (filteredDeny.length !== deny.length) {
            removedFromDenylist = true;
          }
          if (filteredDeny.length > 0) {
            plugins.deny = filteredDeny;
          } else {
            delete plugins.deny;
          }
        }

        const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
        const existingComposioEntry = isRecord(entries.composio) ? { ...entries.composio } : {};
        const existingComposioConfig = isRecord(existingComposioEntry.config)
          ? { ...existingComposioEntry.config }
          : {};

        let apiKey =
          String(options.apiKey || "").trim() ||
          String(existingComposioConfig.apiKey || "").trim() ||
          String(config.apiKey || "").trim() ||
          String(process.env.COMPOSIO_API_KEY || "").trim();

        if (!options.yes) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const apiKeyPrompt = await rl.question(
              `Composio API key${apiKey ? " [configured]" : ""}: `
            );
            if (apiKeyPrompt.trim()) apiKey = apiKeyPrompt.trim();
          } finally {
            rl.close();
          }
        }

        if (!apiKey) {
          logger.error("Composio API key is required. Provide --api-key or set COMPOSIO_API_KEY.");
          return;
        }

        const mergedComposioConfig: Record<string, unknown> = {
          ...existingComposioConfig,
          apiKey,
        };
        delete mergedComposioConfig.defaultUserId;

        entries.composio = {
          ...existingComposioEntry,
          enabled: true,
          config: mergedComposioConfig,
        };
        plugins.entries = entries;
        openClawConfig.plugins = plugins;

        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(openClawConfig, null, 2)}\n`, "utf8");

        console.log("\nComposio setup saved.");
        console.log("─".repeat(40));
        console.log(`Config: ${configPath}`);
        if (updatedPluginSystemEnabled) {
          console.log("plugins.enabled: set to true");
        }
        if (addedToAllowlist) {
          console.log("plugins.allow: added 'composio'");
        }
        if (removedFromDenylist) {
          console.log("plugins.deny: removed 'composio'");
        }
        console.log("\nNext steps:");
        console.log("  1) openclaw gateway restart");
        console.log("  2) openclaw composio status --user-id <user-id>");
        console.log();
      } catch (err) {
        logger.error(`Failed to run setup: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // openclaw composio list
  composio
    .command("list")
    .description("List available Composio toolkits")
    .option("-u, --user-id <userId>", "Required user ID for session scoping")
    .action(async (options: { userId?: string }) => {
      const composioClient = requireClient();
      if (!composioClient) return;
      const userId = requireUserId(options.userId, logger, "openclaw composio list --user-id <user-id>");
      if (!userId) return;

      try {
        const toolkits = await composioClient.listToolkits(userId);
        console.log("\nAvailable Composio Toolkits:");
        console.log("─".repeat(40));
        for (const toolkit of toolkits.sort()) {
          console.log(`  ${toolkit}`);
        }
        console.log(`\nTotal: ${toolkits.length} toolkits`);
      } catch (err) {
        logger.error(`Failed to list toolkits: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // openclaw composio status [toolkit]
  composio
    .command("status [toolkit]")
    .description("Check connection status for toolkits")
    .option("-u, --user-id <userId>", "Required user ID for session scoping")
    .action(async (toolkit: string | undefined, options: { userId?: string }) => {
      const composioClient = requireClient();
      if (!composioClient) return;
      const userId = requireUserId(options.userId, logger, "openclaw composio status [toolkit] --user-id <user-id>");
      if (!userId) return;

      try {
        const toolkitSlug = toolkit ? normalizeToolkitSlug(toolkit) : undefined;
        const toolkits = toolkitSlug ? [toolkitSlug] : undefined;
        const statuses = await composioClient.getConnectionStatus(toolkits, userId);

        console.log("\nComposio Connection Status:");
        console.log("─".repeat(40));
        console.log(`  Scope user_id: ${userId}`);

        if (statuses.length === 0) {
          console.log("  No connections found");
        } else {
          for (const status of statuses) {
            const icon = status.connected ? "✓" : "✗";
            const state = status.connected ? "connected" : "not connected";
            console.log(`  ${icon} ${status.toolkit}: ${state}`);
          }
        }

        if (toolkitSlug && statuses.length === 1 && !statuses[0]?.connected) {
          const activeUserIds = await composioClient.findActiveUserIdsForToolkit(toolkitSlug);
          const otherUserIds = activeUserIds.filter((uid) => uid !== userId);

          if (otherUserIds.length > 0) {
            console.log(`\n  Hint: '${toolkitSlug}' is connected under other user_id(s): ${otherUserIds.join(", ")}`);
            console.log(`  Try: openclaw composio status ${toolkitSlug} --user-id <user-id>`);
            console.log(`  Discover accounts: openclaw composio accounts ${toolkitSlug}`);
          }
        }

        console.log();
      } catch (err) {
        logger.error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // openclaw composio accounts [toolkit]
  composio
    .command("accounts [toolkit]")
    .description("List connected accounts (account IDs, user IDs, and statuses)")
    .option("-u, --user-id <userId>", "Filter by user ID")
    .option("-s, --statuses <statuses>", "Comma-separated statuses (default: ACTIVE)", "ACTIVE")
    .action(async (toolkit: string | undefined, options: { userId?: string; statuses: string }) => {
      const composioClient = requireClient();
      if (!composioClient) return;

      try {
        const statuses = String(options.statuses || "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean);
        const accounts = await composioClient.listConnectedAccounts({
          toolkits: toolkit ? [normalizeToolkitSlug(toolkit)] : undefined,
          userIds: options.userId ? [options.userId] : undefined,
          statuses: statuses.length > 0 ? statuses : ["ACTIVE"],
        });

        console.log("\nComposio Connected Accounts:");
        console.log("─".repeat(80));
        if (accounts.length === 0) {
          console.log("  No connected accounts found");
          console.log();
          return;
        }

        for (const account of accounts) {
          console.log(
            `  ${account.id} | toolkit=${account.toolkit} | status=${account.status || "unknown"} | user_id=${account.userId || "hidden"}`
          );
        }
        console.log(`\nTotal: ${accounts.length} connected accounts\n`);
      } catch (err) {
        logger.error(`Failed to list connected accounts: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // openclaw composio connect <toolkit>
  composio
    .command("connect <toolkit>")
    .description("Connect to a Composio toolkit (opens auth URL)")
    .option("-u, --user-id <userId>", "Required user ID for session scoping")
    .action(async (toolkit: string, options: { userId?: string }) => {
      const composioClient = requireClient();
      if (!composioClient) return;
      const userId = requireUserId(options.userId, logger, "openclaw composio connect <toolkit> --user-id <user-id>");
      if (!userId) return;

      try {
        const toolkitSlug = normalizeToolkitSlug(toolkit);
        console.log(`\nInitiating connection to ${toolkitSlug}...`);
        console.log(`Using user_id: ${userId}`);

        const result = await composioClient.createConnection(toolkitSlug, userId);

        if ("error" in result) {
          logger.error(`Failed to create connection: ${result.error}`);
          return;
        }

        console.log("\nAuth URL generated:");
        console.log("─".repeat(40));
        console.log(result.authUrl);
        console.log("\nOpen this URL in your browser to authenticate.");
        console.log(`After authentication, run 'openclaw composio status ${toolkitSlug} --user-id ${userId}' to verify.\n`);

        // Try to open URL in browser
        try {
          const { exec } = await import("node:child_process");
          const platform = process.platform;
          const cmd =
            platform === "darwin"
              ? `open "${result.authUrl}"`
              : platform === "win32"
                ? `start "" "${result.authUrl}"`
                : `xdg-open "${result.authUrl}"`;
          exec(cmd);
        } catch {
          // Silently fail if we can't open browser
        }
      } catch (err) {
        logger.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // openclaw composio disconnect <toolkit>
  composio
    .command("disconnect <toolkit>")
    .description("Disconnect from a Composio toolkit")
    .option("-u, --user-id <userId>", "Required user ID for session scoping")
    .action(async (toolkit: string, options: { userId?: string }) => {
      const composioClient = requireClient();
      if (!composioClient) return;
      const userId = requireUserId(options.userId, logger, "openclaw composio disconnect <toolkit> --user-id <user-id>");
      if (!userId) return;

      try {
        const toolkitSlug = normalizeToolkitSlug(toolkit);
        console.log(`\nDisconnecting from ${toolkitSlug}...`);

        const result = await composioClient.disconnectToolkit(toolkitSlug, userId);

        if (result.success) {
          console.log(`Successfully disconnected from ${toolkitSlug}\n`);
        } else {
          logger.error(`Failed to disconnect: ${result.error}`);
        }
      } catch (err) {
        logger.error(`Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // openclaw composio search <query>
  composio
    .command("search <query>")
    .description("Search for tools matching a query")
    .option("-t, --toolkit <toolkit>", "Limit search to a specific toolkit")
    .option("-l, --limit <limit>", "Maximum results", "10")
    .option("-u, --user-id <userId>", "Required user ID for session scoping")
    .action(async (query: string, options: { toolkit?: string; limit: string; userId?: string }) => {
      const composioClient = requireClient();
      if (!composioClient) return;
      const userId = requireUserId(options.userId, logger, "openclaw composio search <query> --user-id <user-id>");
      if (!userId) return;

      try {
        const limit = parseInt(options.limit, 10) || 10;
        const toolkits = options.toolkit ? [normalizeToolkitSlug(options.toolkit)] : undefined;

        const results = await composioClient.searchTools(query, {
          toolkits,
          limit,
          userId,
        });

        console.log(`\nSearch results for "${query}":`);
        console.log("─".repeat(60));

        if (results.length === 0) {
          console.log("  No tools found matching your query");
        } else {
          for (const tool of results) {
            console.log(`\n  ${tool.slug}`);
            console.log(`    Toolkit: ${tool.toolkit}`);
            console.log(`    ${tool.description.slice(0, 100)}${tool.description.length > 100 ? "..." : ""}`);
          }
        }
        console.log(`\nTotal: ${results.length} tools found\n`);
      } catch (err) {
        logger.error(`Failed to search: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}
