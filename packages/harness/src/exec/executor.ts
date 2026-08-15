import { findCapability, type CapabilityIr, type HarnessIrBundle, type HarnessRevision, type WorkflowIr } from "../ir/index.js";

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
  runtimeProfile?: string;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode?: string;
  maxTurns?: number;
  persistSession?: boolean;
  model?: string;
  fileCheckpointing?: boolean;
  permissionCallback: "configured" | "none";
  systemPromptSource?: "runtime-default" | "executor-profile";
  settingSources?: string[] | "runtime-default";
  skills?: string[] | "all" | "runtime-default";
  extensionCount?: number;
  pluginCount?: number;
  mcpServerNames?: string[];
  strictMcpConfig?: boolean;
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
  constructor(revisionRuntime: string, executorHost: string) {
    super(
      `Harness revision targets runtime '${revisionRuntime}', but executor host is '${executorHost}'.`,
    );
    this.name = "HarnessHostMismatchError";
  }
}

export function assertRevisionHost(revision: HarnessRevision, executorHost: string): void {
  if (revision.target.runtime !== executorHost) {
    throw new HarnessHostMismatchError(revision.target.runtime, executorHost);
  }
}

/** One prompt line per advisory capability, in the voice of the agent role. */
function capabilityGuidance(capability: CapabilityIr | undefined, capabilityId: string): string {
  if (capability === undefined) {
    return `Apply the '${capabilityId}' capability.`;
  }
  switch (capability.kind) {
    case "skill":
      return (
        capability.description ??
        `Apply the '${capability.id}' skill from '${capability.source ?? "its source"}'.`
      );
    case "tool":
      return capability.description ?? `Use the '${capability.id}' tool when applicable.`;
    case "mcp":
      return `Connect to the '${capability.id}' MCP server over ${capability.transport}.`;
  }
}

/** Render a declarative workflow graph as one prompt guidance line. */
function workflowGuidance(workflow: WorkflowIr | undefined): string | undefined {
  if (workflow === undefined || workflow.mode !== "declarative") {
    return undefined;
  }
  const parts = [
    ...workflow.edges.map((edge) => `${edge.from} -> ${edge.to}`),
    ...workflow.events.map((event) => `on ${event.agent}.${event.outcome} -> ${event.to}`),
    ...workflow.stops.map((stop) => `stop when ${stop.agent}.${stop.outcome}`),
  ];
  return parts.length > 0 ? `Workflow '${workflow.id}': ${parts.join("; ")}.` : undefined;
}

/**
 * Build the advisory portion of a run from a resolved revision.
 *
 * v0.2 executors materialize effective `advisory` realizations as prompt text:
 * the workflow graph plus each agent role's capabilities. The resolver has
 * already capped stronger declared bindings to this effective strength and
 * applied the harness's degradation policy.
 */
export function buildRunPreamble(revision: HarnessRevision, bundle: HarnessIrBundle): RunPreamble {
  const lines: string[] = [];
  const warnings: string[] = [];
  for (const realization of revision.realization) {
    if (realization.action === "failed") {
      continue;
    }
    if (realization.action === "degraded" && realization.reason) {
      warnings.push(
        `Realization '${realization.capabilityId}' for agent '${realization.agentId}' ` +
          `is degraded: ${realization.reason}.`,
      );
    }
    if (realization.realized === "advisory") {
      const capability = findCapability(bundle, realization.capabilityId);
      lines.push(
        `- [${realization.agentId}/${realization.capabilityId}] ` +
          capabilityGuidance(capability, realization.capabilityId),
      );
    }
  }
  const flow = workflowGuidance(
    bundle.workflows.find((workflow) => workflow.id === revision.workflow.id),
  );
  const preamble =
    lines.length > 0
      ? [
          `You are running under harness revision ${revision.revisionId}.`,
          ...(flow !== undefined ? [flow] : []),
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
