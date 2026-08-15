import { describe, expect, it } from "vitest";
import { compileHarness } from "../src/compiler/compile.js";
import type { HarnessIrBundle, HarnessRevision } from "../src/ir/index.js";
import { resolveHarness } from "../src/resolver/resolve.js";
import {
  HarnessCapabilityUnsupportedError,
  runOnce,
  type HarnessAdapterSession,
  type HarnessAdapterV1,
} from "../src/exec/adapter.js";
import type { HarnessRunEvent } from "../src/exec/events.js";
import { HarnessHostMismatchError, type HarnessRunResult } from "../src/exec/executor.js";
import { PiSdkAdapter, type PiSdkLike } from "../src/exec/pi-sdk.js";
import { QoderSdkAdapter, type QoderSdkLike } from "../src/exec/qoder-sdk.js";

const SOURCE = `
  skill impact-analysis {
    description "Impact analysis: map the blast radius before editing."
  }
  workflow solo-loop {
    stop when coder.done
  }
  harness assembly {
    workflow solo-loop
    agent coder {
      use skill impact-analysis
    }
  }
  binding impact-analysis for [qoder, pi] {
    mechanism prompt-preamble
    strength advisory
  }
  target qoder
  target pi
`;

async function resolveFor(runtimeId: string): Promise<{ bundle: HarnessIrBundle; revision: HarnessRevision }> {
  const { bundle } = await compileHarness(SOURCE);
  const { revision } = resolveHarness(bundle!, "assembly", runtimeId);
  return { bundle: bundle!, revision: revision! };
}

function successQoderSdk(prompts: string[]): QoderSdkLike {
  return {
    qodercliAuth: () => ({}),
    query: async function* (params) {
      prompts.push(params.prompt);
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: `turn-${prompts.length}` }] },
      };
      yield { type: "result", subtype: "success" };
    },
  };
}

/** Each turn must be one complete run: started first, finished last. */
function expectFramedTurns(events: HarnessRunEvent[], turns: number): void {
  const starts = events.filter((event) => event.type === "run-started");
  const finishes = events.filter((event) => event.type === "run-finished");
  expect(starts).toHaveLength(turns);
  expect(finishes).toHaveLength(turns);
  let open = false;
  for (const event of events) {
    if (event.type === "run-started") {
      expect(open).toBe(false);
      open = true;
    } else if (event.type === "run-finished") {
      expect(open).toBe(true);
      open = false;
    } else {
      expect(open).toBe(true);
    }
  }
  expect(open).toBe(false);
}

