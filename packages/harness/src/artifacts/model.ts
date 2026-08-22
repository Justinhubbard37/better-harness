export const ARTIFACT_CATALOG_RESPONSE_KIND = "HarnessStudioArtifactCatalogV2" as const;
export const ARTIFACT_DATA_SNAPSHOT_KIND = "ArtifactDataSnapshotV1" as const;
export const ARTIFACT_BUILD_SNAPSHOT_KIND = "ArtifactBuildSnapshotV1" as const;
export const ARTIFACT_PROVIDER_STATUS_RESPONSE_KIND = "HarnessStudioArtifactProviderStatusV1" as const;

export type ArtifactDigest = `sha256:${string}`;
export type ArtifactFamily = "documents" | "images-diagrams" | "data" | "source-text" | "other";

/**
 * Backing decides which half of the Artifact View lifecycle an artifact takes:
 * `data` goes Adapter -> Snapshot -> Renderer, `code` goes Adapter -> Compile
 * Runtime -> Build Snapshot -> Preview Runtime. Keeping both in the public
 * contract lets the Artifact View host compose their distinct lifecycles.
 */
export type ArtifactBacking = "data" | "code";

/**
 * Renderer types and capabilities grow as providers are added. Consumers must
 * treat an unrecognized value as unsupported, never as an invalid response, so
 * an older Studio tab keeps working against a newer server. The `(string & {})`
 * arm preserves completion for the known values while admitting future ones.
 */
export type KnownArtifactRendererType = "native" | "qoder-canvas" | "sandboxed-web" | "unavailable";
export type ArtifactRendererType = KnownArtifactRendererType | (string & {});
export type KnownArtifactCapability =
  | "compare"
  | "execute"
  | "live-update"
  | "navigate"
  | "outline"
  | "search"
  | "select"
  | "thumbnail"
  | "validate"
  | "zoom";
export type ArtifactCapability = KnownArtifactCapability | (string & {});
export type ArtifactRendererStatus = "ready" | "unavailable";

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
  provider: string;
  type: ArtifactRendererType;
  status: ArtifactRendererStatus;
  /** Present when the renderer is hosted by the server rather than by Studio. */
  viewUri?: string;
  reason?: string;
}

export interface ArtifactBuildReference {
  /** Mutable resolver for the latest build of this exact entry revision. */
  snapshotUri: string;
}

export interface ArtifactDescriptor {
  id: string;
  /**
   * Identity of the logical artifact across revisions. It is derived from the
   * catalog path alone, so it survives edits to this artifact and additions or
   * removals of unrelated files in the same directory.
   */
  threadId: string;
  label: string;
  size: number;
  family: ArtifactFamily;
  /** Stable lowercase format code, for example `pptx`. Never a display label. */
  format: string;
  backing: ArtifactBacking;
  revision: ArtifactRevisionReference;
  adapter: ArtifactAdapterReference;
  build?: ArtifactBuildReference;
  renderer: ArtifactRendererReference;
  capabilities: ArtifactCapability[];
}

export type ArtifactOmissionReason = "not-a-file" | "symlink" | "hard-link" | "outside-root";

/**
 * A directory entry the catalog declined to publish. Omissions are reported
 * rather than dropped: a file that vanishes silently from a run's outputs is
 * indistinguishable from one the run never produced, and that is exactly the
 * question someone reads an artifact catalog to answer.
 */
export interface ArtifactOmission {
  label: string;
  reason: ArtifactOmissionReason;
}

export interface ArtifactCatalogResponse {
  kind: typeof ARTIFACT_CATALOG_RESPONSE_KIND;
  snapshot: {
    catalogId: string;
    revision: ArtifactDigest;
  };
  artifacts: ArtifactDescriptor[];
  omitted: ArtifactOmission[];
}

export interface ArtifactProviderContributionStatus {
  id: string;
  label: string;
  support: "reviewed" | "experimental-local";
  active: boolean;
  lane?: "external-override" | "external-fallback";
}

