import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import type { HarnessIrBundle, HarnessRevision } from "../src/ir/index.js";
import { resolveComposition } from "../src/resolver/resolve.js";
import { PiSdkExecutor, materializePiPackage, type PiSdkLike } from "../src/exec/pi-sdk.js";
import { QoderSdkExecutor, type QoderSdkLike } from "../src/exec/qoder-sdk.js";

const SOURCE = `
  component impact-analysis {
    kind skill
    description "Impact analysis: map the blast radius before editing."
  }
  component verification-before-complete {
    kind policy
    description "Do not complete without verification evidence."
  }
  binding impact-analysis for qoder {
    mechanism skill-routing
    strength advisory
  }
  binding verification-before-complete for qoder {
    mechanism stop-hook
    strength enforced
  }
  binding impact-analysis for pi {
    mechanism skill-package
    strength advisory
  }
  binding verification-before-complete for pi {
    mechanism extension-event
    strength enforced
  }
  plugin all {
    version "1.0.0"
    provides [ component.impact-analysis, component.verification-before-complete ]
  }
  composition on-qoder {
    target qoder
    include [ plugin.all@1 ]
    require verification-before-complete {
      preferred enforced
      minimum advisory
      on-degrade report
    }
  }
  composition on-pi {
    target pi
    include [ plugin.all@1 ]
    require verification-before-complete {
      preferred enforced
      minimum advisory
      on-degrade report
    }
  }
`;

async function resolveFor(compositionId: string): Promise<{ bundle: HarnessIrBundle; revision: HarnessRevision }> {
  const { bundle } = await compileHarness(SOURCE);
  const { revision } = resolveComposition(bundle!, compositionId);
  return { bundle: bundle!, revision: revision! };
}

describe("QoderSdkExecutor", () => {
  it("streams one Qoder SDK query with explicit auth, cwd, and tool authorization", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    const queries: Parameters<QoderSdkLike["query"]>[0][] = [];
    const auth = { kind: "test-auth" };
    const sdk: QoderSdkLike = {
      qodercliAuth: () => auth,
      query: async function* (params) {
        queries.push(params);
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        };
        yield { type: "result", subtype: "success" };
      },
    };
    const abortController = new AbortController();
    const canUseTool = async () => ({ behavior: "allow" as const });
    const streamedTrace: unknown[] = [];
    const executor = new QoderSdkExecutor({
      loadSdk: async () => sdk,
      allowedTools: ["Read"],
      tools: ["Read", "Bash"],
      disallowedTools: ["WebFetch"],
      permissionMode: "default",
      canUseTool,
      model: "test-model",
      enableFileCheckpointing: true,
      abortController,
      onTraceEvent: (event) => streamedTrace.push(event),
      maxTurns: 12,
    });

    const result = await executor.execute(revision, bundle, { prompt: "Fix the bug", cwd: "/tmp" });

    expect(queries).toHaveLength(1);
    expect(queries[0].options).toEqual({
      auth,
      cwd: "/tmp",
      allowedTools: ["Read"],
      tools: ["Read", "Bash"],
      disallowedTools: ["WebFetch"],
      permissionMode: "default",
      canUseTool,
      persistSession: false,
      maxTurns: 12,
      model: "test-model",
      enableFileCheckpointing: true,
      abortController,
    });
    const prompt = queries[0].prompt;
    expect(prompt.endsWith("Fix the bug")).toBe(true);
    expect(prompt).toContain(revision.revisionId);
    expect(prompt).toContain("Impact analysis: map the blast radius before editing.");
    expect(result).toMatchObject({
      host: "qoder",
      exitCode: 0,
      output: "done",
      runtimeReceipt: {
        executor: "@qoder-ai/qoder-agent-sdk",
        tools: ["Read", "Bash"],
        allowedTools: ["Read"],
        disallowedTools: ["WebFetch"],
        permissionMode: "default",
        maxTurns: 12,
        model: "test-model",
        fileCheckpointing: true,
        permissionCallback: "configured",
      },
    });
    expect(streamedTrace).toEqual(result.trace);
  });

  it("retains usage evidence while redacting credential-shaped trace fields", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    const sdk: QoderSdkLike = {
      qodercliAuth: () => ({}),
      query: async function* () {
        yield {
          type: "system",
          subtype: "init",
          access_token: "must-not-leak",
          nested: { serviceAccountKey: "also-must-not-leak" },
        };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 120,
          duration_api_ms: 90,
          num_turns: 2,
          total_cost_usd: 0.01,
          total_credits: 1.25,
          usage: { input_tokens: 10, output_tokens: 5 },
          modelUsage: { model: { inputTokens: 10 } },
          permission_denials: [],
          session_id: "session-1",
          stop_reason: "end_turn",
          terminal_reason: "completed",
        };
      },
    };

    const result = await new QoderSdkExecutor({ loadSdk: async () => sdk }).execute(
      revision,
      bundle,
      { prompt: "Inspect" },
    );

    expect(result.trace).toContainEqual(
      expect.objectContaining({ access_token: "[REDACTED]" }),
    );
    expect(JSON.stringify(result.trace)).not.toContain("must-not-leak");
    expect(result.trace).toContainEqual(
      expect.objectContaining({ nested: { serviceAccountKey: "[REDACTED]" } }),
    );
    expect(result.metrics).toEqual({
      durationMs: 120,
      durationApiMs: 90,
      turns: 2,
      costUsd: 0.01,
      credits: 1.25,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { model: { inputTokens: 10 } },
      permissionDenials: [],
      sessionId: "session-1",
      stopReason: "end_turn",
      terminalReason: "completed",
    });
  });

  it("reports declared native strength as an advisory degradation", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    const sdk: QoderSdkLike = {
      qodercliAuth: () => ({}),
      query: async function* () {
        yield { type: "result", subtype: "success" };
      },
    };
    const executor = new QoderSdkExecutor({
      loadSdk: async () => sdk,
    });

    const result = await executor.execute(revision, bundle, { prompt: "Fix the bug" });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("verification-before-complete");
    expect(result.warnings[0]).toContain("stop-hook");
  });

  it("rejects a revision targeting another host before loading the Qoder SDK", async () => {
    const { bundle, revision } = await resolveFor("on-pi");
    let loaded = false;
    const executor = new QoderSdkExecutor({
      loadSdk: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    });

    await expect(executor.execute(revision, bundle, { prompt: "Fix the bug" })).rejects.toThrow(
      /targets host 'pi'.*executor host is 'qoder'/,
    );
    expect(loaded).toBe(false);
  });

  it("reports an SDK query failure without leaking non-error messages", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    const sdk: QoderSdkLike = {
      qodercliAuth: () => ({}),
      query: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["auth failed"],
        };
      },
    };

    const result = await new QoderSdkExecutor({ loadSdk: async () => sdk }).execute(
      revision,
      bundle,
      { prompt: "Fix the bug" },
    );

    expect(result).toMatchObject({ exitCode: 1, output: "partial", errorOutput: "auth failed" });
  });

  it("fails closed when the Qoder SDK stream ends without a result message", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    const sdk: QoderSdkLike = {
      qodercliAuth: () => ({}),
      query: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
      },
    };

    const result = await new QoderSdkExecutor({ loadSdk: async () => sdk }).execute(
      revision,
      bundle,
      { prompt: "Fix the bug" },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      output: "partial",
      errorOutput: "Qoder SDK query ended without a result message.",
    });
  });
});

