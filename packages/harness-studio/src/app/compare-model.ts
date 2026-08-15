import { parseHarnessCompareVerdict } from "@qoder-ai/harness/compare/verdict";
import type { HarnessCompareVerdict, VariantAggregate } from "@qoder-ai/harness";

export interface CompareRow {
  variant: "baseline" | "candidate";
  label: string;
  passedTrials: number;
  completedTrials: number;
  passRate: number;
  meanScore: number;
  infrastructureErrors: number;
  totalCostUsd: number;
  totalCredits: number;
}

export interface CompareTrialRow {
  variant: "baseline" | "candidate";
  trial: number;
  harnessId: string;
  runtimeProfile: string;
  classification: string;
  durationMs: number;
  changedFiles: string[];
}

export interface CompareSummary {
  status: HarnessCompareVerdict["status"];
  reason: string;
  manifestHash: string;
  rows: CompareRow[];
  trials: CompareTrialRow[];
}

export class CompareVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompareVerdictError";
  }
}

/** Accept only the frozen `harness-compare-result.v1` evidence schema. */
export function parseVerdict(value: unknown): HarnessCompareVerdict {
  try {
    return parseHarnessCompareVerdict(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CompareVerdictError(detail);
  }
}

/** Derive the table model the Compare view renders. */
export function summarizeVerdict(verdict: HarnessCompareVerdict): CompareSummary {
  const row = (variant: "baseline" | "candidate", label: string, aggregate: VariantAggregate): CompareRow => ({
    variant,
    label,
    passedTrials: aggregate.passedTrials,
    completedTrials: aggregate.completedTrials,
    passRate: aggregate.passRate,
    meanScore: aggregate.meanScore,
    infrastructureErrors: aggregate.infrastructureErrors,
    totalCostUsd: aggregate.totalCostUsd,
    totalCredits: aggregate.totalCredits,
  });
  return {
    status: verdict.status,
    reason: verdict.reason,
    manifestHash: verdict.manifestHash,
    rows: [
      row("baseline", "H0 baseline", verdict.baseline),
      row("candidate", "H1 candidate", verdict.candidate),
    ],
    trials: verdict.trials.map((trial) => ({
      variant: trial.variant,
      trial: trial.trial,
      harnessId: trial.harnessId,
      runtimeProfile: trial.runtimeProfile,
      classification: trial.classification,
      durationMs: trial.durationMs,
      changedFiles: trial.changedFiles,
    })),
  };
}
