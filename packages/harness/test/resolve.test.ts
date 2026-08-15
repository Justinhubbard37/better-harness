import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessRevisionSchema, ResolutionReportSchema, type HarnessIrBundle } from "../src/ir/index.js";
import { resolveHarness } from "../src/resolver/resolve.js";

const EXAMPLE_URL = new URL("../examples/standard-coding.harness", import.meta.url);

async function compileExample(): Promise<HarnessIrBundle> {
  const source = await readFile(EXAMPLE_URL, "utf8");
  const { bundle } = await compileHarness(source);
  return bundle!;
}

async function compileSource(source: string): Promise<HarnessIrBundle> {
  const result = await compileHarness(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.bundle!;
}

describe("resolveHarness", () => {
  it("produces a schema-valid revision and reports declared versus materialized strength", async () => {
    const bundle = await compileExample();
    const { revision, report } = resolveHarness(bundle, "standard-coding", "pi");

    expect(report.status).toBe("resolved");
    expect(Value.Check(ResolutionReportSchema, report)).toBe(true);
    expect(revision).toBeDefined();
    expect(Value.Check(HarnessRevisionSchema, revision)).toBe(true);
    expect(revision!.target).toEqual({
      runtime: "pi",
      adapter: "@harness/adapter-pi",
      execution: { style: "tool-calling" },
    });
    expect(revision!.workflow).toMatchObject({ id: "coding-loop", mode: "declarative" });
    expect(revision!.agents).toEqual([
      { id: "author", capabilities: ["impact-analysis", "workspace.read", "workspace.write"] },
      { id: "verifier", capabilities: ["process.exec", "verification-before-complete"] },
    ]);
    expect(revision!.resolved.capabilities.map((capability) => `${capability.kind}:${capability.id}`)).toEqual([
      "skill:impact-analysis",
      "tool:process.exec",
      "skill:verification-before-complete",
      "tool:workspace.read",
      "tool:workspace.write",
    ]);
    expect(report.realizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "author",
          capabilityId: "impact-analysis",
          declaredStrength: "advisory",
          realized: "advisory",
          materializedMechanism: "prompt-preamble",
          action: "satisfied",
        }),
        expect.objectContaining({
          agentId: "verifier",
          capabilityId: "verification-before-complete",
          declaredStrength: "enforced",
          declaredMechanism: "pi.extension",
          realized: "advisory",
          materializedMechanism: "prompt-preamble",
          action: "degraded",
        }),
      ]),
    );
  });

  it("is deterministic: the same bundle resolves to the same revision id", async () => {
    const first = resolveHarness(await compileExample(), "standard-coding", "pi");
    const second = resolveHarness(await compileExample(), "standard-coding", "pi");

    expect(first.revision!.revisionId).toBe(second.revision!.revisionId);
    expect(first.revision!.revisionId).toMatch(/^hr_[0-9a-f]{32}$/);
  });

  it("requires an explicit runtime when several targets are deployable", async () => {
    const bundle = await compileExample();
    const { revision, report } = resolveHarness(bundle, "standard-coding");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("Multiple runtimes are available");
  });

  it("fails for a runtime that is neither declared nor targeted", async () => {
    const bundle = await compileExample();
    const { report } = resolveHarness(bundle, "standard-coding", "prime");

    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("'prime' is neither declared as a runtime nor listed as a target");
  });

  const degradedSource = (onDegrade: string) => `
    skill gate {
      description "Verify before completing."
    }
    binding gate for codex {
      mechanism system-instruction
      strength advisory
    }
    workflow solo { stop when coder.done }
    harness run-on-codex {
      workflow solo
      agent coder {
        use skill gate {
          preferred enforced
          minimum advisory
          on-degrade ${onDegrade}
        }
      }
    }
    target codex
  `;

  it("fails resolution when a degradation below preferred hits 'on-degrade fail'", async () => {
    const bundle = await compileSource(degradedSource("fail"));
    const { revision, report } = resolveHarness(bundle, "run-on-codex");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.realizations[0]).toMatchObject({
      agentId: "coder",
      capabilityId: "gate",
      requestedPreferred: "enforced",
      declaredStrength: "advisory",
      realized: "advisory",
      action: "failed",
    });
  });

  it("records the degradation and still resolves under 'on-degrade report'", async () => {
    const bundle = await compileSource(degradedSource("report"));
    const { revision, report } = resolveHarness(bundle, "run-on-codex");

    expect(report.status).toBe("resolved");
    expect(revision).toBeDefined();
    expect(revision!.realization[0]).toMatchObject({
      requestedPreferred: "enforced",
      declaredStrength: "advisory",
      realized: "advisory",
      declaredMechanism: "system-instruction",
      materializedMechanism: "prompt-preamble",
      action: "degraded",
    });
    expect(revision!.realization[0].reason).toBeDefined();
  });

  it("always fails when the realized strength is below minimum", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify before completing." }
      binding gate for codex { mechanism system-instruction strength advisory }
      workflow solo { stop when coder.done }
      harness strict {
        workflow solo
        agent coder {
          use skill gate {
            minimum wired
            on-degrade report
          }
        }
      }
      target codex
    `);
    const { revision, report } = resolveHarness(bundle, "strict");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
  });

  it("does not treat a declared enforced binding as materialized enforcement", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify before completing." }
      binding gate for pi { mechanism pi.extension strength enforced }
      workflow solo { stop when coder.done }
      harness strict {
        workflow solo
        agent coder {
          use skill gate { minimum enforced }
        }
      }
      target pi
    `);

    const { revision, report } = resolveHarness(bundle, "strict");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.realizations[0]).toMatchObject({
      declaredStrength: "enforced",
      declaredMechanism: "pi.extension",
      realized: "advisory",
      materializedMechanism: "prompt-preamble",
      action: "failed",
    });
  });

  it("fails a required capability whose binding declares it unsupported", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify before completing." }
      binding gate for qoder { mechanism unavailable strength unsupported }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder { use skill gate }
      }
      target qoder
    `);
    const { revision, report } = resolveHarness(bundle, "run");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.realizations[0]).toMatchObject({
      declaredStrength: "unsupported",
      realized: "unsupported",
      action: "failed",
    });
  });

  it("rejects deploying a programmatic workflow onto a tool-calling runtime", async () => {
    const bundle = await compileSource(`
      workflow scripted { program python "./flows/loop.py" }
      harness run {
        workflow scripted
        agent driver { require tool process.exec }
      }
      target pi
    `);
    const { revision, report } = resolveHarness(bundle, "run");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("programmatic (python)");
    expect(report.errors[0]).toContain("ACP");
  });

  it("rejects a programmatic workflow whose language differs from the runtime's", async () => {
    const bundle = await compileSource(`
      workflow scripted { program deno "./flows/loop.ts" }
      runtime prime {
        adapter "@harness/adapter-prime"
        execution programmatic.python { repl persistent }
      }
      harness run {
        workflow scripted
        agent driver { require tool process.exec }
      }
      target prime
    `);
    const { revision, report } = resolveHarness(bundle, "run");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("executes programmatic.python");
  });

  it("resolves a programmatic workflow on a runtime with matching programmatic execution", async () => {
    const bundle = await compileSource(`
      workflow scripted { program python "./flows/loop.py" }
      runtime prime {
        adapter "@harness/adapter-prime"
        execution programmatic.python { repl persistent }
      }
      harness run {
        workflow scripted
        agent driver { require tool process.exec }
      }
      target prime
    `);
    const { revision, report } = resolveHarness(bundle, "run");

    expect(report.status).toBe("resolved");
    expect(revision!.target.execution).toEqual({
      style: "programmatic",
      language: "python",
      options: [{ key: "repl", value: "persistent" }],
    });
    expect(revision!.workflow.mode).toBe("programmatic");
  });

  it("merges permissions monotonically and derives MCP transport grants", async () => {
    const bundle = await compileSource(`
      skill fetch-policy {
        description "Fetch only from the registry."
        permissions { network deny workspace read }
      }
      tool fetcher.run {
        permissions { network allow }
      }
      mcp registry { transport http url env.REGISTRY_MCP }
      mcp indexer { transport stdio command "indexer --stdio" }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder {
          use skill fetch-policy
          require tool fetcher.run
          connect mcp registry
          connect mcp indexer
        }
      }
      target pi
    `);
    const { revision } = resolveHarness(bundle, "run");

    expect(revision!.permissions).toEqual([
      { domain: "network", access: "deny" },
      { domain: "process", access: "allow" },
      { domain: "workspace", access: "read" },
    ]);
  });

  it("fails with a clear error for an unknown harness", async () => {
    const bundle = await compileExample();
    const { report } = resolveHarness(bundle, "missing", "pi");

    expect(report.status).toBe("failed");
    expect(report.errors).toEqual(["Harness 'missing' is not defined in the bundle."]);
  });
});