describe("PiSdkExecutor", () => {
  it("drives the Pi SDK session with the composed prompt", async () => {
    const { bundle, revision } = await resolveFor("on-pi");
    const prompts: string[] = [];
    const workingDirectories: Array<string | undefined> = [];
    const selectedModel = { provider: "deepseek", id: "deepseek-chat" };
    const runtime = { marker: "runtime" };
    const configuredRuntimes: unknown[] = [];
    const sessionConfigs: Parameters<PiSdkLike["createAgentSession"]>[0][] = [];
    let disposed = false;
    let listener: ((event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }) => void) | undefined;
    const stubSdk: PiSdkLike = {
      createAgentSession: async (config) => {
        sessionConfigs.push(config);
        workingDirectories.push(config.cwd);
        return {
          session: {
            prompt: async (text: string) => {
              prompts.push(text);
              listener?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "pi-response" },
              });
              return undefined;
            },
            subscribe: (nextListener) => {
              listener = nextListener;
              return () => {
                listener = undefined;
              };
            },
            dispose: () => {
              disposed = true;
            },
          },
        };
      },
      SessionManager: { inMemory: () => ({}) },
      ModelRuntime: { create: async () => runtime },
    };
    const executor = new PiSdkExecutor({
      loadSdk: async () => stubSdk,
      configureModelRuntime: async (modelRuntime) => {
        configuredRuntimes.push(modelRuntime);
      },
      selectModel: (modelRuntime) => {
        expect(modelRuntime).toBe(runtime);
        return selectedModel;
      },
    });

    const result = await executor.execute(revision, bundle, { prompt: "Fix the bug", cwd: "/tmp" });

    expect(prompts).toHaveLength(1);
    expect(configuredRuntimes).toEqual([runtime]);
    expect(workingDirectories).toEqual(["/tmp"]);
    expect(sessionConfigs[0]).toMatchObject({
      modelRuntime: runtime,
      model: selectedModel,
      noTools: "all",
    });
    expect(disposed).toBe(true);
    expect(prompts[0].endsWith("Fix the bug")).toBe(true);
    expect(prompts[0]).toContain(revision.revisionId);
    expect(result).toMatchObject({ host: "pi", exitCode: 0, output: "pi-response" });
  });

  it("surfaces a model failure encoded in the final Pi assistant message", async () => {
    const { bundle, revision } = await resolveFor("on-pi");
    let listener:
      | ((event: {
          type?: string;
          message?: { role?: string; stopReason?: string; errorMessage?: string };
        }) => void)
      | undefined;
    let disposed = false;
    const stubSdk: PiSdkLike = {
      createAgentSession: async () => ({
        session: {
          prompt: async () => {
            listener?.({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "provider rejected request",
              },
            });
          },
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => {
              listener = undefined;
            };
          },
          dispose: () => {
            disposed = true;
          },
        },
      }),
      SessionManager: { inMemory: () => ({}) },
      ModelRuntime: { create: async () => ({}) },
    };

    const result = await new PiSdkExecutor({ loadSdk: async () => stubSdk }).execute(
      revision,
      bundle,
      { prompt: "Fix the bug" },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      output: "",
      errorOutput: "provider rejected request",
    });
    expect(disposed).toBe(true);
  });

  it("rejects a revision targeting another host before loading the Pi SDK", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    let loaded = false;
    const executor = new PiSdkExecutor({
      loadSdk: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    });

    await expect(executor.execute(revision, bundle, { prompt: "Fix the bug" })).rejects.toThrow(
      /targets host 'qoder'.*executor host is 'pi'/,
    );
    expect(loaded).toBe(false);
  });

  it("reports the missing optional peer dependency with install guidance", async () => {
    const { bundle, revision } = await resolveFor("on-pi");
    const executor = new PiSdkExecutor({
      loadSdk: async () => {
        throw new Error("simulated missing optional peer");
      },
    });

    await expect(executor.execute(revision, bundle, { prompt: "Fix the bug" })).rejects.toThrow(
      /@earendil-works\/pi-coding-agent/,
    );
  });
});

