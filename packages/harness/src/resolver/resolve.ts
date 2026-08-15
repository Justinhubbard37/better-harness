import { contentHash } from "../ir/canonical.js";
import { STRENGTH_ORDER, strengthIndex } from "../language/harness-validator.js";
import {
  type AgentIr,
  type CapabilityBindingIr,
  type CapabilityIr,
  type CapabilityRequirementIr,
  type HarnessIrBundle,
  type HarnessRevision,
  type HarnessSpecIr,
  IR_VERSION,
  type PermissionGrant,
  type Realization,
  type ResolutionReport,
  type RuntimeIr,
  type SourceLock,
  type WorkflowIr,
  findCapability,
} from "../ir/index.js";
import { computeRevisionId, deepFreeze } from "../ir/revision.js";
import {
  PROMPT_ONLY_DESCRIPTOR,
  realizationFactFor,
  workflowFactFor,
  type AdapterRealizationDescriptor,
  type CapabilityRealizationFact,
} from "./adapter-descriptor.js";

export interface ResolveOptions {
  /**
   * Realization facts of the adapter that will run this revision, either the
   * descriptor itself or a lookup keyed by the selected runtime for callers that
   * let the bundle choose its target. Omitting it resolves against
   * {@link PROMPT_ONLY_DESCRIPTOR}: guidance only, no tool surface, no MCP,
   * declarative flows. An unknown runtime therefore fails closed instead of
   * inheriting an optimistic assumption.
   */
  adapter?:
    | AdapterRealizationDescriptor
    | ((runtimeId: string) => AdapterRealizationDescriptor | undefined);
  /** Content locks for declared capability sources, from `lockCapabilitySources`. */
  sourceLocks?: readonly SourceLock[];
  /** Provenance link to a HarnessComponentSnapshotV1, included in the revision hash. */
  componentSnapshotRef?: { snapshotId: string; digest: string };
}

export interface ResolveResult {
  /** Immutable run fact. Only present when the report status is `resolved`. */
  revision?: HarnessRevision;
  /** Always present: requested vs realized strength for every requirement. */
  report: ResolutionReport;
}

/**
 * Resolve a harness against a target runtime and one adapter's realization facts.
 *
 * Runtime selection: an explicit `runtimeId` wins; otherwise a single
 * `target` statement in the bundle, or a single declared `runtime`, selects
 * itself. A target without a runtime block synthesizes a tool-calling
 * runtime whose adapter is `@harness/adapter-<id>` — adapters are compile
 * backends that harness authors should not have to spell out.
 *
 * Materialization is capability-kind aware, because the kinds are not realized
 * along the same dimension:
 *
 * - a skill is *delivered* as guidance, which prompt text genuinely does
 * - a tool must be *exposed* as a callable host tool; prompt text never is one
 * - an MCP server must be *connected* and tool-discovered
 * - a workflow must be *orchestrated*, not merely described
 *
 * The adapter descriptor answers those questions. A declared binding still
 * bounds the result — `strength unsupported` keeps a capability off a runtime —
 * but a binding claiming `enforced` cannot raise what the adapter actually does.
 *
 * Degradation semantics:
 *
 * - realized >= preferred (or no preferred): satisfied
 * - minimum <= realized < preferred: degraded; `on-degrade fail` turns the
 *   degradation into a resolution failure instead of a silent prompt
 * - realized < minimum: always a resolution failure
 *
 * Deployability: a programmatic workflow only resolves against a runtime whose
 * execution is `programmatic` in the same language *and* an adapter that can
 * drive programmatic workflows.
 */
