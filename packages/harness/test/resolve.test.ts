import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessRevisionSchema, ResolutionReportSchema, type HarnessIrBundle } from "../src/ir/index.js";
import { describeAdapter } from "../src/resolver/adapter-descriptor.js";
import { resolveHarness } from "../src/resolver/resolve.js";

const EXAMPLE_URL = new URL("../examples/standard-coding.harness", import.meta.url);

/**
 * A stand-in adapter that really exposes the workspace/process tools the
 * examples require. Tool exposure is an adapter fact, so a resolution that
 * needs tools has to name the adapter that provides them.
 */
const TOOL_EXPOSING_ADAPTER = describeAdapter({
  adapterId: "@harness/adapter-qoder",
  toolExposure: {
    "workspace.read": "read_file",
    "workspace.write": "write_file",
    "process.exec": "shell",
    "fetcher.run": "fetch",
  },
});

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
    const { revision, report } = resolveHarness(bundle, "standard-coding", "qoder", {
      adapter: TOOL_EXPOSING_ADAPTER,
    });

    expect(report.status).toBe("resolved");
    expect(Value.Check(ResolutionReportSchema, report)).toBe(true);
    expect(revision).toBeDefined();
    expect(Value.Check(HarnessRevisionSchema, revision)).toBe(true);
    expect(revision!.target).toMatchObject({
      runtime: "qoder",
      adapter: "@harness/adapter-qoder",
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
          agentId: "author",
          capabilityId: "workspace.write",
          realized: "wired",
          materializedMechanism: "host-tool:write_file",
          action: "satisfied",
        }),
        expect.objectContaining({
          agentId: "verifier",
          capabilityId: "verification-before-complete",
          declaredStrength: "advisory",
          declaredMechanism: "prompt-preamble",
          realized: "advisory",
          materializedMechanism: "prompt-preamble",
          action: "degraded",
        }),
      ]),
    );
  });

  it("records a multi-agent workflow on a single-session adapter as a degradation", async () => {
    const bundle = await compileExample();
    const { revision, report } = resolveHarness(bundle, "standard-coding", "qoder", {
      adapter: TOOL_EXPOSING_ADAPTER,
    });

    expect(revision).toBeDefined();
    expect(report.warnings).toEqual([
      expect.stringContaining("single-session-prompt-roles"),
    ]);
    expect(report.warnings[0]).toContain("no per-agent session, handoff, or outcome event");
  });

  it("fails a tool requirement that only prompt guidance would satisfy", async () => {
    const bundle = await compileExample();
    const { revision, report } = resolveHarness(bundle, "standard-coding", "qoder");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors.join("\n")).toContain("exposes no host tool for 'workspace.read'");
    expect(report.errors.join("\n")).toContain("cannot be satisfied by prompt guidance");
    expect(report.realizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "workspace.read",
          realized: "unsupported",
          materializedMechanism: null,
          action: "failed",
        }),
      ]),
    );
  });

  it("fails an MCP requirement because no shipped adapter connects one", async () => {
    const bundle = await compileSource(`
      mcp registry { transport http url env.REGISTRY_MCP }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder { connect mcp registry }
      }
      target qoder
    `);
    const { revision, report } = resolveHarness(bundle, "run");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors.join("\n")).toContain("opens no MCP connection");
  });

  it("is deterministic: the same bundle resolves to the same revision id", async () => {
    const first = resolveHarness(await compileExample(), "standard-coding", "qoder", {
      adapter: TOOL_EXPOSING_ADAPTER,
    });
    const second = resolveHarness(await compileExample(), "standard-coding", "qoder", {
      adapter: TOOL_EXPOSING_ADAPTER,
    });

    expect(first.revision!.revisionId).toBe(second.revision!.revisionId);
    expect(first.revision!.revisionId).toMatch(/^hr_[0-9a-f]{32}$/);
  });

  it("requires an explicit runtime when several targets are deployable", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify first." }
      workflow solo { stop when coder.done }
      harness run { workflow solo agent coder { use skill gate } }
      target pi
      target qoder
    `);
    const { revision, report } = resolveHarness(bundle, "run");

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
      declaredMechanism: "prompt-preamble",
      materializedMechanism: "prompt-preamble",
      action: "degraded",
    });
    expect(revision!.realization[0].reason).toBeDefined();
  });

  it("always fails when the realized strength is below minimum", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify before completing." }
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

  it("does not treat a requirement floor as materialized enforcement", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify before completing." }
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
      declaredStrength: "advisory",
      declaredMechanism: "prompt-preamble",
      realized: "advisory",
      materializedMechanism: "prompt-preamble",
      action: "failed",
    });
  });

  it("fails a required capability whose binding declares it unsupported", async () => {
    const bundle = await compileSource(`
      skill gate { description "Verify before completing." }
      binding gate for qoder { unsupported }
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
      target qoder
    `);
    const { revision, report } = resolveHarness(bundle, "run", undefined, {
      adapter: TOOL_EXPOSING_ADAPTER,
    });

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("programmatic (python)");
    expect(report.errors[0]).toContain("descriptor");
  });

  it("rejects a programmatic workflow whose language differs from the runtime's", async () => {
    const bundle = await compileSource(`
      workflow scripted { program deno "./flows/loop.ts" }
      runtime prime {
        adapter "@harness/adapter-prime"
      }
      harness run {
        workflow scripted
        agent driver { require tool process.exec }
      }
      target prime
    `);
    const { revision, report } = resolveHarness(bundle, "run", undefined, {
      adapter: describeAdapter({
        adapterId: "@harness/adapter-prime",
        toolExposure: { "process.exec": "shell" },
        workflowModes: ["declarative", "programmatic"],
        programmaticLanguages: ["python"],
      }),
    });

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("does not list programmatic language 'deno'");
  });

  it("fails a programmatic workflow that no adapter can execute, instead of resolving into a no-op", async () => {
    const bundle = await compileSource(`
      workflow scripted { program deno "./flows/loop.ts" }
      runtime prime {
        adapter "@harness/adapter-prime"
      }
      harness run {
        workflow scripted
        agent driver { require tool process.exec }
      }
      target prime
    `);
    const { revision, report } = resolveHarness(bundle, "run", undefined, {
      // Declarative-only adapter: the runtime claims programmatic execution, but
      // nothing in this deployment can read or run './flows/loop.ts'.
      adapter: describeAdapter({
        adapterId: "@harness/adapter-prime",
        toolExposure: { "process.exec": "shell" },
      }),
    });

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors.join("\n")).toContain("does not list programmatic language 'deno'");
  });

  it("resolves a programmatic workflow on a runtime and adapter that can drive it", async () => {
    const bundle = await compileSource(`
      workflow scripted { program python "./flows/loop.py" }
      runtime prime {
        adapter "@harness/adapter-prime"
      }
      harness run {
        workflow scripted
        agent driver { require tool process.exec }
      }
      target prime
    `);
    const { revision, report } = resolveHarness(bundle, "run", undefined, {
      adapter: describeAdapter({
        adapterId: "@harness/adapter-prime",
        toolExposure: { "process.exec": "shell" },
        workflowModes: ["declarative", "programmatic"],
        programmaticLanguages: ["python"],
      }),
    });

    expect(report.status).toBe("resolved");
    expect(revision!.target.execution).toEqual({ style: "tool-calling" });
    expect(revision!.workflow.mode).toBe("programmatic");
  });

  it("merges requested permissions monotonically and derives MCP transport grants", async () => {
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
    const { revision } = resolveHarness(bundle, "run", undefined, {
      adapter: describeAdapter({
        adapterId: "@harness/adapter-pi",
        toolExposure: { "fetcher.run": "fetch" },
        mcpSupport: { mechanism: "mcp-client", strength: "wired" },
      }),
    });

    expect(revision!.requestedPermissions).toEqual([
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

  it("refuses to measure a runtime against another adapter's realization facts", async () => {
    const bundle = await compileSource(`
      skill s { description "x" }
      workflow single { stop when coder.done }
      harness h {
        workflow single
        agent coder {
          use skill s
          require tool workspace.write
        }
      }
      runtime qoder { adapter "@acme/totally-different-adapter" }
      target qoder
    `);

    const { revision, report } = resolveHarness(bundle, "h", "qoder", {
      adapter: TOOL_EXPOSING_ADAPTER,
    });

    // Without this the revision would name '@acme/...' while every realization
    // in it came from the Qoder descriptor — an artifact that contradicts itself.
    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toContain("@acme/totally-different-adapter");
    expect(report.errors[0]).toContain("@harness/adapter-qoder");
  });

  it("leaves the caller's bundle and report mutable when it freezes a revision", async () => {
    const bundle = await compileSource(`
      skill s { description "x" }
      workflow single { stop when coder.done }
      harness h {
        workflow single
        agent coder { use skill s }
        configure { shell.timeout = 60s }
      }
      target qoder
    `);

    const { revision, report } = resolveHarness(bundle, "h", "qoder", {
      adapter: TOOL_EXPOSING_ADAPTER,
    });

    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(bundle.harnesses[0].settings)).toBe(false);
    expect(Object.isFrozen(report.realizations)).toBe(false);
    expect(revision!.settings).not.toBe(bundle.harnesses[0].settings);
    expect(revision!.realization).not.toBe(report.realizations);
  });
});
