export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeToolkitSlug(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeToolSlug(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}
