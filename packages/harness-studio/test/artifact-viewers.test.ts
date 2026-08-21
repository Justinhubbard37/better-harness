import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileCanvasViewerModule } from "../src/server/canvas-viewer-compile.js";
import type { ArtifactEntry } from "../src/server/artifact-catalog.js";
import { generateViewerData } from "../src/server/artifact-viewer-runtime.js";
import { defaultCanvasViewerRoot, discoverCanvasViewers, presentArtifact } from "../src/server/artifact-viewers.js";

describe("Canvas artifact viewers", () => {
  it("uses the Qoder canvas/canvases directory", () => {
    expect(defaultCanvasViewerRoot({ QODER_HOME: "/qoder-home" }, "/home/test")).toBe(join(resolve("/qoder-home"), "canvas", "canvases"));
    expect(defaultCanvasViewerRoot({}, "/home/test")).toBe(join("/home/test", ".qoder", "canvas", "canvases"));
  });

  it("discovers a viewer and keeps native rendering ahead of non-overrides", async () => {
    const root = await fakeViewerRoot(false);
    const viewers = await discoverCanvasViewers(root);
    expect(viewers).toHaveLength(1);
    expect(presentArtifact(entry("deck.pptx", "pptx"), viewers)).toMatchObject({ renderer: { id: "studio.pptx-dom", type: "native" } });
    expect(presentArtifact(entry("diagram.svg", "svg"), viewers)).toMatchObject({ renderer: { id: "studio.svg", type: "native" } });
    expect(presentArtifact(entry("archive.bin", "unknown"), viewers)).toMatchObject({ renderer: { id: "qoder-canvas.pptx", type: "qoder-canvas" } });
  });

  it("lets an explicit manifest override replace a direct renderer", async () => {
    const viewers = await discoverCanvasViewers(await fakeViewerRoot(true));
    expect(presentArtifact(entry("diagram.svg", "svg"), viewers)).toMatchObject({ renderer: { id: "qoder-canvas.pptx", type: "qoder-canvas" } });
  });

  it("preserves Canvas SDK imports when compiling trusted viewer code", async () => {
    const viewers = await discoverCanvasViewers(await fakeViewerRoot(false));
    const compiled = await compileCanvasViewerModule(viewers[0]!.modulePath);
    expect(compiled.code).toContain('from "qoder/canvas"');
  });

  it("generates request-scoped data without consuming an artifact-adjacent cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-input-"));
    const path = join(directory, "deck.pptx");
    await writeFile(path, "pptx bytes", "utf8");
    await writeFile(join(directory, "deck.canvas.data.json"), JSON.stringify({ officePresentation: { stale: true } }), "utf8");
    const viewer = (await discoverCanvasViewers(await fakeViewerRoot(false)))[0]!;
    const payload = await generateViewerData({ ...entry("deck.pptx", "unknown"), path, size: 10 }, viewer);
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
    await expect(generateViewerData({ ...entry("deck.pptx", "unknown"), path, size: 10 }, viewer)).rejects.toThrow(/does not describe/u);
  });
});

function entry(label: string, kind: ArtifactEntry["kind"]): ArtifactEntry {
  return { id: label.split(".")[0]!, kind, label, path: `/artifacts/${label}`, size: 1 };
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
