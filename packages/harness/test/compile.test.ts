import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessIrBundleSchema, IR_VERSION } from "../src/ir/index.js";

const EXAMPLE_URL = new URL("../examples/standard-coding.harness", import.meta.url);

describe("compileHarness", () => {
  it("lowers the example document into a schema-valid IR bundle", async () => {
    const source = await readFile(EXAMPLE_URL, "utf8");
    const result = await compileHarness(source);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.bundle).toBeDefined();
    const bundle = result.bundle!;
    expect(Value.Check(HarnessIrBundleSchema, bundle)).toBe(true);
    expect(bundle.irVersion).toBe(IR_VERSION);
    expect(bundle.components.map((component) => component.id)).toEqual([
      "impact-analysis",
      "verification-before-complete",
    ]);
    expect(bundle.compositions.map((composition) => composition.id)).toEqual([
      "standard-coding",
      "standard-coding-qoder",
    ]);
  });

  it("joins declared bindings into the plugin manifest of provided components", async () => {
    const source = await readFile(EXAMPLE_URL, "utf8");
    const { bundle } = await compileHarness(source);

    const plugin = bundle!.plugins.find((candidate) => candidate.id === "change-verification")!;
    expect(plugin.provides).toEqual(["verification-before-complete"]);
    expect(plugin.bindings).toEqual([
      expect.objectContaining({ host: "pi", mechanism: "extension-event", strength: "enforced" }),
      expect.objectContaining({ host: "qoder", mechanism: "system-instruction", strength: "advisory" }),
    ]);
  });

  it("normalizes version ranges and duration settings", async () => {
    const source = await readFile(EXAMPLE_URL, "utf8");
    const { bundle } = await compileHarness(source);

    const composition = bundle!.compositions.find((candidate) => candidate.id === "standard-coding")!;
    expect(composition.includes).toEqual([
      { pluginId: "repository-understanding", range: "^1" },
      { pluginId: "change-verification", range: "^2" },
    ]);
    expect(composition.settings).toEqual([
      { key: "shell.timeout", value: { type: "duration", value: "60s", ms: 60_000 } },
      { key: "tool-call-budget", value: { type: "int", value: 80 } },
    ]);
  });

  it("resolves cross-file references across multiple sources", async () => {
    const contracts = `
      component impact-analysis {
        kind skill
      }
    `;
    const assembly = `
      binding impact-analysis for qoder {
        mechanism skill-routing
        strength advisory
      }
      plugin repo-tools {
        version "1.0.0"
        provides [ component.impact-analysis ]
      }
    `;
    const result = await compileHarness([{ text: contracts }, { text: assembly }]);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.bundle!.plugins[0].bindings).toEqual([
      expect.objectContaining({ componentId: "impact-analysis", host: "qoder" }),
    ]);
  });

  it("fails compilation when preferred strength is below minimum", async () => {
    const source = `
      component gate { kind policy }
      binding gate for pi { mechanism completion-hook strength enforced }
      plugin p { version "1.0.0" provides [ component.gate ] }
      composition c {
        target pi
        include [ plugin.p@1 ]
        require gate {
          preferred advisory
          minimum enforced
        }
      }
    `;
    const result = await compileHarness(source);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("fails compilation on unresolved component references", async () => {
    const result = await compileHarness(`
      binding does-not-exist for pi {
        mechanism completion-hook
        strength advisory
      }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("fails compilation on duplicate bindings for the same component and host", async () => {
    const result = await compileHarness(`
      component gate { kind policy }
      binding gate for pi { mechanism completion-hook strength advisory }
      binding gate for pi { mechanism other strength enforced }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("fails compilation on duplicate bindings split across source files", async () => {
    const result = await compileHarness([
      {
        uri: "memory://harness/first.harness",
        text: `
          component gate { kind policy }
          binding gate for pi { mechanism prompt strength advisory }
        `,
      },
      {
        uri: "memory://harness/second.harness",
        text: "binding gate for pi { mechanism extension-event strength enforced }",
      },
    ]);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        source: "memory://harness/second.harness",
        message: expect.stringContaining("Duplicate component/host binding 'gate::pi'"),
      }),
    );
  });

  it("rejects duplicate globally named declarations and repeated composition members", async () => {
    const result = await compileHarness(`
      component gate { kind policy }
      component gate { kind skill }
      plugin p { version "1.0.0" provides [ component.gate, component.gate ] }
      composition run {
        target pi
        include [ plugin.p@1, plugin.p@^1 ]
        require gate { minimum advisory }
        require gate { minimum advisory }
        configure { shell.timeout = 1s shell.timeout = 2s }
      }
      composition run { target pi include [ plugin.p@1 ] }
    `);

    expect(result.bundle).toBeUndefined();
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Duplicate component 'gate'"),
        expect.stringContaining("Duplicate provided component 'gate'"),
        expect.stringContaining("Duplicate included plugin 'p'"),
        expect.stringContaining("Duplicate composition requirement 'gate'"),
        expect.stringContaining("Duplicate configuration key 'shell.timeout'"),
        expect.stringContaining("Duplicate composition 'run'"),
      ]),
    );
  });

  it("rejects invalid exact plugin versions before resolution", async () => {
    const result = await compileHarness(`
      component gate { kind policy }
      plugin verification { version "not-semver" provides [ component.gate ] }
      composition run { target pi include [ plugin.verification@1 ] }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "Plugin 'verification' declares invalid semantic version 'not-semver'.",
      }),
    );
  });

  it("rejects repeated component inputs and outputs", async () => {
    const result = await compileHarness(`
      component analyzer {
        kind skill
        input { source source }
        output { result result }
      }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        "Duplicate component input 'source'.",
        "Duplicate component output 'result'.",
      ]),
    );
  });
});
