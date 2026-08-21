import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertArtifactId,
  ArtifactCatalogContractError,
  confineToRoot,
  describeArtifactCatalog,
  findArtifact,
  indexArtifactDirectory,
  resolveArtifactMediaType,
  resolveArtifactKind,
} from "../src/server/artifact-catalog.js";
import type { ArtifactPresentation } from "../src/artifact-catalog-contract.js";
import { isArtifactCatalogResponse } from "../src/artifact-catalog-contract.js";

const fixtures = fileURLToPath(new URL("./fixtures/artifacts/", import.meta.url));
const presentationFor = (entry: { kind: string }): ArtifactPresentation => ({
  renderer: entry.kind === "unknown" ? "unavailable" : entry.kind as ArtifactPresentation["renderer"],
});

describe("resolveArtifactKind", () => {
  it("maps known extensions to their renderer tier", () => {
    expect(resolveArtifactKind("report.tsx")).toBe("code");
    expect(resolveArtifactKind("chart.jsx")).toBe("code");
    expect(resolveArtifactKind("fix.patch")).toBe("diff");
    expect(resolveArtifactKind("verdict.json")).toBe("json");
    expect(resolveArtifactKind("diagram.svg")).toBe("svg");
    expect(resolveArtifactKind("notes.md")).toBe("text");
  });

  it("is case-insensitive on the extension", () => {
    expect(resolveArtifactKind("Report.TSX")).toBe("code");
  });

  it("returns unknown rather than guessing a renderer", () => {
    expect(resolveArtifactKind("deck.pptx")).toBe("unknown");
    expect(resolveArtifactKind("archive.bin")).toBe("unknown");
    expect(resolveArtifactKind("noextension")).toBe("unknown");
  });
});

describe("resolveArtifactMediaType", () => {
  it("keeps artifact references format-aware without claiming a renderer", () => {
    expect(resolveArtifactMediaType("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(resolveArtifactMediaType("report.pdf")).toBe("application/pdf");
    expect(resolveArtifactMediaType("motion.lottie")).toBe("application/zip");
    expect(resolveArtifactMediaType("script.mjs")).toBe("text/javascript; charset=utf-8");
    expect(resolveArtifactMediaType("archive.bin")).toBe("application/octet-stream");
  });
});

describe("assertArtifactId", () => {
  it("returns opaque ids unchanged", () => {
    expect(assertArtifactId("tool-mix")).toBe("tool-mix");
    expect(assertArtifactId("run_42")).toBe("run_42");
  });

  it("rejects path-shaped and traversal input", () => {
    for (const candidate of ["../secret", "a/b", "/etc/passwd", "..", "a.b", "", "a b"]) {
      expect(() => assertArtifactId(candidate)).toThrow(/Artifact id must match/u);
    }
  });

  it("rejects non-string input", () => {
    expect(() => assertArtifactId(undefined)).toThrow(/Artifact id must match/u);
    expect(() => assertArtifactId(42)).toThrow(/Artifact id must match/u);
  });
});

describe("confineToRoot", () => {
  it("resolves names inside the root", () => {
    expect(confineToRoot("/srv/artifacts", "a.tsx")).toBe(resolve("/srv/artifacts", "a.tsx"));
  });

  it("rejects escapes regardless of separator style", () => {
    expect(() => confineToRoot("/srv/artifacts", "../outside.tsx")).toThrow(/escapes the artifact directory/u);
    expect(() => confineToRoot("/srv/artifacts", "nested/../../outside.tsx")).toThrow(
      /escapes the artifact directory/u,
    );
  });

  it("rejects a sibling directory sharing the root's prefix", () => {
    expect(() => confineToRoot("/srv/artifacts", "../artifacts-evil/x.tsx")).toThrow(
      /escapes the artifact directory/u,
    );
  });
});

describe("indexArtifactDirectory", () => {
  it("indexes fixture files with opaque ids and real sizes", async () => {
    const entries = await indexArtifactDirectory(fixtures);
    const toolMix = findArtifact(entries, "tool-mix");
    expect(toolMix).toBeDefined();
    expect(toolMix?.kind).toBe("code");
    expect(toolMix?.label).toBe("tool-mix.tsx");
    expect(toolMix?.size).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(() => assertArtifactId(entry.id)).not.toThrow();
    }
  });

  it("omits filesystem paths from the described catalog", async () => {
    const catalog = describeArtifactCatalog(
      await indexArtifactDirectory(fixtures, { includeDigests: true }),
      presentationFor,
    );
    expect(catalog.kind).toBe("HarnessStudioArtifactCatalogV1");
    expect(isArtifactCatalogResponse(catalog)).toBe(true);
    expect(catalog.artifacts.length).toBeGreaterThan(0);
    for (const descriptor of catalog.artifacts) {
      expect(descriptor).not.toHaveProperty("path");
      expect(descriptor.artifact.uri).toBe(`/api/artifacts/${descriptor.id}/content`);
      expect(descriptor.artifact).not.toHaveProperty("role");
      expect(descriptor.artifact).not.toHaveProperty("data");
    }
    const malformed = structuredClone(catalog);
    malformed.artifacts[0]!.artifact.uri = "https://untrusted.invalid/artifact";
    expect(isArtifactCatalogResponse(malformed)).toBe(false);
  });

  it("binds the catalog snapshot to exact artifact bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-catalog-"));
    const path = join(directory, "notes.txt");
    await writeFile(path, "first", "utf8");
    await writeFile(join(directory, "stable.txt"), "stable", "utf8");
    const firstEntries = await indexArtifactDirectory(directory, { includeDigests: true });
    const first = describeArtifactCatalog(firstEntries, (entry) => ({
      renderer: entry.id === "notes" ? "text" : "code",
    }));
    expect(first.snapshot.catalogId).toBe("harness-studio-artifacts");
    expect(first.snapshot.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.artifacts[0]?.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.artifacts[0]).not.toHaveProperty("path");
    expect(first.artifacts.find((entry) => entry.id === "notes")?.renderer).toBe("text");
    expect(first.artifacts.find((entry) => entry.id === "stable")?.renderer).toBe("code");
    expect(describeArtifactCatalog([...firstEntries].reverse(), presentationFor).snapshot).toEqual(first.snapshot);

    await writeFile(path, "second", "utf8");
    const second = describeArtifactCatalog(
      await indexArtifactDirectory(directory, { includeDigests: true }),
      presentationFor,
    );
    expect(second.snapshot.revision).not.toBe(first.snapshot.revision);
    expect(second.artifacts[0]?.artifact.digest).not.toBe(first.artifacts[0]?.artifact.digest);
  });

  it("refuses to mint a revision snapshot without exact-byte digests", async () => {
    const entries = await indexArtifactDirectory(fixtures);
    expect(() => describeArtifactCatalog(entries, presentationFor)).toThrow(ArtifactCatalogContractError);
  });

  it("disambiguates ids that collide after sanitizing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-catalog-"));
    await writeFile(join(directory, "a b.tsx"), "export default () => null;\n", "utf8");
    await writeFile(join(directory, "a-b.tsx"), "export default () => null;\n", "utf8");
    const ids = (await indexArtifactDirectory(directory)).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not follow files symlinked outside the artifact directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-catalog-"));
    await symlink("/etc/hosts", join(directory, "leak.txt"));
    expect(await indexArtifactDirectory(directory)).toEqual([]);
  });
});