describe("QoderSdkAdapter sessions", () => {
  it("identifies itself through the versioned adapter contract", () => {
    const adapter = new QoderSdkAdapter({ loadSdk: async () => successQoderSdk([]) });

    expect(adapter.specificationVersion).toBe("harness-adapter-v1");
    expect(adapter.adapterId).toBe("@harness/adapter-qoder");
    expect(adapter.host).toBe("qoder");
  });

  it("runs sequential turns and re-sends the preamble for ephemeral host sessions", async () => {
    const { bundle, revision } = await resolveFor("qoder");
    const prompts: string[] = [];
    const events: HarnessRunEvent[] = [];
    const adapter = new QoderSdkAdapter({ loadSdk: async () => successQoderSdk(prompts) });

    const session = await adapter.doStart({
      revision,
      bundle,
      onRunEvent: (event) => events.push(event),
    });
    const first = await session.doPromptTurn({ prompt: "Fix the bug" });
    const second = await session.doPromptTurn({ prompt: "Now add a test" });
    await session.doStop();

    expect(first).toMatchObject({ host: "qoder", exitCode: 0, output: "turn-1" });
    expect(second).toMatchObject({ host: "qoder", exitCode: 0, output: "turn-2" });
    expect(prompts).toHaveLength(2);
    // persistSession defaults to false: every turn is independent, so both
    // prompts must carry the harness preamble.
    expect(prompts[0]).toContain(revision.revisionId);
    expect(prompts[1]).toContain(revision.revisionId);
    expect(prompts[1].endsWith("Now add a test")).toBe(true);
    expectFramedTurns(events, 2);
  });

  it("sends the preamble only once when the host persists the session", async () => {
    const { bundle, revision } = await resolveFor("qoder");
    const prompts: string[] = [];
    const adapter = new QoderSdkAdapter({
      loadSdk: async () => successQoderSdk(prompts),
      persistSession: true,
    });

    const session = await adapter.doStart({ revision, bundle });
    await session.doPromptTurn({ prompt: "Fix the bug" });
    await session.doPromptTurn({ prompt: "Now add a test" });
    await session.doStop();

    expect(prompts[0]).toContain(revision.revisionId);
    expect(prompts[1]).not.toContain(revision.revisionId);
    expect(prompts[1]).toBe("Now add a test");
  });

  it("bridges a per-turn abort signal onto the SDK abort controller", async () => {
    const { bundle, revision } = await resolveFor("qoder");
    const outer = new AbortController();
    let captured: AbortController | undefined;
    const sdk: QoderSdkLike = {
      qodercliAuth: () => ({}),
      query: async function* (params) {
        captured = params.options.abortController;
        outer.abort(new Error("caller gave up"));
        yield { type: "result", subtype: "success" };
      },
    };
    const adapter = new QoderSdkAdapter({ loadSdk: async () => sdk });

    const session = await adapter.doStart({ revision, bundle });
    await session.doPromptTurn({ prompt: "Fix the bug", abortSignal: outer.signal });
    await session.doStop();

    expect(captured).toBeDefined();
    expect(captured!.signal.aborted).toBe(true);
  });

  it("rejects a mismatched revision before loading the SDK and rejects turns after stop", async () => {
    const { bundle, revision } = await resolveFor("pi");
    let loaded = false;
    const adapter = new QoderSdkAdapter({
      loadSdk: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    });

    await expect(adapter.doStart({ revision, bundle })).rejects.toThrow(HarnessHostMismatchError);
    expect(loaded).toBe(false);

    const matching = await resolveFor("qoder");
    const prompts: string[] = [];
    const openAdapter = new QoderSdkAdapter({ loadSdk: async () => successQoderSdk(prompts) });
    const session = await openAdapter.doStart({ revision: matching.revision, bundle: matching.bundle });
    await session.doStop();
    await expect(session.doPromptTurn({ prompt: "too late" })).rejects.toThrow(/has ended/);
    expect(prompts).toHaveLength(0);
  });
});

describe("PiSdkAdapter sessions", () => {
  function multiTurnPiSdk(state: {
    prompts: string[];
    sessionsCreated: number;
    disposals: number;
  }): PiSdkLike {
    let listener: ((event: {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
    }) => void) | undefined;
    return {
      createAgentSession: async () => {
        state.sessionsCreated += 1;
        return {
          session: {
            prompt: async (text: string) => {
              state.prompts.push(text);
              listener?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: `pi-${state.prompts.length}` },
              });
            },
            subscribe: (nextListener) => {
              listener = nextListener;
              return () => {
                listener = undefined;
              };
            },
            dispose: () => {
              state.disposals += 1;
            },
          },
        };
      },
      SessionManager: { inMemory: () => ({}) },
      ModelRuntime: { create: async () => ({}) },
    };
  }

  it("keeps one Pi session across turns and sends the preamble on the first turn only", async () => {
    const { bundle, revision } = await resolveFor("pi");
    const state = { prompts: [] as string[], sessionsCreated: 0, disposals: 0 };
    const events: HarnessRunEvent[] = [];
    const adapter = new PiSdkAdapter({ loadSdk: async () => multiTurnPiSdk(state) });

    const session = await adapter.doStart({
      revision,
      bundle,
      onRunEvent: (event) => events.push(event),
    });
    const first = await session.doPromptTurn({ prompt: "Fix the bug" });
    const second = await session.doPromptTurn({ prompt: "Now add a test" });
    await session.doStop();

    expect(state.sessionsCreated).toBe(1);
    expect(state.disposals).toBe(1);
    expect(first.output).toBe("pi-1");
    expect(second.output).toBe("pi-2");
    expect(state.prompts[0]).toContain(revision.revisionId);
    expect(state.prompts[1]).toBe("Now add a test");
    expectFramedTurns(events, 2);

    await expect(session.doPromptTurn({ prompt: "too late" })).rejects.toThrow(/has ended/);
    await session.doDestroy();
    expect(state.disposals).toBe(1);
  });

  it("refuses a turn abort signal with a typed capability-unsupported error", async () => {
    const { bundle, revision } = await resolveFor("pi");
    const state = { prompts: [] as string[], sessionsCreated: 0, disposals: 0 };
    const adapter = new PiSdkAdapter({ loadSdk: async () => multiTurnPiSdk(state) });

    const session = await adapter.doStart({ revision, bundle });
    const attempt = session.doPromptTurn({
      prompt: "Fix the bug",
      abortSignal: new AbortController().signal,
    });

    await expect(attempt).rejects.toThrow(HarnessCapabilityUnsupportedError);
    await expect(attempt).rejects.toMatchObject({
      adapterId: "@harness/adapter-pi",
      capability: "turn-abort",
    });
    expect(state.prompts).toHaveLength(0);
    await session.doStop();
  });
});

