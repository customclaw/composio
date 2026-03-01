import { z } from "zod";
import type { ComposioConfig } from "./types.js";
import { isRecord } from "./utils.js";

/**
 * Zod schema for Composio plugin configuration
 */
export const ComposioConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
});

/**
 * Parse and validate plugin config with environment fallbacks
 */
export function parseComposioConfig(value: unknown): ComposioConfig {
  const raw = isRecord(value) ? value : {};
  const configObj = isRecord(raw.config) ? raw.config : undefined;

  const source = configObj ?? raw;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  const apiKey =
    (typeof source.apiKey === "string" && source.apiKey.trim()) ||
    (typeof raw.apiKey === "string" && raw.apiKey.trim()) ||
    process.env.COMPOSIO_API_KEY ||
    "";

  return ComposioConfigSchema.parse({
    enabled,
    apiKey,
  });
}

/**
 * UI hints for configuration fields
 */
export const composioConfigUiHints = {
  enabled: {
    label: "Enable Composio",
    help: "Enable or disable the Composio Tool Router integration",
  },
  apiKey: {
    label: "API Key",
    help: "Composio API key from platform.composio.dev/settings",
    sensitive: true,
  },
};

/**
 * Plugin config schema object for openclaw
 */
export const composioPluginConfigSchema = {
  parse: parseComposioConfig,
  uiHints: composioConfigUiHints,
};
