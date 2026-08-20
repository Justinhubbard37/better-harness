import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

export interface CompiledCanvasViewerModule {
  code: string;
  map: string;
}

interface EsbuildTransform {
  transformSync(source: string, options: Record<string, unknown>): { code: string; map: string };
}

interface CacheRecord extends CompiledCanvasViewerModule {
  signature: string;
}

const viewerCache = new Map<string, CacheRecord>();
let loaded: EsbuildTransform | undefined;
let compileCount = 0;

function loadEsbuild(): EsbuildTransform {
  loaded ??= createRequire(import.meta.url)("esbuild-wasm") as EsbuildTransform;
  return loaded;
}

export function canvasViewerCompileCount(): number {
  return compileCount;
}

export function resetCanvasViewerModuleCache(): void {
  viewerCache.clear();
  compileCount = 0;
}

/** Transform only trusted provisioned Canvas viewer code, preserving imports. */
export async function compileCanvasViewerModule(path: string): Promise<CompiledCanvasViewerModule> {
  const stats = await stat(path);
  const signature = `${stats.mtimeMs}:${stats.size}`;
  const cached = viewerCache.get(path);
  if (cached !== undefined && cached.signature === signature) {
    return { code: cached.code, map: cached.map };
  }
  const { transformSync } = loadEsbuild();
  compileCount += 1;
  const result = transformSync(await readFile(path, "utf8"), {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
    target: "es2022",
    sourcefile: basename(path),
    sourcemap: "external",
    sourcesContent: true,
    logLevel: "silent",
  });
  const compiled = { code: result.code, map: result.map };
  viewerCache.set(path, { ...compiled, signature });
  return compiled;
}

export function formatCanvasViewerCompileError(error: unknown): string {
  const errors = (error as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } }> }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((entry) => {
      const position = entry.location?.line === undefined ? "" : ` (${entry.location.line}:${entry.location.column ?? 0})`;
      return `${entry.text ?? "Compile error"}${position}`;
    }).join("\n");
  }
  return error instanceof Error && error.message ? error.message : String(error);
}
