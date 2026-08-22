/**
 * Interfaces every Artifact View plugin implements.
 *
 * They live apart from the registry so an adapter can be written against them
 * without importing the registry that selects it, and so the catalog can type
 * a resolution without depending on the providers that produce one.
 */
import type {
  ArtifactBacking,
  ArtifactCapability,
  ArtifactDataSnapshot,
  ArtifactDescriptor,
  ArtifactRendererReference,
} from "../artifact-model.js";
import type { ArtifactEntry } from "./artifact-catalog.js";
import type { CanvasViewer } from "./artifact-viewers.js";

export interface ArtifactAdaptContext {
  entry: ArtifactEntry;
  descriptor: ArtifactDescriptor;
}

export interface ArtifactResourceBytes {
  bytes: Uint8Array;
  mediaType: string;
  label: string;
}

/**
 * Turns one artifact revision into an immutable data snapshot.
 *
 * The registry hands the selected implementation to the caller directly. A
 * caller that re-derived it from `descriptor.adapter.id` would be re-deciding
 * a decision the registry already made, and the two would drift apart into a
 * silent fallback the first time an id changed.
 */
export interface ArtifactAdapterImplementation {
  id: string;
  version: string;
  schemaId: string;
  adapt(context: ArtifactAdaptContext): Promise<ArtifactDataSnapshot>;
  readResource?(context: ArtifactAdaptContext, resourceId: string): Promise<ArtifactResourceBytes | undefined>;
}

/**
 * Trusted compile contribution selected by the Artifact plugin registry.
 *
 * A source module compiles the artifact as authored. A virtual module is
 * Studio-owned React code that consumes the artifact's exact bytes through the
 * `artifact-source` import. Artifact bytes never provide module source,
 * package permissions, or build options.
 */
export interface ArtifactBuildRuntimeImplementation {
  id: string;
  version: string;
  module:
    | { kind: "source" }
    | {
      kind: "virtual";
      source: string;
      sourceLoader: "text";
      runtimePackages: readonly string[];
      minify?: boolean;
    };
}

export interface ArtifactPluginResolution {
  backing: ArtifactBacking;
  adapter: ArtifactAdapterImplementation;
  /** Present only when the selected plugin owns a code-backed build lifecycle. */
  buildRuntime?: ArtifactBuildRuntimeImplementation;
  renderer: ArtifactRendererReference;
  capabilities: ArtifactCapability[];
  /** The server hosts this renderer's surface, so the catalog publishes a viewUri. */
  hosted?: boolean;
  /** Bound Qoder viewer, for the routes that serve its module and static assets. */
  qoderViewer?: CanvasViewer;
}

export interface ArtifactPluginContext {
  qoderCanvasViewers: readonly CanvasViewer[];
}

/**
 * One ordered step of renderer resolution. Returning `undefined` means "not my
 * artifact"; the registry then tries the next provider.
 */
export interface ArtifactRendererProvider {
  id: string;
  resolve(entry: ArtifactEntry, context: ArtifactPluginContext): ArtifactPluginResolution | undefined;
}