describe("runOnce", () => {
  function fakeResult(revision: HarnessRevision): HarnessRunResult {
    return {
      host: "qoder",
      revisionId: revision.revisionId,
      exitCode: 0,
      output: "done",
      errorOutput: "",
      warnings: [],
    };
  }

  it("degrades an unsupported graceful stop to a destroy plus a result warning", async () => {
    const { bundle, revision } = await resolveFor("qoder");
    let destroyed = false;
    const session: HarnessAdapterSession = {
      adapterId: "@harness/adapter-fake",
      revisionId: revision.revisionId,
      doPromptTurn: async () => fakeResult(revision),
      doStop: async () => {
        throw new HarnessCapabilityUnsupportedError("@harness/adapter-fake", "graceful-stop");
      },
      doDestroy: async () => {
        destroyed = true;
      },
    };
    const adapter: HarnessAdapterV1 = {
      specificationVersion: "harness-adapter-v1",
      adapterId: "@harness/adapter-fake",
      host: "qoder",
      doStart: async () => session,
    };

    const result = await runOnce(adapter, revision, bundle, { prompt: "Fix the bug" });

    expect(destroyed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cannot stop gracefully");
    expect(result.warnings[0]).toContain("graceful-stop");
  });

  it("destroys the session and rethrows when the turn itself fails", async () => {
    const { bundle, revision } = await resolveFor("qoder");
    let destroyed = false;
    const adapter: HarnessAdapterV1 = {
      specificationVersion: "harness-adapter-v1",
      adapterId: "@harness/adapter-fake",
      host: "qoder",
      doStart: async () => ({
        adapterId: "@harness/adapter-fake",
        revisionId: revision.revisionId,
        doPromptTurn: async () => {
          throw new Error("turn exploded");
        },
        doStop: async () => {
          throw new Error("stop must not be called after a failed turn");
        },
        doDestroy: async () => {
          destroyed = true;
        },
      }),
    };

    await expect(runOnce(adapter, revision, bundle, { prompt: "Fix the bug" })).rejects.toThrow(
      "turn exploded",
    );
    expect(destroyed).toBe(true);
  });

  it("emits the legacy failure event sequence when the session cannot start", async () => {
    const { bundle, revision } = await resolveFor("qoder");
    const events: HarnessRunEvent[] = [];
    const adapter: HarnessAdapterV1 = {
      specificationVersion: "harness-adapter-v1",
      adapterId: "@harness/adapter-fake",
      host: "qoder",
      doStart: async () => {
        throw new Error("sdk missing");
      },
    };

    await expect(
      runOnce(adapter, revision, bundle, { prompt: "Fix the bug" }, {
        onRunEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("sdk missing");

    expect(events.map((event) => event.type)).toEqual(["run-started", "run-error", "run-finished"]);
  });
});
