import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isArtifactCatalogResponse, isArtifactDataSnapshot } from "../src/artifact-model.js";
import { activateArtifactContribution } from "../src/server/artifact-provider-activation.js";
import { discoverCanvasViewers } from "../src/server/artifact-viewers.js";
import { createQoderArtifactProvider } from "../src/server/qoder-artifact-provider.js";
import { startHarnessStudioServer, type HarnessStudioServerHandle } from "../src/server/server.js";

const temporary: string[] = [];
let server: HarnessStudioServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("generic external hosted Artifact routes", () => {
  it("serves an activated Qoder contribution without Qoder fields in the common binding", async () => {
    const root = await temp("artifact-provider-server-");
    const appDir = join(root, "app");
    const artifactDirectory = join(root, "artifacts");
    const viewerRoot = join(root, "viewers");
    const viewer = join(viewerRoot, "fixture");
    const sdkMedia = join(root, "sdk-media");
    const stateRoot = join(root, "state");
    await Promise.all([
      mkdir(appDir, { recursive: true }),
      mkdir(artifactDirectory, { recursive: true }),
      mkdir(join(viewer, "scripts"), { recursive: true }),
      mkdir(sdkMedia, { recursive: true }),
    ]);
    await writeFile(join(appDir, "index.html"), "<!doctype html><title>fixture</title>", "utf8");
    await writeFile(join(artifactDirectory, "report.bin"), "artifact bytes", "utf8");
    await writeFile(join(viewer, "manifest.json"), JSON.stringify({
      id: "fixture", label: "Fixture hosted renderer", extensions: ["bin"], dataKey: "fixture",
    }), "utf8");
    await writeFile(join(viewer, "index.canvas.tsx"), 'import { Stack } from "qoder/canvas"; export default () => <Stack />;\n', "utf8");
    await writeFile(join(viewer, "style.css"), ".fixture { color: red; }\n", "utf8");
    await writeFile(join(viewer, "scripts", "index.mjs"), [
      'import { writeFile } from "node:fs/promises";',
      'const args = JSON.parse(process.env.AICODING_CANVAS_SCRIPT_ARGS ?? "{}");',
      'await writeFile(process.env.AICODING_CANVAS_DATA, JSON.stringify({ fixture: { sourcePath: args.targetFilePath, value: "adapted" } }));',
    ].join("\n"), "utf8");
    const sdkPath = join(sdkMedia, "canvas-sdk.js");
    const sdkMapPath = join(sdkMedia, "canvas-sdk.js.map");
    const htmlTemplatePath = join(sdkMedia, "index-canvas.html");
    await writeFile(sdkPath, "export const mountCanvas = () => {};\n", "utf8");
    await writeFile(sdkMapPath, JSON.stringify({ version: 3, sources: [], mappings: "" }), "utf8");
    await writeFile(htmlTemplatePath, '<html><head></head><body><script>const options = { data: new Map() }; mountCanvas("/canvas-module.js?v=1")</script></body></html>', "utf8");

    const discovered = (await discoverCanvasViewers(viewerRoot))[0]!;
    const provider = await createQoderArtifactProvider(discovered, { sdkPath, sdkMapPath, htmlTemplatePath });
    await activateArtifactContribution(provider, "fixture", "external-fallback", { extensions: ["bin"] }, { root: stateRoot });
    server = await startHarnessStudioServer({
      appDir,
      artifactDirectory,
      canvasViewerRoot: viewerRoot,
      canvasSdkMedia: sdkMedia,
      artifactProviderStateRoot: stateRoot,
      walnutCacheRoot: join(root, "walnut-cache"),
    });

    const catalogValue: unknown = await (await fetch(`${server.url}/api/artifacts`)).json();
    expect(isArtifactCatalogResponse(catalogValue)).toBe(true);
    if (!isArtifactCatalogResponse(catalogValue)) throw new Error("expected Artifact catalog");
    const descriptor = catalogValue.artifacts[0]!;
    expect(descriptor).toMatchObject({
      adapter: { schemaId: "qoder-canvas/fixture/v1" },
      renderer: { id: "qoder-canvas.fixture", type: "qoder-canvas", status: "ready", viewUri: expect.any(String) },
    });
    const snapshotValue: unknown = await (await fetch(`${server.url}${descriptor.adapter.snapshotUri}`)).json();
    expect(isArtifactDataSnapshot(snapshotValue)).toBe(true);
    if (!isArtifactDataSnapshot(snapshotValue)) throw new Error("expected Artifact snapshot");
    expect(snapshotValue.payload).toMatchObject({ kind: "qoder-canvas/v1", data: { fixture: { value: "adapted" } } });

    const viewerResponse = await fetch(`${server.url}${descriptor.renderer.viewUri}`);
    expect(viewerResponse.status).toBe(200);
    expect(viewerResponse.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(await viewerResponse.text()).toContain("runtime-module.js");
    const base = descriptor.renderer.viewUri!;
    expect((await fetch(`${server.url}${base}runtime-module.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${server.url}${base}runtime-module.js.map`)).status).toBe(200);
    expect(await (await fetch(`${server.url}${base}style.css`)).text()).toContain("color: red");

    await writeFile(sdkPath, "export const mountCanvas = () => 'changed';\n", "utf8");
    expect((await fetch(`${server.url}${descriptor.renderer.viewUri}`)).status).toBe(415);
    const refreshed = await (await fetch(`${server.url}/api/artifacts`)).json() as { artifacts: Array<{ renderer: { status: string } }> };
    expect(refreshed.artifacts[0]!.renderer.status).toBe("unavailable");
  });
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}
