import type { HarnessIrBundle, HarnessRevision } from "../ir/index.js";

export interface HarnessRunTask {
  prompt: string;
  cwd?: string;
}

export interface HarnessRunResult {
  host: string;
  revisionId: string;
  exitCode: number;
  output: string;
  errorOutput: string;
  /** Realizations the executor could not materialize on this host. */
  warnings: string[];
  /** Redacted protocol events retained as run evidence when the host exposes them. */
  trace?: unknown[];
  /** Non-secret options the executor actually passed to the host runtime. */
  runtimeReceipt?: HarnessRuntimeReceipt;
  /** Host-reported consumption and termination evidence. */
  metrics?: HarnessRunMetrics;
}

export interface HarnessRuntimeReceipt {
  executor: string;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode?: string;
  maxTurns?: number;
  persistSession?: boolean;
  model?: string;
  fileCheckpointing?: boolean;
  permissionCallback: "configured" | "none";
}

export interface HarnessRunMetrics {
  durationMs?: number;
  durationApiMs?: number;
  turns?: number;
  costUsd?: number;
  credits?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permissionDenials?: unknown[];
  sessionId?: string;
  stopReason?: string;
  terminalReason?: string;
}

export interface HarnessExecutor {
  readonly host: string;
  execute(revision: HarnessRevision, bundle: HarnessIrBundle, task: HarnessRunTask): Promise<HarnessRunResult>;
}

export interface RunPreamble {
  preamble: string;
  warnings: string[];
}

export class HarnessHostMismatchError extends Error {
  constructor(revisionHost: string, executorHost: string) {
    super(`Harness revision targets host '${revisionHost}', but executor host is '${executorHost}'.`);
    this.name = "HarnessHostMismatchError";
  }
}

export function assertRevisionHost(revision: HarnessRevision, executorHost: string): void {
  if (revision.target.host !== executorHost) {
    throw new HarnessHostMismatchError(revision.target.host, executorHost);
  }
}

/**
 * Build the advisory portion of a run from a resolved revision.
 *
 * v0.1 executors materialize effective `advisory` realizations as prompt text.
 * The resolver has already capped stronger declared bindings to this effective
 * strength and applied the composition's degradation policy.
 */
export function buildRunPreamble(revision: HarnessRevision, bundle: HarnessIrBundle): RunPreamble {
  const lines: string[] = [];
  const warnings: string[] = [];
  for (const realization of revision.realization) {
    if (realization.action === "failed") {
      continue;
    }
    if (realization.action === "degraded" && realization.reason) {
      warnings.push(`Realization '${realization.componentId}' is degraded: ${realization.reason}.`);
    }
    if (realization.realized === "advisory") {
      const contract = bundle.components.find(
        (component) => component.id === realization.componentId,
      );
      const text = contract?.description ?? `Apply the '${realization.componentId}' capability.`;
      lines.push(`- [${realization.componentId}] ${text}`);
    }
  }
  const preamble =
    lines.length > 0
      ? [
          `You are running under harness revision ${revision.revisionId}.`,
          "Follow these harness policies:",
          ...lines,
        ].join("\n")
      : "";
  return { preamble, warnings };
}

export function buildRunPrompt(
  revision: HarnessRevision,
  bundle: HarnessIrBundle,
  task: HarnessRunTask,
): { prompt: string; warnings: string[] } {
  const { preamble, warnings } = buildRunPreamble(revision, bundle);
  return {
    prompt: preamble.length > 0 ? `${preamble}\n\n${task.prompt}` : task.prompt,
    warnings,
  };
}
