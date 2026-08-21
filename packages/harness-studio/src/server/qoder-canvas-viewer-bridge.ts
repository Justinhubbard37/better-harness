/**
 * Optional bridge for provisioned Qoder Canvas viewers.
 *
 * All values crossing this boundary are revision-scoped artifact data. Studio
 * does not treat the Canvas SDK as its generic Artifact View runtime.
 */
export {
  generateViewerData as adaptQoderCanvasViewerData,
  prepareCanvasViewer as prepareQoderCanvasViewer,
  resolveCanvasRuntime as resolveQoderCanvasRuntime,
  serveRuntimeFile as serveQoderCanvasRuntimeFile,
} from "./artifact-viewer-runtime.js";
export type {
  CanvasRuntime as QoderCanvasRuntime,
} from "./artifact-viewer-runtime.js";
