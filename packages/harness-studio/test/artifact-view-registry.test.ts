import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtifactDescriptor, ArtifactRendererReference } from "../src/artifact-model.js";
import {
  ARTIFACT_SURFACE_MOUNTS,
  ArtifactView,
  normalizeArtifactSurfaceKind,
  resolveArtifactSurfaceMount,
} from "../src/app/ArtifactView.js";

describe("Artifact View surface registry", () => {
  it("keeps one stable ordered composition boundary for every view family", () => {
    expect(ARTIFACT_SURFACE_MOUNTS.map((mount) => mount.id)).toEqual([
      "studio.sandboxed-preview",
      "external-hosted",
      "studio.markdown",
      "studio.pptx-dom",
      "studio.image",
      "studio.text-family",
    ]);
  });

  it.each([
    ["dynamic React", descriptor({ id: "studio.react-preview", type: "sandboxed-web" }, { backing: "code", format: "tsx" }), "studio.sandboxed-preview"],
    ["Qoder Canvas", descriptor({ id: "qoder-canvas.deck", type: "qoder-canvas", viewUri: "/api/artifacts/deck/view" }), "external-hosted"],
    ["Markdown", descriptor({ id: "studio.markdown" }, { format: "md" }), "studio.markdown"],
    ["PPTX", descriptor({ id: "studio.pptx-dom" }, { format: "pptx" }), "studio.pptx-dom"],
    ["SVG", descriptor({ id: "studio.svg-react-preview", type: "sandboxed-web" }, { backing: "code", format: "svg" }), "studio.sandboxed-preview"],
    ["Mermaid", descriptor({ id: "studio.mermaid-react-preview", type: "sandboxed-web" }, { backing: "code", format: "mmd" }), "studio.sandboxed-preview"],
    ["image", descriptor({ id: "studio.image" }, { format: "png" }), "studio.image"],
    ["code", descriptor({ id: "studio.code" }, { format: "ts" }), "studio.text-family"],
    ["diff", descriptor({ id: "studio.diff" }, { format: "diff" }), "studio.text-family"],
    ["JSON", descriptor({ id: "studio.json" }, { format: "json" }), "studio.text-family"],
    ["text", descriptor({ id: "studio.text" }, { format: "txt" }), "studio.text-family"],
  ])("resolves the server-selected %s renderer", (_label, artifact, expected) => {
    expect(resolveArtifactSurfaceMount(artifact)?.id).toBe(expected);
  });

  it("does not reclassify an unknown renderer from a familiar extension", () => {
    const artifact = descriptor({ id: "future.deck-renderer" }, { label: "deck.pptx", format: "pptx" });
    expect(resolveArtifactSurfaceMount(artifact)).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ArtifactView, { artifact, liveGeneration: 0 })))
      .toContain("No renderer is available for this artifact (future.deck-renderer).");
    expect(resolveArtifactSurfaceMount(descriptor({ id: "studio.pptx-dom", type: "future-native" }, { format: "pptx" }))).toBeUndefined();
  });

  it("rejects a malformed hosted renderer and preserves unavailable reasons", () => {
    const missingView = descriptor({ id: "qoder-canvas.deck", type: "qoder-canvas" });
    expect(normalizeArtifactSurfaceKind(missingView)).toBe("external-hosted");
    expect(resolveArtifactSurfaceMount(missingView)).toBeUndefined();

    const unavailable = descriptor({
      id: "studio.unavailable",
      type: "unavailable",
      status: "unavailable",
      reason: "No approved renderer matches this revision.",
    });
    const markup = renderToStaticMarkup(createElement(ArtifactView, { artifact: unavailable, liveGeneration: 0 }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("No approved renderer matches this revision.");
  });
});

const DIGEST = `sha256:${"1".repeat(64)}` as const;

function descriptor(
  renderer: Pick<ArtifactRendererReference, "id"> & Partial<ArtifactRendererReference>,
  artifact: Partial<Pick<ArtifactDescriptor, "backing" | "format" | "label">> = {},
): ArtifactDescriptor {
  const label = artifact.label ?? "example.bin";
  return {
    id: "artifact-example",
    threadId: "artifact-thread-example",
    label,
    size: 1,
    family: "source-text",
    format: artifact.format ?? "unknown",
    backing: artifact.backing ?? "data",
    revision: {
      id: DIGEST,
      digest: DIGEST,
      content: { uri: "/api/artifacts/example/content", mediaType: "application/octet-stream", digest: DIGEST },
    },
    adapter: {
      id: "studio.raw",
      version: "1",
      schemaId: "artifact/raw-v1",
      snapshotId: DIGEST,
      snapshotUri: "/api/artifacts/example/snapshot",
    },
    renderer: {
      label: renderer.id,
      provider: "studio",
      type: "native",
      status: "ready",
      ...renderer,
    },
    capabilities: [],
  };
}
