export const ARTIFACT_CATALOG_RESPONSE_KIND = "HarnessStudioArtifactCatalogV1" as const;

export type ArtifactDigest = `sha256:${string}`;
export type ArtifactKind = "code" | "diff" | "image" | "json" | "svg" | "text" | "unknown";
export type ArtifactRenderer = Exclude<ArtifactKind, "unknown"> | "canvas" | "unavailable";

export interface ArtifactContentReference {
  uri: string;
  mediaType: string;
  digest: ArtifactDigest;
}

export interface ArtifactPresentation {
  renderer: ArtifactRenderer;
  viewerId?: string;
  viewerLabel?: string;
  reason?: string;
}

export interface ArtifactDescriptor extends ArtifactPresentation {
  id: string;
  kind: ArtifactKind;
  label: string;
  size: number;
  artifact: ArtifactContentReference;
}

export interface ArtifactCatalogResponse {
  kind: typeof ARTIFACT_CATALOG_RESPONSE_KIND;
  snapshot: {
    catalogId: string;
    revision: ArtifactDigest;
  };
  artifacts: ArtifactDescriptor[];
}

const ARTIFACT_KINDS = new Set<ArtifactKind>(["code", "diff", "image", "json", "svg", "text", "unknown"]);
const ARTIFACT_RENDERERS = new Set<ArtifactRenderer>(["code", "diff", "image", "json", "svg", "text", "canvas", "unavailable"]);
const ARTIFACT_CONTENT_URI = /^\/api\/artifacts\/[A-Za-z0-9_-]+\/content$/u;

export function isArtifactCatalogResponse(value: unknown): value is ArtifactCatalogResponse {
  if (!isRecord(value) || value.kind !== ARTIFACT_CATALOG_RESPONSE_KIND) return false;
  if (!isRecord(value.snapshot)
    || typeof value.snapshot.catalogId !== "string"
    || !isDigest(value.snapshot.revision)
    || !Array.isArray(value.artifacts)) return false;
  return value.artifacts.every((entry) => isArtifactDescriptor(entry));
}

function isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
  return isRecord(value)
    && typeof value.id === "string"
    && ARTIFACT_KINDS.has(value.kind as ArtifactKind)
    && typeof value.label === "string"
    && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    && ARTIFACT_RENDERERS.has(value.renderer as ArtifactRenderer)
    && optionalString(value.viewerId)
    && optionalString(value.viewerLabel)
    && optionalString(value.reason)
    && isRecord(value.artifact)
    && typeof value.artifact.uri === "string" && ARTIFACT_CONTENT_URI.test(value.artifact.uri)
    && typeof value.artifact.mediaType === "string" && value.artifact.mediaType.length > 0
    && isDigest(value.artifact.digest);
}

function isDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
