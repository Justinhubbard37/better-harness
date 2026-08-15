/**
 * Runtime materialization: turning a resolved revision into observed facts.
 *
 * `resolveHarness` records the desired state. This module records what one
 * adapter actually wired for a specific run, and refuses to start when the
 * revision claims a realization the adapter cannot reproduce — the adapter that
 * runs a revision is the last place a stale realization claim can be caught.
 */
import {
  IR_VERSION,
  type CapabilityMaterialization,
  type HarnessIrBundle,
  type HarnessMaterializationReceipt,
  type HarnessRevision,
  type MaterializationState,
  type PermissionGrant,
  type Realization,
} from "../ir/index.js";
import { strengthIndex } from "../language/harness-validator.js";
import {
  realizationFactFor,
  workflowFactFor,
  type AdapterRealizationDescriptor,
} from "../resolver/adapter-descriptor.js";
import { HarnessCapabilityUnsupportedError } from "./adapter.js";

/**
 * Build the receipt for one revision on one adapter.
 *
 * Throws {@link HarnessCapabilityUnsupportedError} when the adapter cannot
 * reproduce a recorded realization, so a revision resolved against a richer
 * adapter cannot quietly run on a weaker one.
 */
export function prepareMaterialization(
  revision: HarnessRevision,
  bundle: HarnessIrBundle,
  descriptor: AdapterRealizationDescriptor,
): HarnessMaterializationReceipt {
  const warnings: string[] = [];
  const capabilities: CapabilityMaterialization[] = [];
  for (const realization of strictestPerCapability(revision.realization)) {
    const fact = realizationFactFor(
      descriptor,
      realization.capabilityId,
      realization.capabilityKind,
    );
    if (strengthIndex(fact.strength) < strengthIndex(realization.realized)) {
      throw new HarnessCapabilityUnsupportedError(
        descriptor.adapterId,
        `${realization.capabilityKind}:${realization.capabilityId}`,
        `Revision '${revision.revisionId}' records '${realization.capabilityId}' as ` +
          `'${realization.realized}', but ${fact.limitation ?? `this adapter realizes '${fact.strength}'`}.`,
      );
    }
    const state = stateFor(realization);
    if (state !== "materialized" && realization.reason !== undefined) {
      warnings.push(
        `Realization '${realization.capabilityId}' for agent '${realization.agentId}' ` +
          `is ${state}: ${realization.reason}.`,
      );
    }
    capabilities.push({
      capabilityId: realization.capabilityId,
      capabilityKind: realization.capabilityKind,
      dimension: fact.dimension,
      requestedMinimum: realization.requestedMinimum,
      realized: realization.realized,
      state,
      mechanism: realization.materializedMechanism,
      ...(realization.reason !== undefined ? { detail: realization.reason } : {}),
    });
  }

  const workflow = bundle.workflows.find((candidate) => candidate.id === revision.workflow.id);
  const workflowFact = workflowFactFor(
    descriptor,
    workflow ?? {
      irVersion: IR_VERSION,
      kind: "workflow",
      id: revision.workflow.id,
      mode: revision.workflow.mode,
      edges: [],
      events: [],
      stops: [],
    },
    revision.agents.length,
  );
  if (!workflowFact.supported) {
    throw new HarnessCapabilityUnsupportedError(
      descriptor.adapterId,
      "workflow-orchestration",
      `Workflow '${revision.workflow.id}' cannot be orchestrated: ${workflowFact.limitation}.`,
    );
  }
  if (workflowFact.limitation !== undefined) {
    warnings.push(`Workflow '${revision.workflow.id}' is degraded: ${workflowFact.limitation}.`);
  }

  const enforced = revision.requestedPermissions.filter((grant) =>
    descriptor.enforcedPermissionDomains.includes(grant.domain),
  );
  const unenforced = revision.requestedPermissions.filter((grant) => !enforced.includes(grant));
  if (unenforced.length > 0) {
    warnings.push(
      `Adapter '${descriptor.adapterId}' does not enforce ${unenforced.length} requested ` +
        `permission grant(s) on the host runtime: ${describeGrants(unenforced)}.`,
    );
  }

  const settingKeys = revision.settings.map((setting) => setting.key);
  const consumed = settingKeys.filter((key) => descriptor.consumedSettings.includes(key));
  const ignored = settingKeys.filter((key) => !descriptor.consumedSettings.includes(key));
  if (ignored.length > 0) {
    warnings.push(
      `Adapter '${descriptor.adapterId}' ignores ${ignored.length} configured setting(s): ` +
        `${ignored.join(", ")}.`,
    );
  }

  return {
    irVersion: IR_VERSION,
    kind: "materialization-receipt",
    revisionId: revision.revisionId,
    adapter: {
      id: descriptor.adapterId,
      specificationVersion: descriptor.specificationVersion,
    },
    capabilities,
    workflow: {
      id: revision.workflow.id,
      dimension: "orchestrated",
      requestedMode: revision.workflow.mode,
      realizedMode: workflowFact.mode,
      state: workflowFact.limitation === undefined ? "materialized" : "degraded",
      ...(workflowFact.limitation !== undefined ? { detail: workflowFact.limitation } : {}),
    },
    permissions: { requested: [...revision.requestedPermissions], enforced },
    settings: { consumed, ignored },
    warnings,
  };
}

/** Host tool names the receipt says this run really exposes. */
export function exposedHostTools(receipt: HarnessMaterializationReceipt): string[] {
  const tools = receipt.capabilities
    .filter((capability) => capability.capabilityKind === "tool" && capability.mechanism !== null)
    .map((capability) => capability.mechanism as string)
    .filter((mechanism) => mechanism.startsWith("host-tool:"))
    .map((mechanism) => mechanism.slice("host-tool:".length));
  return [...new Set(tools)].sort();
}

/**
 * One receipt entry per capability. Two agents can require the same capability
 * with different minimums; the receipt keeps the strictest requirement so the
 * entry cannot look weaker than the run promised.
 */
function strictestPerCapability(realizations: readonly Realization[]): Realization[] {
  const byCapability = new Map<string, Realization>();
  for (const realization of realizations) {
    const current = byCapability.get(realization.capabilityId);
    if (
      current === undefined ||
      strengthIndex(realization.requestedMinimum) > strengthIndex(current.requestedMinimum) ||
      (stateFor(realization) !== "materialized" && stateFor(current) === "materialized")
    ) {
      byCapability.set(realization.capabilityId, realization);
    }
  }
  return [...byCapability.values()].sort((a, b) =>
    a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0,
  );
}

function stateFor(realization: Realization): MaterializationState {
  return realization.action === "satisfied"
    ? "materialized"
    : realization.action === "degraded"
      ? "degraded"
      : "unsupported";
}

function describeGrants(grants: readonly PermissionGrant[]): string {
  return grants.map((grant) => `${grant.domain} ${grant.access}`).join(", ");
}
