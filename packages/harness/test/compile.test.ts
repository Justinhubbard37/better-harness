import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import { HarnessIrBundleSchema, IR_VERSION } from "../src/ir/index.js";
import { describeAdapter } from "../src/resolver/adapter-descriptor.js";
import { resolveHarness } from "../src/resolver/resolve.js";

const EXAMPLE_URL = new URL("../examples/standard-coding.harness", import.meta.url);
const FULL_SURFACE_URL = new URL("../examples/full-surface.harness", import.meta.url);

describe("compileHarness", () => {
  it("compiles every authored v0.2 syntax branch into typed IR", async () => {
    const source = await readFile(FULL_SURFACE_URL, "utf8");
    const result = await compileHarness(source);

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(Value.Check(HarnessIrBundleSchema, result.bundle)).toBe(true);
    const bundle = result.bundle!;
    expect(bundle.skills.map((skill) => skill.id)).toEqual([
      "repository-grounding",
      "inline-guidance",
    ]);
    expect(bundle.skills[0].source).toBe("./skills/repository-grounding");
    expect(bundle.tools.map((tool) => `${tool.id}:${tool.implicit}`)).toEqual([
      "workspace.read:false",
      "process.exec:false",
      "workspace.write:true",
    ]);
    expect(bundle.mcps.map((mcp) => mcp.transport)).toEqual(["http", "sse", "stdio"]);
    expect(bundle.mcps[0].url).toEqual({ type: "env", variable: "PACKAGE_REGISTRY_MCP" });
    expect(bundle.mcps[1].url).toEqual({ type: "literal", value: "https://docs.example.test/mcp" });
    expect(bundle.mcps[2].command).toBe("indexer --stdio");
    expect(bundle.workflows.map((workflow) => `${workflow.id}:${workflow.mode}`)).toEqual([
      "coding-loop:declarative",
      "scripted-loop:programmatic",
    ]);
    expect(bundle.workflows[0]).toMatchObject({
      edges: [{ from: "author", to: "verifier" }],
      events: [{ agent: "verifier", outcome: "failed", to: "author" }],
      stops: [{ agent: "verifier", outcome: "passed" }],
    });
    expect(bundle.workflows[1].program).toEqual({ language: "deno", entry: "./flows/coding-loop.ts" });
    expect(bundle.runtimes.map((runtime) => runtime.execution)).toEqual([
      { style: "tool-calling" },
      { style: "tool-calling" },
      { style: "tool-calling" },
    ]);
    expect(bundle.targets).toEqual([{ runtime: "qoder", adapter: "qoder" }, { runtime: "pi" }]);
    expect(bundle.bindings).toEqual([
      expect.objectContaining({ runtime: "qoder", strength: "unsupported" }),
    ]);
    expect(bundle.harnesses[0].settings).toEqual([
      { key: "runtime.max-turns", value: { type: "int", value: 24 } },
      { key: "runtime.timeout", value: { type: "duration", value: "10m", ms: 600_000 } },
      { key: "runtime.label", value: { type: "string", value: "full-surface" } },
      { key: "runtime.checkpoints", value: { type: "boolean", value: true } },
      { key: "runtime.network-enabled", value: { type: "boolean", value: false } },
    ]);
    // Resolution needs an adapter that really provides the tools and MCP servers
    // this fixture requires; the conformance check is about lowering, not about
    // pretending a prompt line connects an MCP server.
    const capableAdapter = describeAdapter({
      adapterId: "@harness/adapter-pi",
      toolExposure: {
        "workspace.read": "read_file",
        "workspace.write": "write_file",
        "process.exec": "shell",
      },
      mcpSupport: { mechanism: "mcp-client", strength: "wired" },
    });
    const resolved = resolveHarness(result.bundle!, "full-surface", "pi", {
      adapter: capableAdapter,
      sourceLocks: [{
        capabilityId: "repository-grounding",
        uri: "./skills/repository-grounding",
        digest: `sha256:${"0".repeat(64)}`,
        files: 1,
      }],
    });
    expect(resolved.report.status).toBe("resolved");
    expect(resolved.report.realizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "author",
          capabilityId: "repository-grounding",
          realized: "advisory",
          action: "satisfied",
        }),
        expect.objectContaining({
          agentId: "verifier",
          capabilityId: "process.exec",
          realized: "wired",
          materializedMechanism: "host-tool:shell",
          action: "satisfied",
        }),
      ]),
    );
    expect(resolveHarness(result.bundle!, "full-surface", "pi").report.errors.join("\n")).toContain(
      "exposes no host tool",
    );
  });

  it("lowers the example document into a schema-valid IR bundle", async () => {
    const source = await readFile(EXAMPLE_URL, "utf8");
    const result = await compileHarness(source);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.bundle).toBeDefined();
    const bundle = result.bundle!;
    expect(Value.Check(HarnessIrBundleSchema, bundle)).toBe(true);
    expect(bundle.irVersion).toBe(IR_VERSION);
    expect(bundle.skills.map((skill) => skill.id)).toEqual([
      "impact-analysis",
      "verification-before-complete",
    ]);
    expect(bundle.harnesses.map((harness) => harness.id)).toEqual(["standard-coding"]);
    expect(bundle.harnesses[0].agents.map((agent) => agent.id)).toEqual(["author", "verifier"]);
    expect(bundle.harnesses[0].agents[0].requirements).toEqual([
      { capabilityId: "impact-analysis", capabilityKind: "skill", minimum: "advisory", onDegrade: "report" },
      { capabilityId: "workspace.read", capabilityKind: "tool", minimum: "advisory", onDegrade: "report" },
      { capabilityId: "workspace.write", capabilityKind: "tool", minimum: "advisory", onDegrade: "report" },
    ]);
    expect(bundle.harnesses[0].settings).toEqual([
      { key: "shell.timeout", value: { type: "duration", value: "60s", ms: 60_000 } },
      { key: "tool-call-budget", value: { type: "int", value: 80 } },
    ]);
    expect(bundle.targets).toEqual([{ runtime: "qoder", adapter: "qoder" }]);
  });

  it("keeps generic plugin and composition out of the authored surface", async () => {
    const result = await compileHarness(`
      plugin generic { version "1.0.0" }
    `);
    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);

    const composition = await compileHarness(`
      composition run { target qoder }
    `);
    expect(composition.bundle).toBeUndefined();
    expect(composition.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("resolves cross-file references across multiple sources", async () => {
    const capabilities = `
      skill impact-analysis {
        description "Map the blast radius."
      }
    `;
    const flow = `
      workflow solo {
        stop when coder.done
      }
    `;
    const assembly = `
      harness review {
        workflow solo
        agent coder {
          use skill impact-analysis
        }
      }
      target qoder
    `;
    const result = await compileHarness([{ text: capabilities }, { text: flow }, { text: assembly }]);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.bundle!.bindings).toEqual([]);
    expect(result.bundle!.harnesses[0].workflow).toBe("solo");
  });

  it("fails compilation when preferred strength is below minimum", async () => {
    const result = await compileHarness(`
      skill gate { description "Verify first." }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder {
          use skill gate {
            preferred advisory
            minimum enforced
          }
        }
      }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("below minimum"))).toBe(true);
  });

  it("rejects legacy binding realization facts with an adapter-owner diagnostic", async () => {
    const result = await compileHarness(`
      skill gate { description "Verify first." }
      binding gate for qoder { mechanism qoder.plugin strength wired }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      message: expect.stringContaining("belong to the adapter descriptor"),
    }));
  });

  it("ignores deprecated runtime execution claims while retaining a diagnostic", async () => {
    const result = await compileHarness(`
      runtime prime {
        adapter "@harness/adapter-prime"
        execution programmatic.python { repl persistent }
      }
    `);

    expect(result.bundle?.runtimes[0].execution).toEqual({ style: "tool-calling" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("has no effect"),
    }));
  });

  it("fails compilation when a verb does not match the declared capability kind", async () => {
    const result = await compileHarness(`
      skill gate { description "Verify first." }
      tool workspace.read {}
      mcp registry { transport http url "https://registry.test/mcp" }
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder {
          require tool gate
          use skill workspace.read
          connect mcp gate
          use skill registry
        }
      }
    `);

    expect(result.bundle).toBeUndefined();
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("'require' expects a tool, but 'gate' is declared as a skill"),
        expect.stringContaining("'use' expects a skill, but 'workspace.read' is declared as a tool"),
        expect.stringContaining("'connect' expects a mcp, but 'gate' is declared as a skill"),
        expect.stringContaining("'use' expects a skill, but 'registry' is declared as a mcp"),
      ]),
    );
  });

  it("fails compilation when skills or MCP entries are referenced but never declared", async () => {
    const result = await compileHarness(`
      workflow solo { stop when coder.done }
      harness run {
        workflow solo
        agent coder {
          use skill missing-skill
          connect mcp missing-mcp
        }
      }
    `);

    expect(result.bundle).toBeUndefined();
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown skill 'missing-skill'"),
        expect.stringContaining("unknown mcp 'missing-mcp'"),
      ]),
    );
  });

  it("fails compilation when a binding references an unknown capability", async () => {
    const result = await compileHarness(`
      binding does-not-exist for pi {
        unsupported
      }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("unknown capability 'does-not-exist'"))).toBe(
      true,
    );
  });

  it("fails compilation on duplicate bindings for the same capability and runtime", async () => {
    const result = await compileHarness(`
      skill gate { description "Verify first." }
      binding gate for pi { unsupported }
      binding gate for pi { unsupported }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("fails compilation on duplicate bindings split across source files", async () => {
    const result = await compileHarness([
      {
        uri: "memory://harness/first.harness",
        text: `
          skill gate { description "Verify first." }
          binding gate for pi { unsupported }
        `,
      },
      {
        uri: "memory://harness/second.harness",
        text: "binding gate for pi { unsupported }",
      },
    ]);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        source: "memory://harness/second.harness",
        message: expect.stringContaining("Duplicate capability/runtime binding 'gate::pi'"),
      }),
    );
  });

  it("rejects duplicate declarations and repeated harness members", async () => {
    const result = await compileHarness(`
      skill gate { description "Verify first." }
      tool gate {}
      workflow solo { stop when coder.done }
      workflow solo { stop when coder.done }
      runtime pi { adapter "@harness/adapter-pi" }
      runtime pi { adapter "@harness/adapter-pi" }
      harness run {
        workflow solo
        agent coder {
          use skill gate
          use skill gate
        }
        agent coder {
        }
        configure { shell.timeout = 1s shell.timeout = 2s }
      }
      harness run { workflow solo agent coder { } }
      target pi
      target pi
    `);

    expect(result.bundle).toBeUndefined();
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Duplicate capability 'gate'"),
        expect.stringContaining("Duplicate workflow 'solo'"),
        expect.stringContaining("Duplicate runtime 'pi'"),
        expect.stringContaining("Duplicate agent 'coder'"),
        expect.stringContaining("Duplicate agent 'coder' requirement 'gate'"),
        expect.stringContaining("Duplicate configuration key 'shell.timeout'"),
        expect.stringContaining("Duplicate harness 'run'"),
        expect.stringContaining("Duplicate target runtime 'pi'"),
      ]),
    );
  });

  it("rejects a skill with neither source nor description", async () => {
    const result = await compileHarness(`
      skill empty {}
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("neither 'source' nor 'description'"),
      }),
    );
  });

  it("rejects workflows that are empty or mix a program with a graph", async () => {
    const result = await compileHarness(`
      workflow empty {}
      workflow mixed {
        program deno "./flow.ts"
        a -> b
      }
    `);

    expect(result.bundle).toBeUndefined();
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Workflow 'empty' is empty"),
        expect.stringContaining("Workflow 'mixed' mixes 'program' with graph statements"),
      ]),
    );
  });

  it("rejects a harness whose workflow references undeclared agent roles", async () => {
    const result = await compileHarness(`
      workflow coding-loop {
        author -> verifier
        stop when verifier.passed
      }
      harness incomplete {
        workflow coding-loop
        agent author { }
      }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining(
          "Workflow 'coding-loop' references agent 'verifier', which harness 'incomplete' does not declare",
        ),
      }),
    );
  });

  it("returns diagnostics instead of throwing for a truncated harness declaration", async () => {
    const result = await compileHarness("harness broken {");

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((item) => item.severity === "error")).toBe(true);
  });

  it("rejects MCP declarations whose transport and endpoint disagree", async () => {
    const result = await compileHarness(`
      mcp local { transport stdio }
      mcp remote { transport http }
    `);

    expect(result.bundle).toBeUndefined();
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("MCP 'local' uses 'stdio' transport but declares no 'command'"),
        expect.stringContaining("MCP 'remote' uses 'http' transport but declares no 'url'"),
      ]),
    );
  });

  it("rejects a target adapter that conflicts with a declared runtime", async () => {
    const result = await compileHarness(`
      runtime prime { adapter "@harness/adapter-prime" }
      target prime uses adapter.other
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("already owns adapter '@harness/adapter-prime'"),
      }),
    );
  });

  it("rejects repeated tool inputs and outputs", async () => {
    const result = await compileHarness(`
      tool analyzer.run {
        input { src src }
        output { result result }
      }
    `);

    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        "Duplicate tool input 'src'.",
        "Duplicate tool output 'result'.",
      ]),
    );
  });
});