export function resolveHarness(
  bundle: HarnessIrBundle,
  harnessId: string,
  runtimeId?: string,
  options: ResolveOptions = {},
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
  const warnings: string[] = [];
  const runtime = selectRuntime(bundle, runtimeId, errors);
  if (!runtime) {
    return { report: failedReport(harness.id, runtimeId ?? "unknown", [], errors) };
  }

  const descriptor = descriptorFor(options.adapter, runtime.id, runtime.adapter);

  const workflow = bundle.workflows.find((candidate) => candidate.id === harness.workflow);
  if (!workflow) {
    return {
      report: failedReport(harness.id, runtime.id, [], [
        `Workflow '${harness.workflow}' is not defined in the bundle.`,
      ]),
    };
  }

  checkWorkflowDeployability(workflow, runtime, harness, descriptor, errors, warnings);

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
        ...realizeRequirement(bundle, agent, requirement, runtime.id, descriptor, errors),
      );
    }
  }
  realizations.sort(
    (a, b) => compareByKey(a.agentId, b.agentId) || compareByKey(a.capabilityId, b.capabilityId),
  );

  if (errors.length > 0) {
    return { report: failedReport(harness.id, runtime.id, realizations, errors, warnings) };
  }

  const enabledCapabilities = [...enabledCapabilityIds]
    .sort(compareByKey)
    .map((id) => findCapability(bundle, id))
    .filter((capability): capability is CapabilityIr => capability !== undefined);
  const sourceLocks = selectSourceLocks(enabledCapabilities, options.sourceLocks ?? [], errors);
  if (errors.length > 0) {
    return { report: failedReport(harness.id, runtime.id, realizations, errors, warnings) };
  }

  const revisionBody: Omit<HarnessRevision, "revisionId"> = {
    irVersion: IR_VERSION,
    kind: "harness-revision" as const,
    harness: { id: harness.id, contentHash: contentHash(harness) },
    target: {
      runtime: runtime.id,
      adapter: runtime.adapter,
      adapterSpecificationVersion: descriptor.specificationVersion,
      adapterImplementationVersion: descriptor.implementationVersion,
      adapterDescriptorHash: contentHash(descriptor),
      execution: runtime.execution,
    },
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
    requestedPermissions: mergePermissions(enabledCapabilities),
    settings: harness.settings,
    sourceLocks,
    ...(options.componentSnapshotRef !== undefined
      ? { componentSnapshotRef: { ...options.componentSnapshotRef } }
      : {}),
  };
  // Frozen at the boundary: a revision handed to an executor is a run fact, and
  // an executor that can edit it can also invalidate its own evidence.
  const revision = deepFreeze<HarnessRevision>({
    ...revisionBody,
    revisionId: computeRevisionId(revisionBody),
  });

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
      warnings,
    },
  };
}

/**
 * Select and validate the exact source locks this revision depends on.
 *
 * `lockCapabilitySources` may lock a whole bundle while one harness uses only a
 * subset, so unrelated locks are ignored. Every resolved source-backed skill,
 * however, must have exactly one matching URI/digest entry: an empty or partial
 * lock set would recreate the mutable-source hole the revision is meant to close.
 */
function selectSourceLocks(
  capabilities: readonly CapabilityIr[],
  supplied: readonly SourceLock[],
  errors: string[],
): SourceLock[] {
  const selected: SourceLock[] = [];
  for (const capability of capabilities) {
    if (capability.kind !== "skill" || capability.source === undefined) {
      continue;
    }
    const matches = supplied.filter((lock) => lock.capabilityId === capability.id);
    if (matches.length !== 1) {
      errors.push(
        `Source-backed skill '${capability.id}' requires exactly one content lock; ` +
          `received ${matches.length}. Run lockCapabilitySources() before resolving.`,
      );
      continue;
    }
    const lock = matches[0];
    if (lock.uri !== capability.source) {
      errors.push(
        `Source lock for skill '${capability.id}' names '${lock.uri}', expected '${capability.source}'.`,
      );
      continue;
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(lock.digest) || !Number.isInteger(lock.files) || lock.files < 1) {
      errors.push(`Source lock for skill '${capability.id}' has an invalid digest or file count.`);
      continue;
    }
    selected.push({ ...lock });
  }
  return selected.sort((a, b) => compareByKey(a.capabilityId, b.capabilityId));
}

/**
 * The descriptor this resolve measures against.
 *
 * A lookup that has nothing for the selected runtime falls back to prompt-only
 * facts: an unknown host must not inherit another adapter's abilities.
 */
