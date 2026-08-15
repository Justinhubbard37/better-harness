import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessIrBundleSchema, type HarnessIrBundle } from "../src/ir/index.js";
import { describeAdapter } from "../src/resolver/adapter-descriptor.js";
import { resolveHarness } from "../src/resolver/resolve.js";

const MINIMAL_URL = new URL("../examples/minimal.harness", import.meta.url);

async function compile(source: string): Promise<HarnessIrBundle> {
  const result = await compileHarness(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.bundle!;
}

describe("progressive-disclosure sugar", () => {
  it("resolves a minimal file: a bare use skill with no runtime or binding", async () => {
    const bundle = await compile(await readFile(MINIMAL_URL, "utf8"));
    expect(Value.Check(HarnessIrBundleSchema, bundle)).toBe(true);

    const { revision, report } = resolveHarness(bundle, "my-agent");
    expect(report.status).toBe("resolved");
    expect(revision!.resolved.capabilities.map((capability) => capability.id)).toEqual([
      "require-tests",
    ]);
    // The bare `target qoder` synthesizes a tool-calling runtime with the
    // conventional adapter package.
    expect(revision!.target).toMatchObject({
      runtime: "qoder",
      adapter: "@harness/adapter-qoder",
      execution: { style: "tool-calling" },
    });
    expect(report.realizations).toEqual([
      expect.objectContaining({
        agentId: "coder",
        capabilityId: "require-tests",
        declaredStrength: "advisory",
        realized: "advisory",
        materializedMechanism: "prompt-preamble",
        action: "satisfied",
      }),
    ]);
  });

  it("a bare requirement defaults to minimum advisory with on-degrade report", async () => {
    const bundle = await compile(`
      skill gate { description "Verify first." }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder { use skill gate }
      }
      target pi
    `);
    expect(bundle.harnesses[0].agents[0].requirements).toEqual([
      { capabilityId: "gate", capabilityKind: "skill", minimum: "advisory", onDegrade: "report" },
    ]);
  });

  it("synthesizes an implicit tool contract for an undeclared require tool", async () => {
    const bundle = await compile(`
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder {
          require tool workspace.read
          require tool process.exec
        }
      }
      target pi
    `);
    expect(bundle.tools).toEqual([
      expect.objectContaining({ id: "process.exec", implicit: true, permissions: [] }),
      expect.objectContaining({ id: "workspace.read", implicit: true, permissions: [] }),
    ]);
    // An implicit contract still needs a real host tool behind it, so resolution
    // only succeeds against an adapter that exposes one.
    const exposing = describeAdapter({
      adapterId: "@harness/adapter-pi",
      toolExposure: { "workspace.read": "read_file", "process.exec": "shell" },
    });
    expect(resolveHarness(bundle, "run", undefined, { adapter: exposing }).report.status).toBe("resolved");
    expect(resolveHarness(bundle, "run").report.status).toBe("failed");
  });

  it("expands a for [a, b] binding into one binding per runtime", async () => {
    const bundle = await compile(`
      skill gate { description "Verify first." }
      binding gate for [pi, qoder] { mechanism pi.extension strength enforced }
    `);
    expect(bundle.bindings).toEqual([
      expect.objectContaining({ runtime: "pi", mechanism: "pi.extension", strength: "enforced" }),
      expect.objectContaining({ runtime: "qoder", mechanism: "pi.extension", strength: "enforced" }),
    ]);
  });

  it("defaults an omitted binding mechanism and strength to advisory prompt guidance", async () => {
    const bundle = await compile(`
      skill gate { description "Verify first." }
      binding gate for pi {}
    `);
    expect(bundle.bindings[0]).toMatchObject({
      runtime: "pi",
      mechanism: "prompt-preamble",
      strength: "advisory",
    });
  });

  it("uses the target's adapter shorthand when synthesizing a runtime", async () => {
    const bundle = await compile(`
      skill gate { description "Verify first." }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder { use skill gate }
      }
      target custom-host uses adapter.custom
    `);
    const { revision } = resolveHarness(bundle, "run");
    expect(revision!.target.adapter).toBe("@harness/adapter-custom");
  });

  it("prefers a declared runtime over synthesis for the same target", async () => {
    const bundle = await compile(`
      skill gate { description "Verify first." }
      workflow solo { stop when coder.done }
      runtime prime {
        adapter "@harness/adapter-prime"
        execution programmatic.python { repl persistent }
      }
      harness run {
        workflow solo
        agent coder { use skill gate }
      }
      target prime
    `);
    const { revision } = resolveHarness(bundle, "run");
    expect(revision!.target).toMatchObject({
      runtime: "prime",
      adapter: "@harness/adapter-prime",
      execution: { style: "programmatic", language: "python", options: [{ key: "repl", value: "persistent" }] },
    });
  });

  it("still reports duplicate runtimes within a single multi-runtime binding", async () => {
    const result = await compileHarness(`
      skill gate { description "Verify first." }
      binding gate for [pi, pi] { strength advisory }
    `);
    expect(result.bundle).toBeUndefined();
    expect(
      result.diagnostics.some((d) => d.message.includes("Duplicate capability/runtime binding")),
    ).toBe(true);
  });
});
