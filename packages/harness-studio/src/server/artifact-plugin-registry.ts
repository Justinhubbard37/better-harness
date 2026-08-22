/**
 * The Artifact View plugin registry.
 *
 * Resolution is an ordered list of providers rather than a branch chain, so a
 * new format is added by writing a provider and inserting it here. Qoder Canvas
 * is two of those providers; it is not the host abstraction, and nothing in the
 * registry's shape assumes a Canvas surface.
 */
import { extname } from "node:path";
import {
  ARTIFACT_DATA_SNAPSHOT_KIND,
  type ArtifactDataSnapshot,
  type ArtifactRendererReference,
} from "../artifact-model.js";
import type {
  ArtifactAdaptContext,
  ArtifactAdapterImplementation,
  ArtifactPluginContext,
  ArtifactPluginResolution,
  ArtifactRendererProvider,
} from "./artifact-adapter-contract.js";
import type { ArtifactEntry, ArtifactKind } from "./artifact-catalog.js";
import {
  MERMAID_REACT_BUILD_RUNTIME,
  REACT_SOURCE_BUILD_RUNTIME,
  SVG_REACT_BUILD_RUNTIME,
} from "./artifact-build-runtimes.js";
import { matchCanvasViewers, type CanvasViewer } from "./artifact-viewers.js";
import { MARKDOWN_ARTIFACT_ADAPTER } from "./markdown-artifact-adapter.js";
import { PPTX_ARTIFACT_ADAPTER } from "./pptx-artifact-adapter.js";
import { adaptQoderCanvasViewerData } from "./qoder-canvas-viewer-bridge.js";

export {
  defaultCanvasViewerRoot,
  discoverCanvasViewers,
  matchCanvasViewer,
  matchCanvasViewers,
  resetCanvasViewerDiscoveryCache,
} from "./artifact-viewers.js";
export type {
  ArtifactAdaptContext,
  ArtifactAdapterImplementation,
  ArtifactBuildRuntimeImplementation,
  ArtifactPluginContext,
  ArtifactPluginResolution,
  ArtifactRendererProvider,
  ArtifactResourceBytes,
} from "./artifact-adapter-contract.js";
export type { CanvasViewer as QoderCanvasViewerPlugin } from "./artifact-viewers.js";

const RAW_ADAPTER_ID = "studio.raw";
const RAW_SCHEMA_ID = "artifact/raw-v1";

/** Passes the exact content reference through for renderers that read bytes. */
const RAW_ARTIFACT_ADAPTER: ArtifactAdapterImplementation = {
  id: RAW_ADAPTER_ID,
  version: "1",
  schemaId: RAW_SCHEMA_ID,
  adapt: async (context) => envelopeSnapshot(context, {
    kind: "artifact/raw-v1",
    content: context.descriptor.revision.content,
  }),
};

function qoderCanvasAdapter(viewer: CanvasViewer): ArtifactAdapterImplementation {
  return {
    id: `qoder-canvas.${viewer.id}.sidecar`,
    version: "1",
    schemaId: `qoder-canvas/${viewer.id}/v1`,
    adapt: async (context) => envelopeSnapshot(context, {
      kind: "qoder-canvas/v1",
      data: await adaptQoderCanvasViewerData(context.entry, viewer),
    }),
  };
}

async function envelopeSnapshot(
  context: ArtifactAdaptContext,
  payload: ArtifactDataSnapshot["payload"],
): Promise<ArtifactDataSnapshot> {
  const descriptor = context.descriptor;
  const address = `artifact:${descriptor.id}`;
  return {
    kind: ARTIFACT_DATA_SNAPSHOT_KIND,
    artifactId: descriptor.id,
    revisionId: descriptor.revision.id,
    snapshotId: descriptor.adapter.snapshotId,
    adapter: { id: descriptor.adapter.id, version: descriptor.adapter.version },
    schemaId: descriptor.adapter.schemaId,
    summary: { label: descriptor.label, family: descriptor.family, format: descriptor.format },
    structure: [{ id: descriptor.id, label: descriptor.label, address, kind: descriptor.format }],
    semanticIndex: [{ address, label: descriptor.label, kind: descriptor.format }],
    resources: [],
    diagnostics: [],
    payload,
  };
}

function qoderCanvasResolution(viewer: CanvasViewer): ArtifactPluginResolution {
  const reference: ArtifactRendererReference = {
    id: `qoder-canvas.${viewer.id}`,
    label: viewer.label,
    provider: "qoder-canvas",
    type: "qoder-canvas",
    status: "ready",
  };
  if (viewer.scriptPath === undefined || viewer.dataKey === undefined) {
    return {
      backing: "data",
      adapter: qoderCanvasAdapter(viewer),
      renderer: {
        ...reference,
        type: "unavailable",
        status: "unavailable",
        reason: "The matching Qoder Canvas viewer has no target-file data adapter.",
      },
      capabilities: [],
    };
  }
  return {
    backing: "data",
    adapter: qoderCanvasAdapter(viewer),
    renderer: reference,
    hosted: true,
    qoderViewer: viewer,
    capabilities: ["navigate", "select", "zoom"],
  };
}

