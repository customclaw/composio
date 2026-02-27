import { z } from "zod";
import type { ComposioConfig } from "./types.js";
import {
  LEGACY_ENTRY_FLAT_CONFIG_KEYS,
  LEGACY_SHAPE_ERROR,
  SESSION_TAGS,
  isRecord,
  normalizeSessionTags,
  normalizeToolkitList,
  normalizeToolSlugList,
} from "./utils.js";

/**
 * Zod schema for Composio plugin configuration
 */
export const ComposioConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  allowedToolkits: z.array(z.string()).optional(),
  blockedToolkits: z.array(z.string()).optional(),
  readOnlyMode: z.boolean().default(false),
  sessionTags: z.array(z.enum(SESSION_TAGS)).optional(),
  allowedToolSlugs: z.array(z.string()).optional(),
  blockedToolSlugs: z.array(z.string()).optional(),
});

/**
 * Parse and validate plugin config with environment fallbacks
 */
export function parseComposioConfig(value: unknown): ComposioConfig {
  const raw = isRecord(value) ? value : {};
  const configObj = isRecord(raw.config) ? raw.config : undefined;

  if (configObj) {
    const hasLegacyFlatKeys = LEGACY_ENTRY_FLAT_CONFIG_KEYS.some((key) => key in raw);
    if (hasLegacyFlatKeys) {
      throw new Error(LEGACY_SHAPE_ERROR);
    }
  }

  const source = configObj ?? raw;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  const readOnlyMode = typeof source.readOnlyMode === "boolean" ? source.readOnlyMode : false;
  const apiKey =
    (typeof source.apiKey === "string" && source.apiKey.trim()) ||
    process.env.COMPOSIO_API_KEY ||
    "";

  return ComposioConfigSchema.parse({
    enabled,
    apiKey,
    allowedToolkits: normalizeToolkitList(Array.isArray(source.allowedToolkits) ? source.allowedToolkits : undefined),
    blockedToolkits: normalizeToolkitList(Array.isArray(source.blockedToolkits) ? source.blockedToolkits : undefined),
    readOnlyMode,
    sessionTags: normalizeSessionTags(Array.isArray(source.sessionTags) ? source.sessionTags : undefined),
    allowedToolSlugs: normalizeToolSlugList(
      Array.isArray(source.allowedToolSlugs) ? source.allowedToolSlugs : undefined
    ),
    blockedToolSlugs: normalizeToolSlugList(
      Array.isArray(source.blockedToolSlugs) ? source.blockedToolSlugs : undefined
    ),
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
  allowedToolkits: {
    label: "Allowed Toolkits",
    help: "Restrict to specific toolkits (e.g., github, gmail)",
    advanced: true,
  },
  blockedToolkits: {
    label: "Blocked Toolkits",
    help: "Block specific toolkits from being used",
    advanced: true,
  },
  readOnlyMode: {
    label: "Read-Only Mode",
    help:
      "Block likely-destructive tool actions by token matching; allow specific slugs with allowedToolSlugs if needed",
    advanced: true,
  },
  sessionTags: {
    label: "Session Tags",
    help: "Composio Tool Router behavior tags (e.g., readOnlyHint, destructiveHint)",
    advanced: true,
  },
  allowedToolSlugs: {
    label: "Allowed Tool Slugs",
    help: "Optional explicit allowlist for tool slugs (UPPERCASE)",
    advanced: true,
  },
  blockedToolSlugs: {
    label: "Blocked Tool Slugs",
    help: "Explicit denylist for tool slugs (UPPERCASE)",
    advanced: true,
  },
};

/**
 * Plugin config schema object for openclaw
 */
export const composioPluginConfigSchema = {
  parse: parseComposioConfig,
  uiHints: composioConfigUiHints,
};
