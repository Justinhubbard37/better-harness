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

export interface ArtifactPluginResolution {
  backing: ArtifactBacking;
  adapter: ArtifactAdapterImplementation;
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
