import semver from "semver";
import { contentHash, sha256Hex, canonicalJson } from "../ir/canonical.js";
import { STRENGTH_ORDER, strengthIndex } from "../language/harness-validator.js";
import {
  type CapabilityRequirementIr,
  type ComponentContractIr,
  type HarnessIrBundle,
  type HarnessRevision,
  IR_VERSION,
  type PermissionGrant,
  type PluginManifestIr,
  type Realization,
  type ResolutionReport,
  type TargetBindingIr,
} from "../ir/index.js";

export interface ResolveResult {
  /** Immutable run fact. Only present when the report status is `resolved`. */
  revision?: HarnessRevision;
  /** Always present: requested vs realized strength for every requirement. */
  report: ResolutionReport;
}

/**
 * Resolve a composition against the plugins declared in the bundle.
 *
 * Degradation semantics:
 * A binding declares the strongest mechanism a host can eventually provide.
 * The v0.1 executors materialize every supported binding as prompt guidance,
 * so effective strength is capped at `advisory` until a native artifact and
 * evidence-receipt contract lands.
 *
 * - realized >= preferred (or no preferred): satisfied
 * - minimum <= realized < preferred: degraded; `on-degrade fail` turns the
 *   degradation into a resolution failure instead of a silent prompt
 * - realized < minimum: always a resolution failure
 */
export function resolveComposition(bundle: HarnessIrBundle, compositionId: string): ResolveResult {
  const composition = bundle.compositions.find((candidate) => candidate.id === compositionId);
  if (!composition) {
    return {
      report: failedReport(compositionId, "unknown", [], [
        `Composition '${compositionId}' is not defined in the bundle.`,
      ]),
    };
  }

  const errors: string[] = [];
  const resolvedPlugins: PluginManifestIr[] = [];
  for (const include of composition.includes) {
    const candidates = bundle.plugins.filter((plugin) => plugin.id === include.pluginId);
    if (candidates.length === 0) {
      errors.push(`Plugin '${include.pluginId}' is not available in the registry.`);
      continue;
    }
    const matching = candidates
      .filter((plugin) => satisfiesRange(plugin.version, include.range))
      .sort((a, b) => semver.rcompare(normalizeVersion(a.version), normalizeVersion(b.version)));
    if (matching.length === 0) {
      errors.push(
        `Plugin '${include.pluginId}' has no version satisfying '${include.range}' ` +
          `(available: ${candidates.map((plugin) => plugin.version).join(", ")}).`,
      );
      continue;
    }
    resolvedPlugins.push(matching[0]);
  }

  const enabledComponentIds = new Set(resolvedPlugins.flatMap((plugin) => plugin.provides));
  const enabledComponents = bundle.components.filter((component) =>
    enabledComponentIds.has(component.id),
  );

  const realizations: Realization[] = [];
  for (const requirement of composition.requirements) {
    if (!enabledComponentIds.has(requirement.componentId)) {
      errors.push(
        `Required component '${requirement.componentId}' is not provided by any included plugin.`,
      );
      realizations.push(
        realize(
          requirement,
          undefined,
          materializeV01(undefined),
          "failed",
          "component not provided",
        ),
      );
      continue;
    }
    const binding = bundle.bindings.find(
      (candidate) =>
        candidate.componentId === requirement.componentId && candidate.host === composition.target,
    );
    const materialization = materializeV01(binding);
    const realized = materialization.strength;
    const minimumIndex = strengthIndex(requirement.minimum);
    const realizedIndex = strengthIndex(realized);
    const preferredIndex =
      requirement.preferred !== undefined ? strengthIndex(requirement.preferred) : minimumIndex;

    if (realizedIndex < minimumIndex) {
      errors.push(
        `Component '${requirement.componentId}' realizes '${realized}' on host ` +
          `'${composition.target}', below the required minimum '${requirement.minimum}'.`,
      );
      realizations.push(
        realize(requirement, binding, materialization, "failed", degradeReason(binding, composition.target)),
      );
      continue;
    }
    if (realizedIndex < preferredIndex) {
      const reason = degradeReason(binding, composition.target);
      if (requirement.onDegrade === "fail") {
        errors.push(
          `Component '${requirement.componentId}' realizes '${realized}' on host ` +
            `'${composition.target}', below the preferred '${requirement.preferred}' ` +
            `and the requirement declares 'on-degrade fail'.`,
        );
        realizations.push(realize(requirement, binding, materialization, "failed", reason));
      } else {
        realizations.push(realize(requirement, binding, materialization, "degraded", reason));
      }
      continue;
    }
    realizations.push(realize(requirement, binding, materialization, "satisfied"));
  }

  // Components enabled by resolved plugins without an explicit requirement
  // still belong to the realized surface of the run: record an implicit
  // realization so executors and checkpoints see the full assembly.
  const required = new Set(composition.requirements.map((requirement) => requirement.componentId));
  for (const component of enabledComponents) {
    if (required.has(component.id)) {
      continue;
    }
    const binding = bundle.bindings.find(
      (candidate) => candidate.componentId === component.id && candidate.host === composition.target,
    );
    const materialization = materializeV01(binding);
    const isDegraded =
      !binding ||
      materialization.strength === "unsupported" ||
      strengthIndex(binding.strength) > strengthIndex(materialization.strength);
    realizations.push({
      componentId: component.id,
      requestedMinimum: "unsupported",
      declaredStrength: binding?.strength ?? "unsupported",
      declaredMechanism: binding?.mechanism ?? null,
      realized: materialization.strength,
      materializedMechanism: materialization.mechanism,
      action: isDegraded ? "degraded" : "satisfied",
      reason:
        !binding
          ? `implicitly enabled; host '${composition.target}' has no binding for this component`
          : binding.strength === "unsupported"
            ? `implicitly enabled; host '${composition.target}' declares this component unsupported ` +
              `via '${binding.mechanism}'`
          : isDegraded
            ? `implicitly enabled; declared '${binding.strength}' via '${binding.mechanism}', ` +
              `materialized as '${materialization.strength}' via '${materialization.mechanism}'`
            : "implicitly enabled by an included plugin",
    });
  }
  realizations.sort((a, b) => compareByKey(a.componentId, b.componentId));

  if (errors.length > 0) {
    return { report: failedReport(composition.id, composition.target, realizations, errors) };
  }

  const revisionBody: Omit<HarnessRevision, "revisionId"> = {
    irVersion: IR_VERSION,
    kind: "harness-revision" as const,
    composition: { id: composition.id, contentHash: contentHash(composition) },
    target: { host: composition.target },
    resolved: {
      plugins: resolvedPlugins
        .map((plugin) => ({ id: plugin.id, version: plugin.version, contentHash: contentHash(plugin) }))
        .sort((a, b) => compareByKey(a.id, b.id)),
      components: enabledComponents
        .map((component) => ({ id: component.id, contentHash: contentHash(component) }))
        .sort((a, b) => compareByKey(a.id, b.id)),
    },
    realization: realizations,
    permissions: mergePermissions(enabledComponents),
    settings: composition.settings,
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
      compositionId: composition.id,
      target: composition.target,
      status: "resolved",
      realizations,
      errors: [],
    },
  };
}