/** Browser-safe provider diagnostics. Filesystem and executable paths stay server-private. */
export interface ArtifactProviderStatus {
  id: string;
  label: string;
  version?: string;
  acquisition: "operator-provisioned" | "local-derived-experimental";
  status: "ready" | "unavailable";
  receiptVerified: boolean;
  fingerprint?: ArtifactDigest;
  contributions: ArtifactProviderContributionStatus[];
  reason?: string;
}

export interface ArtifactProviderStatusResponse {
  kind: typeof ARTIFACT_PROVIDER_STATUS_RESPONSE_KIND;
  providers: ArtifactProviderStatus[];
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

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "break" }
  | { kind: "emphasis" | "strong" | "strike"; children: MarkdownInline[] }
  | { kind: "link"; href: string; title?: string; children: MarkdownInline[] }
  | { kind: "image"; alt: string; title?: string; resourceId?: string };

export type MarkdownTableAlignment = "left" | "center" | "right";

export interface MarkdownListItem {
  /** Present only for task list items, so an unchecked box stays distinct from a plain item. */
  checked?: boolean;
  blocks: MarkdownBlock[];
}

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; id: string; address: string; children: MarkdownInline[] }
  | { kind: "paragraph"; children: MarkdownInline[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  | { kind: "list"; ordered: boolean; tight: boolean; start?: number; items: MarkdownListItem[] }
  | { kind: "table"; alignments: MarkdownTableAlignment[]; head: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { kind: "thematicBreak" }
  /** Verbatim source Studio declined to interpret, carried as text so nothing disappears. */
  | { kind: "rawHtml"; text: string };

/**
 * A parsed Markdown document.
 *
 * The payload is a block tree rather than an HTML string precisely because the
 * bytes are untrusted: a renderer that receives elements instead of markup has
 * no injection surface to get wrong, and every construct Studio does not
 * support is visible here as its own node rather than as markup it silently
 * passed through.
 */
export interface MarkdownArtifactPayload {
  kind: "markdown/v1";
  blocks: MarkdownBlock[];
}

export interface QoderCanvasArtifactPayload {
  kind: "qoder-canvas/v1";
  data: Record<string, unknown>;
}

/** Provider-owned payload carried by the common, validated snapshot envelope. */
export interface ExternalArtifactPayload {
  /** Namespaced so Studio can still discriminate every built-in payload. */
  kind: `external:${string}`;
  [key: string]: unknown;
}

export type ArtifactSnapshotPayload =
  | RawArtifactPayload
  | PptxArtifactPayload
  | MarkdownArtifactPayload
  | QoderCanvasArtifactPayload
  | ExternalArtifactPayload;

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

export interface ArtifactBuildDiagnostic {
  level: "warning" | "error";
  message: string;
  source?: string;
  line?: number;
  column?: number;
}

/** Immutable result of compiling one code-backed Artifact project. */
export interface ArtifactBuildSnapshot {
  kind: typeof ARTIFACT_BUILD_SNAPSHOT_KIND;
  artifactId: string;
  revisionId: ArtifactDigest;
  buildId: ArtifactDigest;
  sequence: number;
  status: "ready" | "failed";
  runtime: {
    id: "studio.sandboxed-react";
    version: string;
  };
  previewUri?: string;
  diagnostics: ArtifactBuildDiagnostic[];
}

const ARTIFACT_FAMILIES = new Set<ArtifactFamily>(["documents", "images-diagrams", "data", "source-text", "other"]);
const ARTIFACT_BACKINGS = new Set<ArtifactBacking>(["data", "code"]);
const RENDERER_STATUSES = new Set<ArtifactRendererStatus>(["ready", "unavailable"]);

/**
 * Every server-declared reference must stay a same-origin Studio API path.
 *
 * The check deliberately does not pin the exact route shape: pinning it would
 * make the declared reference decorative, because a client that can only follow
 * URIs it could have built itself is not really following anything. What must
 * hold is the security property — the catalog can never point a fetch, an
 * `<img>`, or an iframe at another origin.
 */
function isStudioArtifactPath(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/api/artifacts/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !value.includes("..");
}

export function isArtifactCatalogResponse(value: unknown): value is ArtifactCatalogResponse {
  if (!isRecord(value) || value.kind !== ARTIFACT_CATALOG_RESPONSE_KIND) return false;
  if (!isRecord(value.snapshot)
    || typeof value.snapshot.catalogId !== "string"
    || !isDigest(value.snapshot.revision)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.omitted)) return false;
  if (!value.omitted.every((omission) => isRecord(omission)
    && typeof omission.label === "string"
    && typeof omission.reason === "string")) return false;
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
    && isStudioArtifactPath(resource.uri)
    && typeof resource.size === "number" && resource.size >= 0)) return false;
  // An unknown payload kind is a renderer-selection problem, not a malformed
  // response: the envelope is still usable for outline and diagnostics.
  return isRecord(value.payload) && typeof value.payload.kind === "string";
}

