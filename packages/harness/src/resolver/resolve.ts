import { contentHash, sha256Hex, canonicalJson } from "../ir/canonical.js";
import { STRENGTH_ORDER, strengthIndex } from "../language/harness-validator.js";
import {
  type AgentIr,
  type CapabilityBindingIr,
  type CapabilityIr,
  type CapabilityRequirementIr,
  type HarnessIrBundle,
  type HarnessRevision,
  IR_VERSION,
  type PermissionGrant,
  type Realization,
  type ResolutionReport,
  type RuntimeIr,
  findCapability,
} from "../ir/index.js";

export interface ResolveResult {
  /** Immutable run fact. Only present when the report status is `resolved`. */
  revision?: HarnessRevision;
  /** Always present: requested vs realized strength for every requirement. */
  report: ResolutionReport;
}

/**
 * Resolve a harness against a target runtime.
 *
 * Runtime selection: an explicit `runtimeId` wins; otherwise a single
 * `target` statement in the bundle, or a single declared `runtime`, selects
 * itself. A target without a runtime block synthesizes a tool-calling
 * runtime whose adapter is `@harness/adapter-<id>` — adapters are compile
 * backends that harness authors should not have to spell out.
 *
 * Degradation semantics (unchanged from v0.1):
 * A binding declares the strongest mechanism an adapter can eventually
 * provide on a runtime. The v0.2 executors materialize every supported
 * binding as prompt guidance, so effective strength is capped at `advisory`
 * until a native artifact and evidence-receipt contract lands.
 *
 * - realized >= preferred (or no preferred): satisfied
 * - minimum <= realized < preferred: degraded; `on-degrade fail` turns the
 *   degradation into a resolution failure instead of a silent prompt
 * - realized < minimum: always a resolution failure
 *
 * Deployability: a programmatic workflow only resolves against a runtime
 * whose execution is `programmatic` in the same language. Declarative
 * workflows deploy to any runtime.
 */
export function resolveHarness(
  bundle: HarnessIrBundle,
  harnessId: string,
  runtimeId?: string,
): ResolveResult {
  const harness = bundle.harnesses.find((candidate) => candidate.id === harnessId);
  if (!harness) {
    return {
      report: failedReport(harnessId, runtimeId ?? "unknown", [], [
        `Harness '${harnessId}' is not defined in the bundle.`,
      ]),
    };
  }

  const errors: string[] = [];
  const runtime = selectRuntime(bundle, runtimeId, errors);
  if (!runtime) {
    return { report: failedReport(harness.id, runtimeId ?? "unknown", [], errors) };
  }

  const workflow = bundle.workflows.find((candidate) => candidate.id === harness.workflow);
  if (!workflow) {
    return {
      report: failedReport(harness.id, runtime.id, [], [
        `Workflow '${harness.workflow}' is not defined in the bundle.`,
      ]),
    };
  }

  if (workflow.mode === "programmatic") {
    const language = workflow.program?.language ?? "unknown";
    if (runtime.execution.style !== "programmatic") {
      errors.push(
        `Workflow '${workflow.id}' is programmatic (${language}), but runtime '${runtime.id}' ` +
          `exposes tool-calling execution. Declare a runtime with 'execution ` +
          `programmatic.${language}', or drive the workflow externally over ACP.`,
      );
    } else if (runtime.execution.language !== language) {
      errors.push(
        `Workflow '${workflow.id}' is programmatic (${language}), but runtime '${runtime.id}' ` +
          `executes programmatic.${runtime.execution.language}. Author the workflow in the ` +
          `runtime's native language or restrict deployment targets.`,
      );
    }
  }

  const realizations: Realization[] = [];
  const enabledCapabilityIds = new Set<string>();
  for (const agent of harness.agents) {
    for (const requirement of agent.requirements) {
      const capability = findCapability(bundle, requirement.capabilityId);
      if (!capability) {
        errors.push(
          `Agent '${agent.id}' requires unknown capability '${requirement.capabilityId}'.`,
        );
        continue;
      }
      enabledCapabilityIds.add(capability.id);
      realizations.push(
        ...realizeRequirement(bundle, agent, requirement, runtime.id, errors),
      );
    }
  }
  realizations.sort(
    (a, b) => compareByKey(a.agentId, b.agentId) || compareByKey(a.capabilityId, b.capabilityId),
  );

  if (errors.length > 0) {
    return { report: failedReport(harness.id, runtime.id, realizations, errors) };
  }

  const enabledCapabilities = [...enabledCapabilityIds]
    .sort(compareByKey)
    .map((id) => findCapability(bundle, id))
    .filter((capability): capability is CapabilityIr => capability !== undefined);

  const revisionBody: Omit<HarnessRevision, "revisionId"> = {
    irVersion: IR_VERSION,
    kind: "harness-revision" as const,
    harness: { id: harness.id, contentHash: contentHash(harness) },
    target: { runtime: runtime.id, adapter: runtime.adapter, execution: runtime.execution },
    workflow: { id: workflow.id, mode: workflow.mode, contentHash: contentHash(workflow) },
    resolved: {
      capabilities: enabledCapabilities.map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        contentHash: contentHash(capability),
      })),
    },
    agents: harness.agents.map((agent) => ({
      id: agent.id,
      capabilities: agent.requirements
        .map((requirement) => requirement.capabilityId)
        .sort(compareByKey),
    })),
    realization: realizations,
    permissions: mergePermissions(enabledCapabilities),
    settings: harness.settings,
  };
  const revision: HarnessRevision = {
    ...revisionBody,
    revisionId: `hr_${sha256Hex(canonicalJson(revisionBody)).slice(0, 32)}`,
  };

  return {
    revision,
    report: {
      irVersion: IR_VERSION,
      kind: "resolution-report",
      harnessId: harness.id,
      runtime: runtime.id,
      status: "resolved",
      realizations,
      errors: [],
    },
  };
}

