export const ARTIFACT_CATALOG_RESPONSE_KIND = "HarnessStudioArtifactCatalogV2" as const;
export const ARTIFACT_DATA_SNAPSHOT_KIND = "ArtifactDataSnapshotV1" as const;

export type ArtifactDigest = `sha256:${string}`;
export type ArtifactFamily = "documents" | "images-diagrams" | "data" | "source-text" | "other";
export type ArtifactBacking = "data";
export type ArtifactRendererType = "native" | "qoder-canvas" | "unavailable";
export type ArtifactRendererStatus = "ready" | "unavailable";
export type ArtifactCapability = "navigate" | "outline" | "search" | "select" | "thumbnail" | "zoom";
export type ArtifactKind = "code" | "diff" | "image" | "json" | "pptx" | "svg" | "text" | "unknown";

export interface ArtifactContentReference {
  uri: string;
  mediaType: string;
  digest: ArtifactDigest;
}

export interface ArtifactRevisionReference {
  id: ArtifactDigest;
  digest: ArtifactDigest;
  content: ArtifactContentReference;
}

export interface ArtifactAdapterReference {
  id: string;
  version: string;
  schemaId: string;
  snapshotId: ArtifactDigest;
  snapshotUri: string;
}

export interface ArtifactRendererReference {
  id: string;
  label: string;
  provider: "studio" | "qoder-canvas";
  type: ArtifactRendererType;
  status: ArtifactRendererStatus;
  reason?: string;
}

export interface ArtifactDescriptor {
  id: string;
  threadId: string;
  label: string;
  size: number;
  kind: ArtifactKind;
  family: ArtifactFamily;
  format: string;
  backing: ArtifactBacking;
  revision: ArtifactRevisionReference;
  adapter: ArtifactAdapterReference;
  renderer: ArtifactRendererReference;
  capabilities: ArtifactCapability[];
}

export interface ArtifactCatalogResponse {
  kind: typeof ARTIFACT_CATALOG_RESPONSE_KIND;
  snapshot: {
    catalogId: string;
    revision: ArtifactDigest;
  };
  artifacts: ArtifactDescriptor[];
}

export type ArtifactDiagnosticLevel = "info" | "warning" | "error";

export interface ArtifactDiagnostic {
  level: ArtifactDiagnosticLevel;
  code: string;
  message: string;
  address?: string;
}

export interface ArtifactStructureNode {
  id: string;
  label: string;
  address: string;
  kind: string;
  children?: ArtifactStructureNode[];
}

export interface ArtifactSemanticIndexEntry {
  address: string;
  label: string;
  kind: string;
}

export interface ArtifactSnapshotResource {
  id: string;
  label: string;
  mediaType: string;
  uri: string;
  size: number;
}

export interface RawArtifactPayload {
  kind: "artifact/raw-v1";
  content: ArtifactContentReference;
}

