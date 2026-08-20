import { mkdtemp, utimes, writeFile } from "node:fs/promises";
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
import {
  artifactCompileCount,
  compileArtifactModule,
  compileArtifactSource,
  formatArtifactCompileError,
  resetArtifactModuleCache,
  stripHostProvidedImports,
} from "../src/server/artifact-compile.js";

const fixtures = fileURLToPath(new URL("./fixtures/artifacts/", import.meta.url));

describe("resolveArtifactKind", () => {
  it("maps known extensions to their renderer tier", () => {
    expect(resolveArtifactKind("report.tsx")).toBe("module");
    expect(resolveArtifactKind("chart.jsx")).toBe("module");
    expect(resolveArtifactKind("fix.patch")).toBe("diff");
    expect(resolveArtifactKind("verdict.json")).toBe("json");
    expect(resolveArtifactKind("diagram.svg")).toBe("svg");
    expect(resolveArtifactKind("notes.md")).toBe("text");
  });

  it("is case-insensitive on the extension", () => {
    expect(resolveArtifactKind("Report.TSX")).toBe("module");
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
    expect(toolMix?.kind).toBe("module");
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
});

describe("stripHostProvidedImports", () => {
  it("removes react imports the host satisfies through globals", () => {
    const stripped = stripHostProvidedImports(
      ['import React from "react";', 'import { createRoot } from "react-dom/client";', "const a = 1;"].join("\n"),
    );
    expect(stripped).not.toMatch(/from "react/u);
    expect(stripped).toContain("const a = 1;");
  });

  it("keeps unrelated imports so the browser still resolves them", () => {
    const source = 'import { z } from "./local.js";\n';
    expect(stripHostProvidedImports(source)).toBe(source);
  });
});

describe("compileArtifactSource", () => {
  it("lowers JSX to the injected React global and emits an ES module", () => {
    const compiled = compileArtifactSource(
      'export default function A(): React.JSX.Element { return <p className="x">hi</p>; }',
      "a.tsx",
    );
    expect(compiled.code).toContain("React.createElement");
    expect(compiled.code).toContain("export");
    expect(compiled.code).not.toContain("className=");
    expect(JSON.parse(compiled.map)).toMatchObject({ version: 3 });
  });

  it("strips TypeScript types without a separate type-checker", () => {
    const compiled = compileArtifactSource(
      "interface P { n: number }\nexport default function A(p: P) { return p.n; }",
      "a.tsx",
    );
    expect(compiled.code).not.toContain("interface");
  });

  it("reports a located message for invalid source", () => {
    let thrown: unknown;
    try {
      compileArtifactSource("export default () => <div>unclosed;\n", "broken.tsx");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(formatArtifactCompileError(thrown)).toMatch(/\(\d+:\d+\)/u);
  });
});

describe("compileArtifactModule", () => {
  it("compiles a fixture artifact from disk", async () => {
    resetArtifactModuleCache();
    const compiled = await compileArtifactModule(join(fixtures, "tool-mix.tsx"));
    expect(compiled.code).toContain("React.createElement");
    // The map URL belongs to the serving route, so the compiled code must not
    // point at a sibling filename no route answers for.
    expect(compiled.code).not.toContain("sourceMappingURL");
    expect(JSON.parse(compiled.map)).toMatchObject({ version: 3 });
  });

  it("reuses the cached result while mtime and size are unchanged", async () => {
    resetArtifactModuleCache();
    const path = join(fixtures, "tool-mix.tsx");
    await compileArtifactModule(path);
    await compileArtifactModule(path);
    expect(artifactCompileCount()).toBe(1);
  });

  it("recompiles after the source mtime moves", async () => {
    resetArtifactModuleCache();
    const directory = await mkdtemp(join(tmpdir(), "artifact-compile-"));
    const path = join(directory, "a.tsx");
    await writeFile(path, "export default () => <p>one</p>;\n", "utf8");
    const first = await compileArtifactModule(path);
    await writeFile(path, "export default () => <p>two</p>;\n", "utf8");
    const future = new Date(Date.now() + 2_000);
    await utimes(path, future, future);
    const second = await compileArtifactModule(path);
    expect(artifactCompileCount()).toBe(2);
    expect(second.code).not.toBe(first.code);
  });
});