function descriptorFor(
  adapter: ResolveOptions["adapter"],
  runtimeId: string,
  adapterId: string,
): AdapterRealizationDescriptor {
  if (adapter === undefined) {
    return { ...PROMPT_ONLY_DESCRIPTOR, adapterId };
  }
  if (typeof adapter === "function") {
    return adapter(runtimeId) ?? { ...PROMPT_ONLY_DESCRIPTOR, adapterId };
  }
  return adapter;
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

/**
 * A workflow must be deployable against adapter-owned execution facts. A
 * programmatic controller that nobody executes is a resolution failure, not a
 * silent no-op.
 */
function checkWorkflowDeployability(
  workflow: WorkflowIr,
  runtime: RuntimeIr,
  harness: HarnessSpecIr,
  descriptor: AdapterRealizationDescriptor,
  errors: string[],
  warnings: string[],
): void {
  if (workflow.mode === "programmatic") {
    const language = workflow.program?.language ?? "unknown";
    if (!descriptor.programmaticLanguages.includes(language)) {
      errors.push(
        `Workflow '${workflow.id}' is programmatic (${language}), but runtime '${runtime.id}' ` +
          `uses adapter '${descriptor.adapterId}', whose descriptor does not list ` +
          `programmatic language '${language}'.`,
      );
    }
  }
  const fact = workflowFactFor(descriptor, workflow, harness.agents.length);
  if (!fact.supported) {
    errors.push(
      `Workflow '${workflow.id}' cannot be orchestrated on runtime '${runtime.id}': ` +
        `${fact.limitation}.`,
    );
    return;
  }
  if (fact.limitation !== undefined) {
    warnings.push(`Workflow '${workflow.id}' is degraded to '${fact.mode}': ${fact.limitation}.`);
  }
}

function realizeRequirement(
  bundle: HarnessIrBundle,
  agent: AgentIr,
  requirement: CapabilityRequirementIr,
  runtimeId: string,
  descriptor: AdapterRealizationDescriptor,
  errors: string[],
): Realization[] {
  const binding =
    bundle.bindings.find(
      (candidate) =>
        candidate.capabilityId === requirement.capabilityId && candidate.runtime === runtimeId,
    ) ?? defaultBindingFor(requirement.capabilityId, runtimeId);
  const materialization = materializeAgainstAdapter(binding, requirement, descriptor);
  const realized = materialization.strength;
  const minimumIndex = strengthIndex(requirement.minimum);
  const realizedIndex = strengthIndex(realized);
  const preferredIndex =
    requirement.preferred !== undefined ? strengthIndex(requirement.preferred) : minimumIndex;

  if (realizedIndex < minimumIndex) {
    errors.push(
      `Capability '${requirement.capabilityId}' for agent '${agent.id}' realizes '${realized}' ` +
        `on runtime '${runtimeId}', below the required minimum '${requirement.minimum}': ` +
        `${materialization.reason}.`,
    );
    return [realize(agent, requirement, binding, materialization, "failed", materialization.reason)];
  }
  if (realizedIndex < preferredIndex) {
    if (requirement.onDegrade === "fail") {
      errors.push(
        `Capability '${requirement.capabilityId}' for agent '${agent.id}' realizes '${realized}' ` +
          `on runtime '${runtimeId}', below the preferred '${requirement.preferred}' ` +
          `and the requirement declares 'on-degrade fail'.`,
      );
      return [realize(agent, requirement, binding, materialization, "failed", materialization.reason)];
    }
    return [realize(agent, requirement, binding, materialization, "degraded", materialization.reason)];
  }
  return [realize(agent, requirement, binding, materialization, "satisfied")];
}

/**
 * Merge capability permission grants into the revision's requested permission
 * surface. The merge is monotonically tightening: an explicit `deny` on a domain
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
  materialization: AdapterMaterialization,
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

/**
 * A capability without an explicit binding falls back to the adapter's own
 * mechanism for that kind: the binding block is a deployment overlay, not the
 * source of truth about what a runtime can do.
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

export interface AdapterMaterialization {
  strength: Realization["realized"];
  mechanism: string | null;
  dimension: CapabilityRealizationFact["dimension"];
  reason: string;
}

/**
 * Materialize one requirement against the adapter's facts.
 *
 * Observed realization belongs to the adapter, so the descriptor decides the
 * strength. The author-declared binding can only ever *withhold* a capability
 * from a runtime (`strength unsupported`); it cannot promise more than the
 * adapter delivers.
 */
export function materializeAgainstAdapter(
  binding: CapabilityBindingIr,
  requirement: CapabilityRequirementIr,
  descriptor: AdapterRealizationDescriptor,
): AdapterMaterialization {
  if (binding.strength === "unsupported") {
    return {
      strength: "unsupported",
      mechanism: null,
      dimension: dimensionFor(requirement.capabilityKind),
      reason:
        `the deployment binding declares '${requirement.capabilityId}' unsupported on ` +
        `runtime '${binding.runtime}'` + (binding.notes ? `: ${binding.notes}` : ""),
    };
  }
  const fact = realizationFactFor(descriptor, requirement.capabilityId, requirement.capabilityKind);
  const declaredDetail =
    `runtime '${binding.runtime}' declares '${binding.strength}' via '${binding.mechanism}', ` +
    `and adapter '${descriptor.adapterId}' ${fact.limitation ?? `realizes '${fact.strength}'`}`;
  return {
    strength: fact.strength,
    mechanism: fact.mechanism,
    dimension: fact.dimension,
    reason: binding.notes ? `${declaredDetail}: ${binding.notes}` : declaredDetail,
  };
}

function dimensionFor(kind: CapabilityRequirementIr["capabilityKind"]): CapabilityRealizationFact["dimension"] {
  return kind === "skill" ? "delivered" : kind === "tool" ? "exposed" : "connected";
}

function failedReport(
  harnessId: string,
  runtime: string,
  realizations: Realization[],
  errors: string[],
  warnings: string[] = [],
): ResolutionReport {
  return {
    irVersion: IR_VERSION,
    kind: "resolution-report",
    harnessId,
    runtime,
    status: "failed",
    realizations,
    errors,
    warnings,
  };
}

function compareByKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { STRENGTH_ORDER };
