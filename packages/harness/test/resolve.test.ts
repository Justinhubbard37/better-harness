import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessRevisionSchema, ResolutionReportSchema, type HarnessIrBundle } from "../src/ir/index.js";
import { resolveComposition } from "../src/resolver/resolve.js";

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

describe("resolveComposition", () => {
  it("produces a schema-valid revision and reports declared versus materialized strength", async () => {
    const bundle = await compileExample();
    const { revision, report } = resolveComposition(bundle, "standard-coding");

    expect(report.status).toBe("resolved");
    expect(Value.Check(ResolutionReportSchema, report)).toBe(true);
    expect(revision).toBeDefined();
    expect(Value.Check(HarnessRevisionSchema, revision)).toBe(true);
    expect(revision!.target.host).toBe("pi");
    expect(revision!.resolved.plugins.map((plugin) => `${plugin.id}@${plugin.version}`)).toEqual([
      "change-verification@2.1.3",
      "repository-understanding@1.4.2",
    ]);
    expect(report.realizations).toEqual([
      expect.objectContaining({
        componentId: "impact-analysis",
        declaredStrength: "advisory",
        realized: "advisory",
        materializedMechanism: "prompt-preamble",
        action: "satisfied",
        reason: "implicitly enabled by an included plugin",
      }),
      expect.objectContaining({
        componentId: "verification-before-complete",
        declaredStrength: "enforced",
        declaredMechanism: "extension-event",
        realized: "advisory",
        materializedMechanism: "prompt-preamble",
        action: "degraded",
      }),
    ]);
  });

  it("is deterministic: the same bundle resolves to the same revision id", async () => {
    const first = resolveComposition(await compileExample(), "standard-coding");
    const second = resolveComposition(await compileExample(), "standard-coding");

    expect(first.revision!.revisionId).toBe(second.revision!.revisionId);
    expect(first.revision!.revisionId).toMatch(/^hr_[0-9a-f]{32}$/);
  });

  const degradedSource = (onDegrade: string) => `
    component gate {
      kind policy
      description "Verify before completing."
    }
    binding gate for codex {
      mechanism system-instruction
      strength advisory
    }
    plugin verification {
      version "2.0.0"
      provides [ component.gate ]
    }
    composition run-on-codex {
      target codex
      include [ plugin.verification@^2 ]
      require gate {
        preferred enforced
        minimum advisory
        on-degrade ${onDegrade}
      }
    }
  `;

  it("fails resolution when a degradation below preferred hits 'on-degrade fail'", async () => {
    const bundle = await compileSource(degradedSource("fail"));
    const { revision, report } = resolveComposition(bundle, "run-on-codex");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.realizations[0]).toMatchObject({
      componentId: "gate",
      requestedPreferred: "enforced",
      declaredStrength: "advisory",
      realized: "advisory",
      action: "failed",
    });
  });

  it("records the degradation and still resolves under 'on-degrade report'", async () => {
    const bundle = await compileSource(degradedSource("report"));
    const { revision, report } = resolveComposition(bundle, "run-on-codex");

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
      component gate { kind policy }
      binding gate for codex { mechanism system-instruction strength advisory }
      plugin verification { version "2.0.0" provides [ component.gate ] }
      composition strict {
        target codex
        include [ plugin.verification@^2 ]
        require gate {
          minimum wired
          on-degrade report
        }
      }
    `);
    const { revision, report } = resolveComposition(bundle, "strict");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
  });

  it("does not treat a declared enforced binding as materialized enforcement", async () => {
    const bundle = await compileSource(`
      component gate { kind policy }
      binding gate for pi { mechanism completion-hook strength enforced }
      plugin verification { version "1.0.0" provides [ component.gate ] }
      composition strict {
        target pi
        include [ plugin.verification@1 ]
        require gate { minimum enforced }
      }
    `);

    const { revision, report } = resolveComposition(bundle, "strict");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.realizations[0]).toMatchObject({
      declaredStrength: "enforced",
      declaredMechanism: "completion-hook",
      realized: "advisory",
      materializedMechanism: "prompt-preamble",
      action: "failed",
    });
  });

  it("fails when no plugin version satisfies the requested range", async () => {
    const bundle = await compileSource(`
      component gate { kind policy }
      binding gate for pi { mechanism completion-hook strength enforced }
      plugin verification { version "1.0.0" provides [ component.gate ] }
      composition wants-v2 {
        target pi
        include [ plugin.verification@^2 ]
        require gate { minimum advisory }
      }
    `);
    const { revision, report } = resolveComposition(bundle, "wants-v2");

    expect(revision).toBeUndefined();
    expect(report.status).toBe("failed");
    expect(report.errors.some((error) => error.includes("verification"))).toBe(true);
  });

  it("merges permissions monotonically: an explicit deny wins over allow", async () => {
    const bundle = await compileSource(`
      component fetcher {
        kind tool
        permissions { network allow }
      }
      component gate {
        kind policy
        permissions { network deny workspace read }
      }
      binding fetcher for pi { mechanism tool-adapter strength wired }
      binding gate for pi { mechanism completion-hook strength enforced }
      plugin all { version "1.0.0" provides [ component.fetcher, component.gate ] }
      composition run {
        target pi
        include [ plugin.all@1 ]
      }
    `);
    const { revision } = resolveComposition(bundle, "run");

    expect(revision!.permissions).toEqual([
      { domain: "network", access: "deny" },
      { domain: "workspace", access: "read" },
    ]);
  });

  it("marks an implicitly enabled component without a host binding as degraded", async () => {
    const bundle = await compileSource(`
      component optional-observer { kind observer }
      plugin diagnostics { version "1.0.0" provides [ component.optional-observer ] }
      composition run { target pi include [ plugin.diagnostics@1 ] }
    `);

    const { revision, report } = resolveComposition(bundle, "run");

    expect(report.status).toBe("resolved");
    expect(revision!.realization[0]).toMatchObject({
      componentId: "optional-observer",
      declaredStrength: "unsupported",
      realized: "unsupported",
      action: "degraded",
    });
    expect(revision!.realization[0].reason).toContain("has no binding");
  });

  it("marks an implicitly enabled component with an unsupported binding as degraded", async () => {
    const bundle = await compileSource(`
      component optional-observer { kind observer }
      binding optional-observer for pi { mechanism unavailable strength unsupported }
      plugin diagnostics { version "1.0.0" provides [ component.optional-observer ] }
      composition run { target pi include [ plugin.diagnostics@1 ] }
    `);

    const { revision } = resolveComposition(bundle, "run");

    expect(revision!.realization[0]).toMatchObject({
      declaredStrength: "unsupported",
      declaredMechanism: "unavailable",
      realized: "unsupported",
      action: "degraded",
    });
    expect(revision!.realization[0].reason).toContain("declares this component unsupported");
  });
});
