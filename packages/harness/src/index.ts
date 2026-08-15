export * from "./ir/index.js";
export { canonicalJson, contentHash, sha256Hex } from "./ir/canonical.js";
export {
  compileHarness,
  type CompileDiagnostic,
  type CompileResult,
  type HarnessSource,
} from "./compiler/compile.js";
export { mergePermissions, resolveHarness, type ResolveResult } from "./resolver/resolve.js";
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
