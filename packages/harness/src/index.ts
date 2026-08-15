export * from "./ir/index.js";
export { canonicalJson, contentHash, sha256Hex } from "./ir/canonical.js";
export {
  assertRevisionAdapter,
  assertRevisionIntegrity,
  computeRevisionId,
  deepFreeze,
  HarnessAdapterMismatchError,
  HarnessRevisionBundleMismatchError,
  HarnessRevisionTamperedError,
  HarnessSourceLockError,
  validateRevisionAgainstBundle,
  type HarnessRevisionBody,
} from "./ir/revision.js";
export {
  compileHarness,
  type CompileDiagnostic,
  type CompileResult,
  type HarnessSource,
} from "./compiler/compile.js";
export {
  materializeAgainstAdapter,
  mergePermissions,
  resolveHarness,
  type AdapterMaterialization,
  type ResolveOptions,
  type ResolveResult,
} from "./resolver/resolve.js";
export {
  describeAdapter,
  PROMPT_ONLY_DESCRIPTOR,
  realizationFactFor,
  workflowFactFor,
  type AdapterMcpSupport,
  type AdapterRealizationDescriptor,
  type AdapterSkillDelivery,
  type CapabilityRealizationFact,
  type WorkflowRealizationFact,
} from "./resolver/adapter-descriptor.js";
export {
  lockCapabilitySources,
  verifyRevisionSourceLocks,
  HarnessSourceRootRequiredError,
  type SourceLockOptions,
} from "./resolver/source-lock.js";
export { STRENGTH_ORDER, strengthIndex } from "./language/harness-validator.js";
export { createHarnessServices, type HarnessServices } from "./language/harness-module.js";
export * from "./exec/index.js";
export * from "./compare/index.js";
export {
  getHarnessHighlighter,
  harnessTextMateGrammar,
  highlightHarness,
  tokenizeHarness,
} from "./highlight/shiki.js";
