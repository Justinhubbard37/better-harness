import {
  ARTIFACT_DATA_SNAPSHOT_KIND,
  type ArtifactDataSnapshot,
  type ArtifactDescriptor,
} from "../artifact-model.js";
import type { ArtifactEntry } from "./artifact-catalog.js";
import { adaptPptxArtifact, readPptxSnapshotResource } from "./pptx-artifact-adapter.js";
import { adaptQoderCanvasViewerData } from "./qoder-canvas-viewer-bridge.js";
import type { QoderCanvasViewerPlugin } from "./artifact-plugin-registry.js";

export async function adaptArtifactData(
  entry: ArtifactEntry,
  descriptor: ArtifactDescriptor,
  options: { canvasViewer?: QoderCanvasViewerPlugin } = {},
): Promise<ArtifactDataSnapshot> {
  if (descriptor.adapter.id === "studio.pptx-ooxml") return await adaptPptxArtifact(entry, descriptor);
  if (descriptor.adapter.id.startsWith("qoder-canvas.")) {
    if (options.canvasViewer === undefined) throw new Error("Qoder Canvas snapshot has no matching viewer bridge.");
    const data = await adaptQoderCanvasViewerData(entry, options.canvasViewer);
    return {
      kind: ARTIFACT_DATA_SNAPSHOT_KIND,
      artifactId: descriptor.id,
      revisionId: descriptor.revision.id,
      snapshotId: descriptor.adapter.snapshotId,
      adapter: { id: descriptor.adapter.id, version: descriptor.adapter.version },
      schemaId: descriptor.adapter.schemaId,
      summary: { label: descriptor.label, family: descriptor.family, format: descriptor.format },
      structure: [{ id: descriptor.id, label: descriptor.label, address: `artifact:${descriptor.id}`, kind: descriptor.kind }],
      semanticIndex: [{ address: `artifact:${descriptor.id}`, label: descriptor.label, kind: descriptor.kind }],
      resources: [],
      diagnostics: [],
      payload: { kind: "qoder-canvas/v1", data },
    };
  }
  return {
    kind: ARTIFACT_DATA_SNAPSHOT_KIND,
    artifactId: descriptor.id,
    revisionId: descriptor.revision.id,
    snapshotId: descriptor.adapter.snapshotId,
    adapter: { id: descriptor.adapter.id, version: descriptor.adapter.version },
    schemaId: descriptor.adapter.schemaId,
    summary: { label: descriptor.label, family: descriptor.family, format: descriptor.format },
    structure: [{ id: descriptor.id, label: descriptor.label, address: `artifact:${descriptor.id}`, kind: descriptor.kind }],
    semanticIndex: [{ address: `artifact:${descriptor.id}`, label: descriptor.label, kind: descriptor.kind }],
    resources: [],
    diagnostics: [],
    payload: { kind: "artifact/raw-v1", content: descriptor.revision.content },
  };
}

export async function readArtifactDataResource(
  entry: ArtifactEntry,
  descriptor: ArtifactDescriptor,
  resourceId: string,
): Promise<{ bytes: Uint8Array; mediaType: string; label: string } | undefined> {
  if (descriptor.adapter.id === "studio.pptx-ooxml") {
    return await readPptxSnapshotResource(entry, descriptor, resourceId);
  }
  return undefined;
}
