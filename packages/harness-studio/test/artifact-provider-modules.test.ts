import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadArtifactProviderModules,
  providerModuleTarget,
} from "../src/server/artifacts/registry/artifact-provider-modules.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("Artifact Provider modules", () => {
  it("loads a relative operator-provisioned module through its canonical factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-provider-module-"));
    temporary.push(root);
    await mkdir(join(root, "providers"));
    await writeFile(join(root, "providers", "fixture.mjs"), `
export async function createArtifactProvider() {
  return { id: "fixture.module", version: "1.0.0", label: "Fixture", contributions: [] };
}
`, "utf8");
    const providers = await loadArtifactProviderModules(["./providers/fixture.mjs"], root);
    expect(providers).toEqual([expect.objectContaining({ id: "fixture.module", version: "1.0.0" })]);
    expect(Object.isFrozen(providers)).toBe(true);
  });

  it("accepts bounded package names and rejects implicit URL, builtin, duplicate, and over-budget loading", async () => {
    expect(providerModuleTarget("@homology/integration-harness-notebook-provider", "/workspace")).toBe(
      "@homology/integration-harness-notebook-provider",
    );
    expect(() => providerModuleTarget("node:fs", "/workspace")).toThrow("package name or filesystem path");
    expect(() => providerModuleTarget("https://example.com/provider.mjs", "/workspace")).toThrow("package name or filesystem path");
    const root = await mkdtemp(join(tmpdir(), "artifact-provider-duplicate-"));
    temporary.push(root);
    await writeFile(join(root, "fixture.mjs"), "export const createArtifactProvider = () => ({});", "utf8");
    await expect(loadArtifactProviderModules(["./fixture.mjs", "./fixture.mjs"], root)).rejects.toThrow("more than once");
    await expect(loadArtifactProviderModules(Array.from({ length: 17 }, (_, index) => `provider-${index}`), root)).rejects.toThrow("At most 16");
  });

  it("fails closed when the canonical factory is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-provider-missing-factory-"));
    temporary.push(root);
    await writeFile(join(root, "fixture.mjs"), "export const value = 1;", "utf8");
    await expect(loadArtifactProviderModules(["./fixture.mjs"], root)).rejects.toThrow("createArtifactProvider");
  });
});
