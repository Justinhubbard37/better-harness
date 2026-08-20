import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

/**
 * Runtime TSX compilation for artifact modules.
 *
 * `esbuild-wasm` is used in `transformSync` mode: it needs no `initialize()`
 * call and spawns no helper process in a plain Node host, so the Studio server
 * can compile on request without a second bundler or a JS fallback transformer.
 *
 * Only single-file transformation is performed. Imports are left as ESM so the
 * browser resolves them, and JSX is lowered to `React.createElement` against the
 * `React` global that the artifact host installs before importing the module.
 */

export interface CompiledArtifactModule {
  code: string;
  map: string;
}

interface EsbuildTransform {
  transformSync(source: string, options: Record<string, unknown>): { code: string; map: string };
}

interface CacheRecord extends CompiledArtifactModule {
  signature: string;
}

const cache = new Map<string, CacheRecord>();
let loaded: EsbuildTransform | undefined;

/** Number of compiles performed; exported so tests can prove caching. */
let compileCount = 0;

export function artifactCompileCount(): number {
  return compileCount;
}

export function resetArtifactModuleCache(): void {
  cache.clear();
  compileCount = 0;
}

function loadEsbuild(): EsbuildTransform {
  loaded ??= createRequire(import.meta.url)("esbuild-wasm") as EsbuildTransform;
  return loaded;
}

/**
 * Drop imports the host satisfies through globals. Artifact authors may write
 * `import React from "react"`, but the compiled output targets the injected
 * global, so leaving the import would make the browser fetch a bare specifier.
 */
export function stripHostProvidedImports(source: string): string {
  return source.replace(
    /^[ \t]*import[ \t]+[\s\S]*?from[ \t]+["']react(?:\/jsx-runtime|\/jsx-dev-runtime|-dom(?:\/client)?)?["'];?[ \t]*\r?\n/gmu,
    "",
  );
}

/**
 * Compile artifact TSX source to an ES module.
 *
 * The sourcemap is returned separately and carries no `sourceMappingURL`
 * comment: only the serving route knows the URL the map is reachable at.
 */
export function compileArtifactSource(source: string, sourcefile: string): CompiledArtifactModule {
  const { transformSync } = loadEsbuild();
  compileCount += 1;
  const result = transformSync(stripHostProvidedImports(source), {
    loader: sourcefile.endsWith(".jsx") ? "jsx" : "tsx",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    format: "esm",
    target: "es2022",
    sourcefile,
    sourcemap: "external",
    sourcesContent: true,
    logLevel: "silent",
  });
  return { code: result.code, map: result.map };
}

/**
 * Compile an artifact file, reusing the previous result while its mtime and
 * size are unchanged.
 */
export async function compileArtifactModule(path: string): Promise<CompiledArtifactModule> {
  const stats = await stat(path);
  const signature = `${stats.mtimeMs}:${stats.size}`;
  const cached = cache.get(path);
  if (cached !== undefined && cached.signature === signature) {
    return { code: cached.code, map: cached.map };
  }
  const compiled = compileArtifactSource(await readFile(path, "utf8"), basename(path));
  cache.set(path, { ...compiled, signature });
  return compiled;
}

/** Normalize an esbuild failure into a single readable message. */
export function formatArtifactCompileError(error: unknown): string {
  const errors = (error as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } }> }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((entry) => {
        const line = entry.location?.line;
        const column = entry.location?.column;
        const position = line === undefined ? "" : ` (${line}:${column ?? 0})`;
        return `${entry.text ?? "Compile error"}${position}`;
      })
      .join("\n");
  }
  return error instanceof Error && error.message ? error.message : String(error);
}
