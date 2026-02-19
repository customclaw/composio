import { z } from "zod";
import type { ComposioConfig, ComposioSessionTag } from "./types.js";

const SESSION_TAGS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
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

function normalizeToolkitList(value?: unknown[]): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

function normalizeToolSlugList(value?: unknown[]): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

function normalizeSessionTags(value?: unknown[]): ComposioSessionTag[] | undefined {
  if (!value || value.length === 0) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item): item is ComposioSessionTag => SESSION_TAGS.includes(item as ComposioSessionTag));
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Zod schema for Composio plugin configuration
 */
export const ComposioConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  defaultUserId: z.string().optional(),
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
      throw new Error("Legacy Composio config shape detected. Run 'openclaw composio setup'.");
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
    defaultUserId: typeof source.defaultUserId === "string" ? source.defaultUserId : undefined,
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
  defaultUserId: {
    label: "Default User ID",
    help: "Default user ID for session scoping (optional)",
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
    help: "Block likely-destructive tool actions (delete/remove/update/write) by default",
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