export interface PptxTextRun {
  text: string;
  fontFamily?: string;
  fontSizePoints?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface PptxParagraph {
  alignment: "left" | "center" | "right";
  runs: PptxTextRun[];
}

export interface PptxElementBase {
  id: string;
  name: string;
  address: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface PptxShapeElement extends PptxElementBase {
  kind: "shape";
  fill?: string;
  line?: string;
  paragraphs: PptxParagraph[];
}

export interface PptxImageElement extends PptxElementBase {
  kind: "image";
  resourceId: string;
  alt?: string;
}

export type PptxElement = PptxShapeElement | PptxImageElement;

export interface PptxSlideSnapshot {
  id: string;
  label: string;
  address: string;
  background?: string;
  elements: PptxElement[];
  notesPresent: boolean;
  notesText?: string;
}

export interface PptxArtifactPayload {
  kind: "pptx/v1";
  width: number;
  height: number;
  slides: PptxSlideSnapshot[];
}

export interface QoderCanvasArtifactPayload {
  kind: "qoder-canvas/v1";
  data: Record<string, unknown>;
}

export type ArtifactSnapshotPayload = RawArtifactPayload | PptxArtifactPayload | QoderCanvasArtifactPayload;

export interface ArtifactDataSnapshot {
  kind: typeof ARTIFACT_DATA_SNAPSHOT_KIND;
  artifactId: string;
  revisionId: ArtifactDigest;
  snapshotId: ArtifactDigest;
  adapter: {
    id: string;
    version: string;
  };
  schemaId: string;
  summary: {
    label: string;
    family: ArtifactFamily;
    format: string;
  };
  structure: ArtifactStructureNode[];
  semanticIndex: ArtifactSemanticIndexEntry[];
  resources: ArtifactSnapshotResource[];
  diagnostics: ArtifactDiagnostic[];
  payload: ArtifactSnapshotPayload;
}

const ARTIFACT_KINDS = new Set<ArtifactKind>(["code", "diff", "image", "json", "pptx", "svg", "text", "unknown"]);
const ARTIFACT_FAMILIES = new Set<ArtifactFamily>(["documents", "images-diagrams", "data", "source-text", "other"]);
const RENDERER_TYPES = new Set<ArtifactRendererType>(["native", "qoder-canvas", "unavailable"]);
const RENDERER_STATUSES = new Set<ArtifactRendererStatus>(["ready", "unavailable"]);
const CAPABILITIES = new Set<ArtifactCapability>(["navigate", "outline", "search", "select", "thumbnail", "zoom"]);
const CONTENT_URI = /^\/api\/artifacts\/[A-Za-z0-9_-]+\/content$/u;
const SNAPSHOT_URI = /^\/api\/artifacts\/[A-Za-z0-9_-]+\/snapshot$/u;
const RESOURCE_URI = /^\/api\/artifacts\/[A-Za-z0-9_-]+\/resources\/[A-Za-z0-9_-]+$/u;

export function isArtifactCatalogResponse(value: unknown): value is ArtifactCatalogResponse {
  if (!isRecord(value) || value.kind !== ARTIFACT_CATALOG_RESPONSE_KIND) return false;
  if (!isRecord(value.snapshot)
    || typeof value.snapshot.catalogId !== "string"
    || !isDigest(value.snapshot.revision)
    || !Array.isArray(value.artifacts)) return false;
  return value.artifacts.every(isArtifactDescriptor);
}

export function isArtifactDataSnapshot(value: unknown): value is ArtifactDataSnapshot {
  if (!isRecord(value) || value.kind !== ARTIFACT_DATA_SNAPSHOT_KIND) return false;
  if (typeof value.artifactId !== "string" || !isDigest(value.revisionId) || !isDigest(value.snapshotId)) return false;
  if (!isRecord(value.adapter) || typeof value.adapter.id !== "string" || typeof value.adapter.version !== "string") return false;
  if (typeof value.schemaId !== "string" || !isRecord(value.summary) || !ARTIFACT_FAMILIES.has(value.summary.family as ArtifactFamily)) return false;
  if (!Array.isArray(value.structure) || !Array.isArray(value.semanticIndex) || !Array.isArray(value.resources) || !Array.isArray(value.diagnostics)) return false;
  if (!value.resources.every((resource) => isRecord(resource)
    && typeof resource.id === "string"
    && typeof resource.label === "string"
    && typeof resource.mediaType === "string"
    && typeof resource.uri === "string" && RESOURCE_URI.test(resource.uri)
    && typeof resource.size === "number" && resource.size >= 0)) return false;
  return isRecord(value.payload) && (value.payload.kind === "artifact/raw-v1" || value.payload.kind === "pptx/v1" || value.payload.kind === "qoder-canvas/v1");
}

function isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.threadId === "string"
    && typeof value.label === "string"
    && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    && ARTIFACT_KINDS.has(value.kind as ArtifactKind)
    && ARTIFACT_FAMILIES.has(value.family as ArtifactFamily)
    && typeof value.format === "string"
    && value.backing === "data"
    && isRevision(value.revision)
    && isAdapter(value.adapter)
    && isRenderer(value.renderer)
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) => CAPABILITIES.has(capability as ArtifactCapability));
}

function isRevision(value: unknown): value is ArtifactRevisionReference {
  return isRecord(value)
    && isDigest(value.id)
    && isDigest(value.digest)
    && value.id === value.digest
    && isRecord(value.content)
    && typeof value.content.uri === "string" && CONTENT_URI.test(value.content.uri)
    && typeof value.content.mediaType === "string" && value.content.mediaType !== ""
    && isDigest(value.content.digest)
    && value.content.digest === value.digest;
}

function isAdapter(value: unknown): value is ArtifactAdapterReference {
  return isRecord(value)
    && typeof value.id === "string" && value.id !== ""
    && typeof value.version === "string" && value.version !== ""
    && typeof value.schemaId === "string" && value.schemaId !== ""
    && isDigest(value.snapshotId)
    && typeof value.snapshotUri === "string" && SNAPSHOT_URI.test(value.snapshotUri);
}

function isRenderer(value: unknown): value is ArtifactRendererReference {
  return isRecord(value)
    && typeof value.id === "string" && value.id !== ""
    && typeof value.label === "string" && value.label !== ""
    && (value.provider === "studio" || value.provider === "qoder-canvas")
    && RENDERER_TYPES.has(value.type as ArtifactRendererType)
    && RENDERER_STATUSES.has(value.status as ArtifactRendererStatus)
    && (value.reason === undefined || typeof value.reason === "string");
}

function isDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