function nativeResolution(kind: ArtifactKind): ArtifactPluginResolution | undefined {
  if (kind === "markdown") {
    return {
      backing: "data",
      adapter: MARKDOWN_ARTIFACT_ADAPTER,
      renderer: { id: "studio.markdown", label: "Studio Markdown", provider: "studio", type: "native", status: "ready" },
      // Only what the renderer actually does: an outline built from the
      // document's headings, and navigation to the one a reader picks.
      capabilities: ["navigate", "outline"],
    };
  }
  if (kind === "pptx") {
    return {
      backing: "data",
      adapter: PPTX_ARTIFACT_ADAPTER,
      renderer: { id: "studio.pptx-dom", label: "Studio PPTX", provider: "studio", type: "native", status: "ready" },
      capabilities: ["navigate", "outline", "select", "zoom"],
    };
  }
  if (kind === "unknown" || kind === "mermaid") return undefined;
  return {
    backing: "data",
    adapter: RAW_ARTIFACT_ADAPTER,
    renderer: { id: `studio.${kind}`, label: nativeRendererLabel(kind), provider: "studio", type: "native", status: "ready" },
    capabilities: kind === "image" || kind === "svg" ? ["select", "zoom"] : ["search", "select"],
  };
}

function studioCodePreviewResolution(entry: ArtifactEntry): ArtifactPluginResolution | undefined {
  if (entry.kind !== "code" || ![".tsx", ".jsx"].includes(extname(entry.label).toLowerCase())) return undefined;
  return {
    backing: "code",
    adapter: RAW_ARTIFACT_ADAPTER,
    buildRuntime: REACT_SOURCE_BUILD_RUNTIME,
    renderer: {
      id: "studio.react-preview",
      label: "Studio React Preview",
      provider: "studio",
      type: "sandboxed-web",
      status: "ready",
    },
    capabilities: ["execute", "live-update", "select"],
  };
}

function studioDocumentPreviewResolution(entry: ArtifactEntry): ArtifactPluginResolution | undefined {
  const buildRuntime = entry.kind === "svg"
    ? SVG_REACT_BUILD_RUNTIME
    : entry.kind === "mermaid" ? MERMAID_REACT_BUILD_RUNTIME : undefined;
  if (buildRuntime === undefined) return undefined;
  const label = entry.kind === "svg" ? "Studio SVG Preview" : "Studio Mermaid Preview";
  return {
    backing: "code",
    adapter: RAW_ARTIFACT_ADAPTER,
    buildRuntime,
    renderer: {
      id: entry.kind === "svg" ? "studio.svg-react-preview" : "studio.mermaid-react-preview",
      label,
      provider: "studio",
      type: "sandboxed-web",
      status: "ready",
    },
    capabilities: ["execute", "live-update"],
  };
}

function nativeRendererLabel(kind: Exclude<ArtifactKind, "unknown" | "pptx" | "mermaid">): string {
  return ({
    code: "Studio code",
    diff: "Studio diff",
    image: "Studio image",
    json: "Studio JSON",
    markdown: "Studio Markdown",
    svg: "Studio SVG",
    text: "Studio text",
  })[kind];
}

/**
 * Ordered resolution, matching the Artifact View model's declared priority:
 * an operator's overriding Qoder viewer, then a Studio-native plugin, then any
 * matching Qoder viewer, then an honest unavailable state.
 */
export const ARTIFACT_RENDERER_PROVIDERS: readonly ArtifactRendererProvider[] = [
  {
    id: "qoder-canvas-override",
    resolve(entry, context) {
      // Search every match, not just the first: an operator's override would
      // otherwise be discarded whenever a non-overriding viewer for the same
      // extension happened to sort earlier in the discovery order.
      const override = matchCanvasViewers(entry, context.qoderCanvasViewers).find((viewer) => viewer.overrideBuiltIn);
      return override === undefined ? undefined : qoderCanvasResolution(override);
    },
  },
  {
    id: "studio-code-preview",
    resolve: studioCodePreviewResolution,
  },
  {
    id: "studio-document-preview",
    resolve: studioDocumentPreviewResolution,
  },
  {
    id: "studio-native",
    resolve: (entry) => nativeResolution(entry.kind),
  },
  {
    id: "qoder-canvas",
    resolve(entry, context) {
      const viewer = matchCanvasViewers(entry, context.qoderCanvasViewers)[0];
      return viewer === undefined ? undefined : qoderCanvasResolution(viewer);
    },
  },
  {
    id: "studio-raw",
    resolve: () => ({
      backing: "data",
      adapter: RAW_ARTIFACT_ADAPTER,
      renderer: {
        id: "studio.unavailable",
        label: "Unavailable",
        provider: "studio",
        type: "unavailable",
        status: "unavailable",
        reason: "No native renderer or provisioned Qoder Canvas viewer matches this file.",
      },
      capabilities: [],
    }),
  },
];

export function resolveArtifactPlugin(entry: ArtifactEntry, context: ArtifactPluginContext): ArtifactPluginResolution {
  for (const provider of ARTIFACT_RENDERER_PROVIDERS) {
    const resolution = provider.resolve(entry, context);
    if (resolution !== undefined) return resolution;
  }
  throw new Error("The artifact plugin registry has no terminal provider.");
}
