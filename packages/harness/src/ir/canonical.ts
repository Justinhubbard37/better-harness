import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys are sorted recursively so the
 * same logical document always hashes to the same revision id.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortValue(entryValue)]));
  }
  return value;
}
