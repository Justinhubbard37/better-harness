import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTrustedRendererModule } from "../src/server/trusted-renderer-compiler.js";
import { artifactIdForLabel, artifactThreadIdForLabel, type ArtifactEntry } from "../src/server/artifact-catalog.js";
import { adaptQoderCanvasViewerData } from "../src/server/qoder-canvas-viewer-bridge.js";
import { defaultCanvasViewerRoot, discoverCanvasViewers, resolveArtifactPlugin } from "../src/server/artifact-plugin-registry.js";
import type { CanvasViewer } from "../src/server/artifact-viewers.js";

describe("Artifact plugin registry and the Qoder Canvas provider", () => {
  it("uses the Qoder canvas/canvases directory", () => {
    expect(defaultCanvasViewerRoot({ QODER_HOME: "/qoder-home" }, "/home/test")).toBe(join(resolve("/qoder-home"), "canvas", "canvases"));
    expect(defaultCanvasViewerRoot({}, "/home/test")).toBe(join("/home/test", ".qoder", "canvas", "canvases"));
  });

  it("discovers a viewer and keeps native rendering ahead of non-overrides", async () => {
    const root = await fakeViewerRoot(false);
    const viewers = await discoverCanvasViewers(root);
    expect(viewers).toHaveLength(1);
    expect(resolve_(entry("deck.pptx", "pptx"), viewers)).toMatchObject({ renderer: { id: "studio.pptx-dom", type: "native" } });
    expect(resolve_(entry("diagram.svg", "svg"), viewers)).toMatchObject({
      backing: "code",
      buildRuntime: { id: "studio.svg-react" },
      renderer: { id: "studio.svg-react-preview", type: "sandboxed-web" },
    });
    expect(resolve_(entry("archive.bin", "unknown"), viewers)).toMatchObject({ renderer: { id: "qoder-canvas.pptx", type: "qoder-canvas" } });
  });

  it("lets an explicit manifest override replace a direct renderer", async () => {
    const viewers = await discoverCanvasViewers(await fakeViewerRoot(true));
    expect(resolve_(entry("diagram.svg", "svg"), viewers)).toMatchObject({ renderer: { id: "qoder-canvas.pptx", type: "qoder-canvas" } });
  });

  it("keeps an explicit override ahead of a non-overriding viewer that sorts first", async () => {
    // The declared priority puts an operator override above Studio's native
    // renderer. Inspecting only the first match would silently drop it whenever
    // another viewer for the same extension came earlier in discovery order.
    const plain = fakeViewer("a-plain", false);
    const override = fakeViewer("z-override", true);
    expect(resolve_(entry("deck.pptx", "pptx"), [plain, override]).renderer.id).toBe("qoder-canvas.z-override");
    expect(resolve_(entry("deck.pptx", "pptx"), [override, plain]).renderer.id).toBe("qoder-canvas.z-override");
    expect(resolve_(entry("deck.pptx", "pptx"), [plain]).renderer.id).toBe("studio.pptx-dom");
  });

  it("preserves Canvas SDK imports when compiling trusted viewer code", async () => {
    const viewers = await discoverCanvasViewers(await fakeViewerRoot(false));
    const compiled = await compileTrustedRendererModule(viewers[0]!.modulePath);
    expect(compiled.code).toContain('from "qoder/canvas"');
  });

  it("generates request-scoped data without consuming an artifact-adjacent cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-input-"));
    const path = join(directory, "deck.pptx");
    await writeFile(path, "pptx bytes", "utf8");
    await writeFile(join(directory, "deck.canvas.data.json"), JSON.stringify({ officePresentation: { stale: true } }), "utf8");
    const viewer = (await discoverCanvasViewers(await fakeViewerRoot(false)))[0]!;
    const payload = await adaptQoderCanvasViewerData({ ...entry("deck.pptx", "unknown"), path, size: 10 }, viewer);
    expect(payload.officePresentation).toMatchObject({ error: "", generated: true });
    expect(payload.officePresentation).not.toHaveProperty("stale");
  });

  it("rejects sidecar data for a different source path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-input-"));
    const path = join(directory, "deck.pptx");
    await writeFile(path, "pptx bytes", "utf8");
    const viewer = (await discoverCanvasViewers(await fakeViewerRoot(false)))[0]!;
    await writeFile(viewer.scriptPath!, [
      'import { writeFile } from "node:fs/promises";',
      'await writeFile(process.env.AICODING_CANVAS_DATA, JSON.stringify({ officePresentation: { error: "", sourcePath: "/another/deck.pptx" } }));',
    ].join("\n"), "utf8");
    await expect(adaptQoderCanvasViewerData({ ...entry("deck.pptx", "unknown"), path, size: 10 }, viewer)).rejects.toThrow(/does not describe/u);
  });
});

function resolve_(entry: ArtifactEntry, viewers: readonly CanvasViewer[]) {
  return resolveArtifactPlugin(entry, { qoderCanvasViewers: viewers });
}

function entry(label: string, kind: ArtifactEntry["kind"]): ArtifactEntry {
  return {
    id: artifactIdForLabel(label),
    threadId: artifactThreadIdForLabel(label),
    kind,
    label,
    path: `/artifacts/${label}`,
    size: 1,
  };
}

function fakeViewer(id: string, overrideBuiltIn: boolean): CanvasViewer {
  return {
    id,
    label: id,
    extensions: ["pptx"],
    pathGlobs: [],
    dataKey: "officePresentation",
    overrideBuiltIn,
    rootPath: `/viewers/${id}`,
    modulePath: `/viewers/${id}/index.canvas.tsx`,
    scriptPath: `/viewers/${id}/scripts/index.mjs`,
  };
}

async function fakeViewerRoot(overrideBuiltIn: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "canvas-viewers-"));
  const viewer = join(root, "pptx");
  await mkdir(join(viewer, "scripts"), { recursive: true });
  await writeFile(join(viewer, "manifest.json"), JSON.stringify({
    id: "pptx",
    label: "PowerPoint Presentation",
    extensions: ["pptx", "svg", "bin"],
    dataKey: "officePresentation",
    overrideBuiltIn,
  }), "utf8");
  await writeFile(join(viewer, "index.canvas.tsx"), 'import { Stack } from "qoder/canvas"; export default function Viewer() { return <Stack />; }\n', "utf8");
  await writeFile(join(viewer, "scripts", "index.mjs"), [
    'import { writeFile } from "node:fs/promises";',
    'const data = process.env.AICODING_CANVAS_DATA;',
    'const args = JSON.parse(process.env.AICODING_CANVAS_SCRIPT_ARGS ?? "{}");',
    'await writeFile(data, JSON.stringify({ officePresentation: { error: "", generated: true, sourcePath: args.targetFilePath } }));',
  ].join("\n"), "utf8");
  return root;
}
