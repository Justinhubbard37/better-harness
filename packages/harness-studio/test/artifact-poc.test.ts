import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertArtifactId,
  confineToRoot,
  describeArtifacts,
  findArtifact,
  indexArtifactDirectory,
  resolveArtifactKind,
} from "../src/server/artifact-catalog.js";

const fixtures = fileURLToPath(new URL("./fixtures/artifacts/", import.meta.url));

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
    expect(confineToRoot("/srv/artifacts", "a.tsx")).toBe(join("/srv/artifacts", "a.tsx"));
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
    const described = describeArtifacts(await indexArtifactDirectory(fixtures));
    expect(described.length).toBeGreaterThan(0);
    for (const descriptor of described) {
      expect(descriptor).not.toHaveProperty("path");
    }
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