export function isArtifactBuildSnapshot(value: unknown): value is ArtifactBuildSnapshot {
  if (!isRecord(value) || value.kind !== ARTIFACT_BUILD_SNAPSHOT_KIND) return false;
  if (typeof value.artifactId !== "string" || !isDigest(value.revisionId) || !isDigest(value.buildId)) return false;
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return false;
  if (value.status !== "ready" && value.status !== "failed") return false;
  if (!isRecord(value.runtime)
    || value.runtime.id !== "studio.sandboxed-react"
    || typeof value.runtime.version !== "string") return false;
  if (value.previewUri !== undefined && !isStudioArtifactPath(value.previewUri)) return false;
  if (value.status === "ready" && value.previewUri === undefined) return false;
  return Array.isArray(value.diagnostics) && value.diagnostics.every((diagnostic) => isRecord(diagnostic)
    && (diagnostic.level === "warning" || diagnostic.level === "error")
    && typeof diagnostic.message === "string"
    && (diagnostic.source === undefined || typeof diagnostic.source === "string")
    && (diagnostic.line === undefined || typeof diagnostic.line === "number")
    && (diagnostic.column === undefined || typeof diagnostic.column === "number"));
}

function isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
  return isRecord(value)
    && typeof value.id === "string" && value.id !== ""
    && typeof value.threadId === "string" && value.threadId !== ""
    && typeof value.label === "string"
    && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    && ARTIFACT_FAMILIES.has(value.family as ArtifactFamily)
    && typeof value.format === "string" && value.format !== ""
    && ARTIFACT_BACKINGS.has(value.backing as ArtifactBacking)
    && isRevision(value.revision)
    && isAdapter(value.adapter)
    && (value.build === undefined || (isRecord(value.build) && isStudioArtifactPath(value.build.snapshotUri)))
    && (value.backing !== "code" || value.build !== undefined)
    && isRenderer(value.renderer)
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) => typeof capability === "string" && capability !== "");
}

function isRevision(value: unknown): value is ArtifactRevisionReference {
  return isRecord(value)
    && isDigest(value.id)
    && isDigest(value.digest)
    && value.id === value.digest
    && isRecord(value.content)
    && isStudioArtifactPath(value.content.uri)
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
    && isStudioArtifactPath(value.snapshotUri);
}

function isRenderer(value: unknown): value is ArtifactRendererReference {
  return isRecord(value)
    && typeof value.id === "string" && value.id !== ""
    && typeof value.label === "string" && value.label !== ""
    && typeof value.provider === "string" && value.provider !== ""
    && typeof value.type === "string" && value.type !== ""
    && RENDERER_STATUSES.has(value.status as ArtifactRendererStatus)
    && (value.viewUri === undefined || isStudioArtifactPath(value.viewUri))
    && (value.reason === undefined || typeof value.reason === "string");
}

function isDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
