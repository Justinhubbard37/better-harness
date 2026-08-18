import type { DebuggerDiff } from "./session-debugger-model.js";

export type StudioCodeLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "shellscript"
  | "tsx"
  | "typescript";

/** Infer only the bounded language set the Studio can load on demand. */
export function studioCodeLanguage(sourceHint: string): StudioCodeLanguage | undefined {
  const normalized = sourceHint.trim().toLowerCase();
  const name = normalized.split(/[\\/]/).at(-1) ?? normalized;
  if (name === "dockerfile") return "shellscript";
  const extension = name.split(".").at(-1) ?? "";
  return ({
    bash: "shellscript",
    cjs: "javascript",
    css: "css",
    htm: "html",
    html: "html",
    js: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "javascript",
    mjs: "javascript",
    sh: "shellscript",
    ts: "typescript",
    tsx: "tsx",
    zsh: "shellscript",
  } as const)[extension];
}

/** Build one exact, bounded Git patch for the dedicated Diff renderer. */
export function buildDebuggerPatch(diff: DebuggerDiff): string {
  const path = normalizePatchPath(diff.path);
  const oldCount = diff.before.length;
  const newCount = diff.after.length;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${diff.beforeStart},${oldCount} +${diff.afterStart},${newCount} @@`,
    ...diff.before.map((line) => `-${line}`),
    ...diff.after.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function normalizePatchPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