describe("installed SDK contracts", () => {
  it("exposes the Qoder SDK entry points used by the executor", async () => {
    const sdk = await import("@qoder-ai/qoder-agent-sdk");

    expect(sdk.query).toBeTypeOf("function");
    expect(sdk.qodercliAuth).toBeTypeOf("function");
  });

  it("exposes the current Pi SDK entry points used by the executor", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");

    expect(sdk.createAgentSession).toBeTypeOf("function");
    expect(sdk.SessionManager.inMemory).toBeTypeOf("function");
    expect(sdk.ModelRuntime.create).toBeTypeOf("function");
  });
});

describe("materializePiPackage", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("writes an installable Pi package with skills for advisory components", async () => {
    const { bundle, revision } = await resolveFor("on-pi");
    directory = await mkdtemp(join(tmpdir(), "harness-pi-"));

    const written = await materializePiPackage(revision, bundle, directory);

    expect(written).toContain("package.json");
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    expect(manifest.pi.skills).toEqual(["./skills"]);
    const skill = await readFile(join(directory, "skills", "impact-analysis", "SKILL.md"), "utf8");
    expect(skill).toContain("name: impact-analysis");
    expect(skill).toContain('description: "Impact analysis: map the blast radius before editing."');
    expect(skill).toContain(revision.revisionId);
    // Policies remain prompt guidance and must not be mislabeled as Pi skills.
    expect(written.some((path) => path.includes("verification-before-complete"))).toBe(false);
    await expect(
      access(join(directory, "skills", "verification-before-complete", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("rejects materialization for a revision targeting another host", async () => {
    const { bundle, revision } = await resolveFor("on-qoder");
    directory = await mkdtemp(join(tmpdir(), "harness-pi-"));

    await expect(materializePiPackage(revision, bundle, directory)).rejects.toThrow(
      /targets host 'qoder'.*executor host is 'pi'/,
    );
  });

  it("fails closed instead of mixing a revision with pre-existing files", async () => {
    const { bundle, revision } = await resolveFor("on-pi");
    directory = await mkdtemp(join(tmpdir(), "harness-pi-"));
    await writeFile(join(directory, "keep.txt"), "user-owned\n", "utf8");

    await expect(materializePiPackage(revision, bundle, directory)).rejects.toThrow(
      /destination must be empty/,
    );
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("user-owned\n");
  });
});
