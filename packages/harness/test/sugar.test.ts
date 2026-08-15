import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessIrBundleSchema, type HarnessIrBundle } from "../src/ir/index.js";
import { resolveComposition } from "../src/resolver/resolve.js";

const MINIMAL_URL = new URL("../examples/minimal.harness", import.meta.url);

async function compile(source: string): Promise<HarnessIrBundle> {
  const result = await compileHarness(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.bundle!;
}

describe("progressive-disclosure sugar", () => {
  it("resolves a minimal file: a bare require with no plugin or binding", async () => {
    const bundle = await compile(await readFile(MINIMAL_URL, "utf8"));
    expect(Value.Check(HarnessIrBundleSchema, bundle)).toBe(true);

    const { revision, report } = resolveComposition(bundle, "my-agent");
    expect(report.status).toBe("resolved");
    expect(revision!.resolved.components.map((component) => component.id)).toEqual([
      "require-tests",
    ]);
    expect(report.realizations).toEqual([
      expect.objectContaining({
        componentId: "require-tests",
        declaredStrength: "advisory",
        realized: "advisory",
        materializedMechanism: "prompt-preamble",
        action: "satisfied",
      }),
    ]);
  });

  it("a bare require defaults to minimum advisory with on-degrade report", async () => {
    const bundle = await compile(`
      component gate { kind policy }
      composition run { target pi require gate }
    `);
    expect(bundle.compositions[0].requirements).toEqual([
      { componentId: "gate", minimum: "advisory", onDegrade: "report" },
    ]);
  });

  it("expands a for [a, b] binding into one binding per host", async () => {
    const bundle = await compile(`
      component gate { kind policy }
      binding gate for [pi, qoder] { mechanism completion-hook strength enforced }
    `);
    expect(bundle.bindings).toEqual([
      expect.objectContaining({ host: "pi", mechanism: "completion-hook", strength: "enforced" }),
      expect.objectContaining({ host: "qoder", mechanism: "completion-hook", strength: "enforced" }),
    ]);
  });

  it("defaults an omitted binding mechanism and strength to advisory prompt guidance", async () => {
    const bundle = await compile(`
      component gate { kind policy }
      binding gate for pi {}
    `);
    expect(bundle.bindings[0]).toMatchObject({
      host: "pi",
      mechanism: "prompt-preamble",
      strength: "advisory",
    });
  });

  it("inherits target, includes, requirements, and settings through extends", async () => {
    const bundle = await compile(`
      component gate { kind policy }
      binding gate for [pi, qoder] { strength advisory }
      plugin p { version "1.0.0" provides [ component.gate ] }
      composition base {
        target pi
        include [ plugin.p@1 ]
        require gate { minimum advisory }
        configure { shell.timeout = 30s }
      }
      composition derived extends base {
        target qoder
      }
    `);
    const derived = bundle.compositions.find((composition) => composition.id === "derived")!;
    expect(derived.target).toBe("qoder");
    expect(derived.includes).toEqual([{ pluginId: "p", range: "1" }]);
    expect(derived.requirements).toEqual([
      { componentId: "gate", minimum: "advisory", onDegrade: "report" },
    ]);
    expect(derived.settings).toEqual([
      { key: "shell.timeout", value: { type: "duration", value: "30s", ms: 30_000 } },
    ]);
    expect(resolveComposition(bundle, "derived").report.status).toBe("resolved");
  });

  it("lets a derived composition override an inherited setting by key", async () => {
    const bundle = await compile(`
      component gate { kind policy }
      composition base { target pi require gate configure { shell.timeout = 30s } }
      composition derived extends base { configure { shell.timeout = 90s } }
    `);
    const derived = bundle.compositions.find((composition) => composition.id === "derived")!;
    expect(derived.settings).toEqual([
      { key: "shell.timeout", value: { type: "duration", value: "90s", ms: 90_000 } },
    ]);
  });

  it("fails compilation when a composition has neither target nor an extends target", async () => {
    const result = await compileHarness(`
      component gate { kind policy }
      composition run { require gate }
    `);
    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("has no target"),
      }),
    );
  });

  it("fails compilation on a circular extends chain", async () => {
    const result = await compileHarness(`
      composition a extends b { target pi }
      composition b extends a { target qoder }
    `);
    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("circular 'extends'"))).toBe(true);
  });

  it("still reports duplicate hosts within a single multi-host binding", async () => {
    const result = await compileHarness(`
      component gate { kind policy }
      binding gate for [pi, pi] { strength advisory }
    `);
    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("Duplicate component/host binding"))).toBe(
      true,
    );
  });
});
