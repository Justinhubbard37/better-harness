export {
  DEFAULT_COMPARE_DECISION_POLICY,
  MINIMUM_MATCHED_PAIRS_FLOOR,
  aggregateVariant,
  decideVerdict,
  normalizeDecisionPolicy,
  summarizeMatchedPairs,
  type CompareDecisionPolicy,
  type CompareStatus,
  type CompareTreatmentAxis,
  type MatchedPairSummary,
} from "./aggregate.js";
export {
  HarnessCompareManifestSchema,
  loadHarnessCompareManifest,
  resolveHarnessCompareRuntime,
  treatmentAxisFor,
  type HarnessCompareVariant,
  type HarnessCompareManifest,
  type LoadedHarnessCompareManifest,
  type ResolvedHarnessCompareRuntime,
} from "./manifest.js";
export { gradeReadmePackage, type GraderCheck, type ReadmeGrade } from "./grader.js";
export { parseHarnessCompareVerdict } from "./verdict.js";
export {
  createBoundedQoderPermissionCallback,
  type ToolPermissionDecision,
} from "./permissions.js";
export {
  runHarnessComparison,
  type CompareExecutorContext,
  type CompareExecutorFactory,
  type CompareTrialResult,
  type CompareVariant,
  type FileEvidence,
  type HarnessCompareVerdict,
  type TrialClassification,
  type VariantAggregate,
} from "./runner.js";