/**
 * Merge component permission grants into the revision permission surface.
 * The merge is monotonically tightening: an explicit `deny` on a domain
 * always wins over any grant, regardless of declaration order.
 */
export function mergePermissions(components: ComponentContractIr[]): PermissionGrant[] {
  const byDomain = new Map<PermissionGrant["domain"], Set<PermissionGrant["access"]>>();
  for (const component of components) {
    for (const grant of component.permissions) {
      const accesses = byDomain.get(grant.domain) ?? new Set();
      accesses.add(grant.access);
      byDomain.set(grant.domain, accesses);
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
  requirement: CapabilityRequirementIr,
  binding: TargetBindingIr | undefined,
  materialization: V01Materialization,
  action: Realization["action"],
  reason?: string,
): Realization {
  return {
    componentId: requirement.componentId,
    requestedMinimum: requirement.minimum,
    ...(requirement.preferred !== undefined ? { requestedPreferred: requirement.preferred } : {}),
    declaredStrength: binding?.strength ?? "unsupported",
    declaredMechanism: binding?.mechanism ?? null,
    realized: materialization.strength,
    materializedMechanism: materialization.mechanism,
    action,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function degradeReason(binding: TargetBindingIr | undefined, host: string): string {
  if (!binding) {
    return `host '${host}' has no binding for this component`;
  }
  const detail =
    `host '${host}' declares '${binding.strength}' via '${binding.mechanism}', ` +
    "but the v0.1 executor materializes prompt guidance at 'advisory' strength";
  return binding.notes ? `${detail}: ${binding.notes}` : detail;
}

interface V01Materialization {
  strength: Realization["realized"];
  mechanism: string | null;
}

function materializeV01(binding: TargetBindingIr | undefined): V01Materialization {
  if (!binding || binding.strength === "unsupported") {
    return { strength: "unsupported", mechanism: null };
  }
  return { strength: "advisory", mechanism: "prompt-preamble" };
}

function failedReport(
  compositionId: string,
  target: string,
  realizations: Realization[],
  errors: string[],
): ResolutionReport {
  return {
    irVersion: IR_VERSION,
    kind: "resolution-report",
    compositionId,
    target,
    status: "failed",
    realizations,
    errors,
  };
}

function satisfiesRange(version: string, range: string): boolean {
  const normalized = normalizeVersion(version);
  const validRange = semver.validRange(range);
  return validRange !== null && semver.satisfies(normalized, validRange);
}

function normalizeVersion(version: string): string {
  return semver.coerce(version)?.version ?? version;
}

function compareByKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { STRENGTH_ORDER };