function selectRuntime(
  bundle: HarnessIrBundle,
  runtimeId: string | undefined,
  errors: string[],
): RuntimeIr | undefined {
  const id =
    runtimeId ??
    (bundle.targets.length === 1
      ? bundle.targets[0].runtime
      : bundle.targets.length === 0 && bundle.runtimes.length === 1
        ? bundle.runtimes[0].id
        : undefined);
  if (id === undefined) {
    errors.push(
      bundle.targets.length === 0 && bundle.runtimes.length === 0
        ? "No runtime is available: declare a 'target' or 'runtime', or pass a runtime id."
        : "Multiple runtimes are available; pass the runtime id to resolve against.",
    );
    return undefined;
  }
  const declared = bundle.runtimes.find((runtime) => runtime.id === id);
  if (declared) {
    return declared;
  }
  const target = bundle.targets.find((candidate) => candidate.runtime === id);
  if (!target && runtimeId !== undefined) {
    errors.push(`Runtime '${id}' is neither declared as a runtime nor listed as a target.`);
    return undefined;
  }
  // Deployment shorthand: `target qoder uses adapter.qoder` without a runtime
  // block means a tool-calling runtime with a conventional adapter package.
  return {
    irVersion: IR_VERSION,
    kind: "runtime",
    id,
    adapter: `@harness/adapter-${target?.adapter ?? id}`,
    execution: { style: "tool-calling" },
  };
}

function realizeRequirement(
  bundle: HarnessIrBundle,
  agent: AgentIr,
  requirement: CapabilityRequirementIr,
  runtimeId: string,
  errors: string[],
): Realization[] {
  const binding =
    bundle.bindings.find(
      (candidate) =>
        candidate.capabilityId === requirement.capabilityId && candidate.runtime === runtimeId,
    ) ?? defaultBindingFor(requirement.capabilityId, runtimeId);
  const materialization = materializeV02(binding);
  const realized = materialization.strength;
  const minimumIndex = strengthIndex(requirement.minimum);
  const realizedIndex = strengthIndex(realized);
  const preferredIndex =
    requirement.preferred !== undefined ? strengthIndex(requirement.preferred) : minimumIndex;

  if (realizedIndex < minimumIndex) {
    errors.push(
      `Capability '${requirement.capabilityId}' for agent '${agent.id}' realizes '${realized}' ` +
        `on runtime '${runtimeId}', below the required minimum '${requirement.minimum}'.`,
    );
    return [realize(agent, requirement, binding, materialization, "failed", degradeReason(binding, runtimeId))];
  }
  if (realizedIndex < preferredIndex) {
    const reason = degradeReason(binding, runtimeId);
    if (requirement.onDegrade === "fail") {
      errors.push(
        `Capability '${requirement.capabilityId}' for agent '${agent.id}' realizes '${realized}' ` +
          `on runtime '${runtimeId}', below the preferred '${requirement.preferred}' ` +
          `and the requirement declares 'on-degrade fail'.`,
      );
      return [realize(agent, requirement, binding, materialization, "failed", reason)];
    }
    return [realize(agent, requirement, binding, materialization, "degraded", reason)];
  }
  return [realize(agent, requirement, binding, materialization, "satisfied")];
}

