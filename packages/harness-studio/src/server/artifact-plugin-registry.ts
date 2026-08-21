/**
 * Canonical Artifact View plugin registry boundary.
 *
 * Qoder Canvas is one renderer provider in this registry; it is not the
 * abstract host model. The compatibility export in artifact-viewers.ts remains
 * available for callers that still use the earlier file name.
 */
export {
  defaultCanvasViewerRoot,
  discoverCanvasViewers,
  matchCanvasViewer,
  presentArtifact,
} from "./artifact-viewers.js";
export type {
  ArtifactPluginResolution,
  CanvasViewer as QoderCanvasViewerPlugin,
} from "./artifact-viewers.js";
