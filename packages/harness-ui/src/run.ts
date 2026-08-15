import {
  compileHarness,
  PiSdkExecutor,
  QoderSdkExecutor,
  resolveHarness,
  type HarnessExecutor,
  type HarnessRunEventListener,
  type HarnessRunResult,
} from "@qoder-ai/harness";
import type { AguiEvent } from "./protocol.js";
import { createAguiTranslator } from "./translate.js";

export interface HarnessUiExecutorContext {
  runtimeId: string;
  onRunEvent: HarnessRunEventListener;
}

/**
 * Produces the executor that runs the resolved revision. The default picks
 * the v0.2 executor matching the revision's runtime; tests and embedders can
 * inject a scripted executor instead.
 */
export type HarnessUiExecutorFactory = (context: HarnessUiExecutorContext) => HarnessExecutor;

export interface HarnessAguiRunOptions {
  /** `.harness` source text. */
  source: string;
  /** Defaults to the bundle's only harness. */
  harnessId?: string;
  /** Defaults to the bundle's only target runtime. */
  runtimeId?: string;
  prompt: string;
  cwd?: string;
  threadId: string;
  runId: string;
  onEvent: (event: AguiEvent) => void;
  executorFactory?: HarnessUiExecutorFactory;
}

export interface HarnessAguiRunSummary {
  ok: boolean;
  result?: HarnessRunResult;
}

function defaultExecutorFactory(context: HarnessUiExecutorContext): HarnessExecutor {
  switch (context.runtimeId) {
    case "qoder":
      return new QoderSdkExecutor({ onRunEvent: context.onRunEvent });
    case "pi":
      return new PiSdkExecutor({ onRunEvent: context.onRunEvent });
    default:
      throw new Error(
        `No default v0.2 executor for runtime '${context.runtimeId}'; inject an executorFactory.`,
      );
  }
}

/**
 * Compile, resolve, and execute one harness run, delivering AG-UI events.
 *
 * Failures before execution (compile or resolution errors) still produce a
 * protocol-complete stream: `RUN_STARTED` followed by a terminal `RUN_ERROR`.
 */
export async function runHarnessAgui(options: HarnessAguiRunOptions): Promise<HarnessAguiRunSummary> {
  const translator = createAguiTranslator({ threadId: options.threadId, runId: options.runId });
  const deliver = (events: AguiEvent[]): void => {
    for (const event of events) {
      options.onEvent(event);
    }
  };
  const fail = (message: string): HarnessAguiRunSummary => {
    deliver(translator.translate({ type: "run-started", revisionId: "unresolved", host: "harness-ui" }));
    deliver(translator.translate({ type: "run-error", message }));
    return { ok: false };
  };

  let compiled: Awaited<ReturnType<typeof compileHarness>>;
  try {
    compiled = await compileHarness(options.source);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!compiled.bundle) {
    return fail(compiled.diagnostics.map((item) => item.message).join("\n") || "Compilation failed.");
  }
  const harnessId = options.harnessId ?? compiled.bundle.harnesses[0]?.id;
  if (harnessId === undefined) {
    return fail("The source declares no harness.");
  }
  const { revision, report } = resolveHarness(compiled.bundle, harnessId, options.runtimeId);
  if (!revision) {
    return fail(report.errors.join("\n") || "Resolution failed.");
  }

  deliver(translator.translate({
    type: "run-started",
    revisionId: revision.revisionId,
    host: revision.target.runtime,
  }));
  try {
    const executorFactory = options.executorFactory ?? defaultExecutorFactory;
    const executor = executorFactory({
      runtimeId: revision.target.runtime,
      onRunEvent: (event) => deliver(translator.translate(event)),
    });
    const result = await executor.execute(revision, compiled.bundle, {
      prompt: options.prompt,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    if (!translator.terminated) {
      if (result.exitCode === 0) {
        deliver(translator.translate({
          type: "run-finished",
          exitCode: result.exitCode,
          ...(result.metrics !== undefined ? { metrics: result.metrics } : {}),
        }));
      } else {
        deliver(translator.translate({
          type: "run-error",
          message: result.errorOutput || `Harness run failed with exit code ${result.exitCode}.`,
        }));
      }
    }
    return { ok: result.exitCode === 0, result };
  } catch (error) {
    // The run layer owns the outer AG-UI lifecycle even when an injected
    // executor fails during construction or before it emits a terminal event.
    if (!translator.terminated) {
      deliver(translator.translate({
        type: "run-error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return { ok: false };
  }
}
