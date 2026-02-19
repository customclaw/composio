import type { ComposioSessionTag } from "./types.js";

export const SESSION_TAGS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

export const LEGACY_ENTRY_FLAT_CONFIG_KEYS = [
  "apiKey",
  "defaultUserId",
  "allowedToolkits",
  "blockedToolkits",
  "readOnlyMode",
  "sessionTags",
  "allowedToolSlugs",
  "blockedToolSlugs",
] as const;

export const LEGACY_SHAPE_ERROR =
  "Legacy Composio config shape detected. Run 'openclaw composio setup'.";

const SESSION_TAG_SET = new Set<ComposioSessionTag>(SESSION_TAGS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeToolkitSlug(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeToolSlug(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeToolkitList(values?: readonly unknown[]): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeToolkitSlug(item))
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

export function normalizeToolSlugList(values?: readonly unknown[]): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeToolSlug(item))
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

export function normalizeSessionTags(values?: readonly unknown[]): ComposioSessionTag[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item): item is ComposioSessionTag => SESSION_TAG_SET.has(item as ComposioSessionTag));
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

export function hasLegacyFlatEntryConfig(config: unknown): boolean {
  const root = isRecord(config) ? config : undefined;
  const plugins = isRecord(root?.plugins) ? root.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const composioEntry = isRecord(entries?.composio) ? entries.composio : undefined;
  if (!composioEntry) return false;
  return LEGACY_ENTRY_FLAT_CONFIG_KEYS.some((key) => key in composioEntry);
}

export function stripLegacyFlatConfigKeys(entry: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...entry };
  for (const key of LEGACY_ENTRY_FLAT_CONFIG_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}
