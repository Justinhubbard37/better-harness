import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const VALIDATOR_PATH = fileURLToPath(
  new URL("../skills/generate-harness-dsl/scripts/validate.mjs", import.meta.url),
);
const EXAMPLE_PATH = fileURLToPath(
  new URL("../examples/standard-coding.harness", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runValidator(file: string, ...compositionIds: string[]) {
  return spawnSync(process.execPath, [VALIDATOR_PATH, file, ...compositionIds], {
    encoding: "utf8",
  });
}

describe("generate-harness-dsl validator", () => {
  it("compiles and resolves the published example through the built public API", () => {
    const result = runValidator(EXAMPLE_PATH);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.valid).toBe(true);
    expect(output.diagnostics).toEqual([]);
    expect(output.compositions).toEqual([
      expect.objectContaining({ compositionId: "standard-coding", status: "resolved" }),
      expect.objectContaining({ compositionId: "standard-coding-qoder", status: "resolved" }),
    ]);
    expect(output.compositions[0].realizations).toContainEqual(
      expect.objectContaining({
        componentId: "verification-before-complete",
        declaredStrength: "enforced",
        realized: "advisory",
        action: "degraded",
      }),
    );
  });

  it("returns structured diagnostics and a non-zero status for invalid DSL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-skill-test-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "invalid.harness");
    await writeFile(
      file,
      "composition broken { target qoder include [ plugin.missing@1 ] }",
      "utf8",
    );

    const result = runValidator(file);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.valid).toBe(false);
    expect(output.compositions).toEqual([]);
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }));
  });

  it("fails when a requested composition does not exist", () => {
    const result = runValidator(EXAMPLE_PATH, "missing-composition");

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.valid).toBe(false);
    expect(output.compositions).toEqual([
      expect.objectContaining({
        compositionId: "missing-composition",
        status: "failed",
        errors: ["Composition 'missing-composition' is not defined in the bundle."],
      }),
    ]);
  });

  it("requires generated files to declare an independently resolvable composition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-skill-test-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "library-only.harness");
    await writeFile(
      file,
      "component repository-analysis { kind skill permissions { workspace read } }",
      "utf8",
    );

    const result = runValidator(file);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.valid).toBe(false);
    expect(output.compositions).toEqual([]);
    expect(output.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "No composition is declared; generated DSL must be independently resolvable.",
      }),
    );
  });
});