/**
 * Merge capability permission grants into the revision permission surface.
 * The merge is monotonically tightening: an explicit `deny` on a domain
 * always wins over any grant, regardless of declaration order. MCP entries
 * carry no permission block; their transport implies the connection grant
 * (`stdio` spawns a process, `http`/`sse` reach the network).
 */
export function mergePermissions(capabilities: CapabilityIr[]): PermissionGrant[] {
  const byDomain = new Map<PermissionGrant["domain"], Set<PermissionGrant["access"]>>();
  const add = (grant: PermissionGrant): void => {
    const accesses = byDomain.get(grant.domain) ?? new Set();
    accesses.add(grant.access);
    byDomain.set(grant.domain, accesses);
  };
  for (const capability of capabilities) {
    if (capability.kind === "mcp") {
      add(
        capability.transport === "stdio"
          ? { domain: "process", access: "allow" }
          : { domain: "network", access: "allow" },
      );
      continue;
    }
    for (const grant of capability.permissions) {
      add(grant);
    }
  }
  const merged: PermissionGrant[] = [];
  for (const [domain, accesses] of byDomain) {
    if (accesses.has("deny")) {
      merged.push({ domain, access: "deny" });
      continue;
    }
    for (const access of accesses) {
      merged.push({ domain, access });
    }
  }
  return merged.sort(
    (a, b) => compareByKey(a.domain, b.domain) || compareByKey(a.access, b.access),
  );
}

function realize(
  agent: AgentIr,
  requirement: CapabilityRequirementIr,
  binding: CapabilityBindingIr,
  materialization: V02Materialization,
  action: Realization["action"],
  reason?: string,
): Realization {
  return {
    agentId: agent.id,
    capabilityId: requirement.capabilityId,
    capabilityKind: requirement.capabilityKind,
    requestedMinimum: requirement.minimum,
    ...(requirement.preferred !== undefined ? { requestedPreferred: requirement.preferred } : {}),
    declaredStrength: binding.strength,
    declaredMechanism: binding.mechanism,
    realized: materialization.strength,
    materializedMechanism: materialization.mechanism,
    action,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function degradeReason(binding: CapabilityBindingIr, runtime: string): string {
  const detail =
    `runtime '${runtime}' declares '${binding.strength}' via '${binding.mechanism}', ` +
    "but the v0.2 executor materializes prompt guidance at 'advisory' strength";
  return binding.notes ? `${detail}: ${binding.notes}` : detail;
}

/**
 * A capability without an explicit binding is treated as an advisory
 * prompt-guidance binding: the v0.2 floor. Adapters raise the ceiling by
 * declaring host-native mechanisms (`qoder.plugin`, `pi.extension`) with
 * stronger declared strengths.
 */
function defaultBindingFor(capabilityId: string, runtime: string): CapabilityBindingIr {
  return {
    irVersion: IR_VERSION,
    kind: "capability-binding",
    capabilityId,
    runtime,
    mechanism: "prompt-preamble",
    strength: "advisory",
  };
}

interface V02Materialization {
  strength: Realization["realized"];
  mechanism: string | null;
}

function materializeV02(binding: CapabilityBindingIr): V02Materialization {
  if (binding.strength === "unsupported") {
    return { strength: "unsupported", mechanism: null };
  }
  return { strength: "advisory", mechanism: "prompt-preamble" };
}

function failedReport(
  harnessId: string,
  runtime: string,
  realizations: Realization[],
  errors: string[],
): ResolutionReport {
  return {
    irVersion: IR_VERSION,
    kind: "resolution-report",
    harnessId,
    runtime,
    status: "failed",
    realizations,
    errors,
  };
}

function compareByKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { STRENGTH_ORDER };
