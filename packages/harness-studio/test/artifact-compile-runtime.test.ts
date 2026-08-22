import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeArtifactCatalog, indexArtifactDirectory } from "../src/server/artifact-catalog.js";
import {
  artifactCompileCount,
  artifactPreviewHtml,
  compileArtifactPreview,
  resetArtifactCompileRuntime,
} from "../src/server/artifact-compile-runtime.js";
import { resolveArtifactPlugin } from "../src/server/artifact-plugin-registry.js";

async function compileEntry(directory: string, label: string) {
  const index = await indexArtifactDirectory(directory, { includeDigests: true });
  const entry = index.entries.find((candidate) => candidate.label === label)!;
  const resolution = resolveArtifactPlugin(entry, { qoderCanvasViewers: [] });
  const descriptor = describeArtifactCatalog(index, (candidate) => resolveArtifactPlugin(candidate, { qoderCanvasViewers: [] }))
    .artifacts.find((candidate) => candidate.id === entry.id)!;
  return compileArtifactPreview({ artifactRoot: directory, entry, descriptor });
}

describe("ArtifactCompileRuntime", () => {
  it("bundles confined React and CSS sources and reuses an unchanged build", async () => {
    resetArtifactCompileRuntime();
    const directory = await mkdtemp(join(tmpdir(), "artifact-compile-"));
    await writeFile(join(directory, "copy.ts"), 'export const copy = "first render";\n', "utf8");
    await writeFile(join(directory, "card.css"), ".card { color: rebeccapurple; }\n", "utf8");
    await writeFile(join(directory, "card.tsx"), [
      'import { copy } from "./copy.ts";',
      'import "./card.css";',
      'export default () => <main className="card">{copy}</main>;',
    ].join("\n"), "utf8");

    const first = await compileEntry(directory, "card.tsx");
    const second = await compileEntry(directory, "card.tsx");
    expect(first.snapshot.status).toBe("ready");
    expect(first.snapshot.buildId).toBe(second.snapshot.buildId);
    expect(first.snapshot.sequence).toBe(second.snapshot.sequence);
    expect(first.css).toContain("rebeccapurple");
    expect(first.code).toContain("first render");
    expect(artifactCompileCount()).toBe(1);
    const html = artifactPreviewHtml(first);
    expect(html).toContain("runtime.init");
    expect(html).toContain("renderCompleted");
    expect(html).not.toContain(directory);

    await writeFile(join(directory, "copy.ts"), 'export const copy = "newer render";\n', "utf8");
    const changed = await compileEntry(directory, "card.tsx");
    expect(changed.snapshot.status).toBe("ready");
    expect(changed.snapshot.buildId).not.toBe(first.snapshot.buildId);
    expect(changed.snapshot.revisionId).toBe(first.snapshot.revisionId);
    expect(changed.code).toContain("newer render");
    expect(artifactCompileCount()).toBe(2);
  });

  it("fails closed for package imports and filesystem escapes", async () => {
    resetArtifactCompileRuntime();
    const directory = await mkdtemp(join(tmpdir(), "artifact-compile-"));
    await writeFile(join(directory, "package.tsx"), 'import thing from "not-installed"; export default () => <p>{thing}</p>;\n', "utf8");
    await writeFile(join(directory, "escape.tsx"), 'import "../outside.ts"; export default () => <p>unsafe</p>;\n', "utf8");

    const packageBuild = await compileEntry(directory, "package.tsx");
    expect(packageBuild.snapshot.status).toBe("failed");
    expect(packageBuild.snapshot.previewUri).toBeUndefined();
    expect(packageBuild.snapshot.diagnostics[0]?.message).toContain("is not available in Artifact Preview");

    const escapeBuild = await compileEntry(directory, "escape.tsx");
    expect(escapeBuild.snapshot.status).toBe("failed");
    expect(escapeBuild.snapshot.diagnostics[0]?.message).toContain("escapes the artifact directory");
    expect(JSON.stringify(escapeBuild.snapshot)).not.toContain(directory);
  });
});
