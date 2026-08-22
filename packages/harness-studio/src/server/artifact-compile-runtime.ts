import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { build, type Message, type Plugin } from "esbuild-wasm";
import {
  ARTIFACT_BUILD_SNAPSHOT_KIND,
  type ArtifactBuildDiagnostic,
  type ArtifactBuildSnapshot,
  type ArtifactDescriptor,
  type ArtifactDigest,
} from "../artifact-model.js";
import { digestHex, type ArtifactEntry } from "./artifact-catalog.js";

const COMPILE_RUNTIME_VERSION = "1";
const MAX_SOURCE_FILES = 64;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_LENGTH = 600;
const MAX_RETAINED_BUILDS = 64;
/**
 * Source and output budgets bound how much a build may read and produce, but
 * nothing bounds how long esbuild spends producing it. Without a wall clock a
 * pathological project holds its HTTP request open forever, so the build fails
 * with a diagnostic instead and the next request is free to try again.
 */
const COMPILE_TIMEOUT_MS = 20_000;
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", ".css"] as const;
const ALLOWED_PACKAGES = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client"]);

interface SourceStamp {
  signature: string;
  digest: string;
}

export interface CompiledArtifactPreview {
  snapshot: ArtifactBuildSnapshot;
  code?: string;
  css: string;
  sources: Map<string, SourceStamp>;
}

export interface CompileArtifactPreviewOptions {
  artifactRoot: string;
  entry: ArtifactEntry;
  descriptor: ArtifactDescriptor;
}

const latestByEntry = new Map<string, CompiledArtifactPreview>();
const retainedByBuild = new Map<string, CompiledArtifactPreview>();
const inflightByRevision = new Map<string, Promise<CompiledArtifactPreview>>();
let buildSequence = 0;
let compileCount = 0;

export function artifactCompileCount(): number {
  return compileCount;
}

export function resetArtifactCompileRuntime(): void {
  latestByEntry.clear();
  retainedByBuild.clear();
  inflightByRevision.clear();
  buildSequence = 0;
  compileCount = 0;
}

class ArtifactCompileTimeout extends Error {}

/**
 * Compile one revision at a time.
 *
 * Two Studio tabs, or a build request racing the preview route's own
 * recompilation, otherwise start the same esbuild run twice. The key carries
 * the revision as well as the path: sharing purely by path would hand a caller
 * asking for the newer revision a snapshot stamped with the older one, which
 * its contract check then rejects.
 */
export async function compileArtifactPreview(options: CompileArtifactPreviewOptions): Promise<CompiledArtifactPreview> {
  const cached = latestByEntry.get(options.entry.path);
  if (cached !== undefined
    && cached.snapshot.revisionId === options.descriptor.revision.id
    && await sourcesStillCurrent(cached.sources)) return cached;

  const key = `${options.entry.path}\u0000${options.descriptor.revision.id}`;
  const pending = inflightByRevision.get(key);
  if (pending !== undefined) return pending;
  const compiling = compileArtifactRevision(options).finally(() => inflightByRevision.delete(key));
  inflightByRevision.set(key, compiling);
  return compiling;
}

async function compileArtifactRevision(options: CompileArtifactPreviewOptions): Promise<CompiledArtifactPreview> {
  compileCount += 1;
  const root = await realpath(options.artifactRoot);
  const entryPath = await realpath(options.entry.path);
  if (!isWithin(root, entryPath)) throw new Error("Artifact entry escapes the configured artifact directory.");

  const sources = new Map<string, SourceStamp>();
  let code: string | undefined;
  let css = "";
  let diagnostics: ArtifactBuildDiagnostic[] = [];
  let status: ArtifactBuildSnapshot["status"] = "ready";
  let timedOut = false;
  try {
    const result = await withCompileTimeout(build({
      absWorkingDir: root,
      entryPoints: ["artifact-runtime:entry"],
      bundle: true,
      write: false,
      outfile: "artifact-preview.js",
      format: "iife",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      sourcemap: false,
      legalComments: "none",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [confinedArtifactPlugin(root, entryPath, sources)],
    }));
    diagnostics = result.warnings.map((message) => diagnosticFromMessage(message, root, "warning"));
    for (const output of result.outputFiles) {
      if (output.path.endsWith(".css")) css = output.text;
      else if (output.path.endsWith(".js")) code = output.text;
    }
    if (code === undefined) throw new Error("Artifact compiler produced no JavaScript output.");
    if (Buffer.byteLength(code) + Buffer.byteLength(css) > MAX_OUTPUT_BYTES) {
      throw new Error(`Artifact build exceeds the ${MAX_OUTPUT_BYTES}-byte output limit.`);
    }
  } catch (error) {
    status = "failed";
    timedOut = error instanceof ArtifactCompileTimeout;
    diagnostics = diagnosticsFromError(error, root);
  }

  const buildId = digestBuild(root, options.descriptor, sources, code, css, diagnostics);
  const base = `/api/artifacts/${encodeURIComponent(options.descriptor.id)}/revisions/${digestHex(options.descriptor.revision.id)}`;
  const snapshot: ArtifactBuildSnapshot = {
    kind: ARTIFACT_BUILD_SNAPSHOT_KIND,
    artifactId: options.descriptor.id,
    revisionId: options.descriptor.revision.id,
    buildId,
    sequence: ++buildSequence,
    status,
    runtime: { id: "studio.sandboxed-react", version: COMPILE_RUNTIME_VERSION },
    ...(status === "ready" ? { previewUri: `${base}/builds/${digestHex(buildId)}/preview` } : {}),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
  };
  const compiled = { snapshot, ...(code === undefined ? {} : { code }), css, sources };
  // An abandoned build is still running and still mutating `sources`, so its
  // partial record must not become the answer every later request reuses.
  if (!timedOut) latestByEntry.set(options.entry.path, compiled);
  retainedByBuild.delete(buildId);
  retainedByBuild.set(buildId, compiled);
  while (retainedByBuild.size > MAX_RETAINED_BUILDS) retainedByBuild.delete(retainedByBuild.keys().next().value!);
  return compiled;
}

export function findCompiledArtifactPreview(
  buildId: string,
  artifactId: string,
  revisionId: ArtifactDigest,
): CompiledArtifactPreview | undefined {
  const compiled = retainedByBuild.get(`sha256:${buildId}`);
  return compiled?.snapshot.artifactId === artifactId && compiled.snapshot.revisionId === revisionId ? compiled : undefined;
}

/** Builds the opaque-origin document; execution waits for the host's MessageChannel. */
export function artifactPreviewHtml(compiled: CompiledArtifactPreview): string {
  if (compiled.code === undefined || compiled.snapshot.status !== "ready") throw new Error("Artifact build is not previewable.");
  const identity = JSON.stringify({
    artifactId: compiled.snapshot.artifactId,
    revisionId: compiled.snapshot.revisionId,
    buildId: compiled.snapshot.buildId,
    runtimeId: compiled.snapshot.runtime.id,
  });
  const code = escapeInlineScript(compiled.code);
  const css = compiled.css.replaceAll("</style", "<\\/style");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light;--artifact-canvas:#fff;--artifact-text:#1b2430}:root[data-artifact-theme="dark"]{color-scheme:dark;--artifact-canvas:#101319;--artifact-text:#e8ecf3}html,body,#artifact-root{box-sizing:border-box;width:100%;min-height:100%;margin:0}body{color:var(--artifact-text);background:var(--artifact-canvas);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*,*::before,*::after{box-sizing:inherit}${css}</style></head><body><div id="artifact-root"></div><script type="application/x-artifact-bundle" id="artifact-bundle">${code}</script><script>${previewBootstrap(identity)}</script></body></html>`;
}

/**
 * The preview document's own half of the runtime protocol.
 *
 * A completed mount is not the same claim as a successful render, so the
 * document reports the first failure it observes from any source — React's
 * uncaught render errors, a bundle that will not start, a throw after mount, or
 * a rejected promise — and only claims `renderCompleted` when none arrived.
 * Reporting nothing on a post-mount throw would leave the host showing a ready
 * preview over an empty or broken frame.
 */
function previewBootstrap(identity: string): string {
  return [
    "(()=>{",
    `const expected=${identity};`,
    "let port;let started=false;let reported=false;",
    "const fail=(error)=>{",
    "if(reported||port===undefined)return;",
    "reported=true;",
    "const detail=(error&&error.message)||error;",
    'port.postMessage({...expected,type:"renderFailed",message:String(detail===undefined||detail===null?"Artifact preview failed at runtime.":detail).slice(0,600)});',
    "};",
    "globalThis.__HARNESS_ARTIFACT_FAIL__=fail;",
    'addEventListener("error",(event)=>fail(event.error||event.message));',
    'addEventListener("unhandledrejection",(event)=>fail(event.reason));',
    "const applyTheme=(theme)=>{",
    'if(theme==="dark"||theme==="light")document.documentElement.dataset.artifactTheme=theme;',
    "};",
    "const executeBundle=()=>new Promise((resolveBundle,rejectBundle)=>{",
    'const source=document.getElementById("artifact-bundle").textContent;',
    'const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));',
    'const script=document.createElement("script");',
    "script.src=url;",
    "script.onload=()=>{URL.revokeObjectURL(url);resolveBundle()};",
    'script.onerror=()=>{URL.revokeObjectURL(url);rejectBundle(new Error("Artifact bundle could not start."))};',
    "document.head.append(script)",
    "});",
    'addEventListener("message",(event)=>{',
    "const message=event.data;const incoming=event.ports&&event.ports[0];",
    'if(started||!incoming||!message||message.type!=="runtime.init")return;',
    "if(message.artifactId!==expected.artifactId||message.revisionId!==expected.revisionId",
    "||message.buildId!==expected.buildId||message.runtimeId!==expected.runtimeId)return;",
    "started=true;port=incoming;",
    "applyTheme(message.theme);",
    'port.onmessage=(update)=>{if(update.data&&update.data.type==="runtime.theme")applyTheme(update.data.theme)};',
    "port.start();",
    "executeBundle()",
    '.then(()=>globalThis.__HARNESS_ARTIFACT_MOUNT__(document.getElementById("artifact-root"),expected))',
    ".then(()=>new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame))))",
    '.then(()=>{if(!reported)port.postMessage({...expected,type:"renderCompleted"})})',
    ".catch(fail);",
    "},{once:false});",
    "})();",
  ].join("");
}

function confinedArtifactPlugin(root: string, entryPath: string, sources: Map<string, SourceStamp>): Plugin {
  const require = createRequire(import.meta.url);
  let sourceBytes = 0;
  return {
    name: "studio-confined-artifact",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^artifact-runtime:entry$/ }, () => ({ path: "entry", namespace: "artifact-runtime" }));
      buildApi.onLoad({ filter: /^entry$/, namespace: "artifact-runtime" }, () => ({
        loader: "tsx",
        resolveDir: root,
        contents: [
          'import React from "react";',
          'import { createRoot } from "react-dom/client";',
          'import Artifact from "artifact-entry";',
          // Mount resolves from a committed effect rather than from render(),
          // because a concurrent root schedules its work: returning as soon as
          // render() is called would report a completed render before React had
          // produced any DOM. `onUncaughtError` replaces React's default
          // rethrow, so a component that throws reaches the host as a runtime
          // failure instead of a silently empty frame.
          "globalThis.__HARNESS_ARTIFACT_MOUNT__=(root,context)=>new Promise((settle)=>{",
          "const rendered=typeof Artifact==='function'?React.createElement(Artifact,context):Artifact;",
          "if(rendered==null)throw new Error('Artifact must default-export a React component or element.');",
          "const Committed=()=>{React.useEffect(()=>{settle();},[]);return rendered;};",
          "createRoot(root,{onUncaughtError:(error)=>{globalThis.__HARNESS_ARTIFACT_FAIL__(error);settle();}})",
          ".render(React.createElement(Committed));",
          "});",
        ].join("\n"),
      }));
      buildApi.onResolve({ filter: /^artifact-entry$/ }, () => ({ path: entryPath }));
      buildApi.onResolve({ filter: /^[^./]|^\// }, (args) => {
        if (args.namespace !== "artifact-runtime" && !isWithin(root, args.importer)) return undefined;
        if (!ALLOWED_PACKAGES.has(args.path)) return { errors: [{ text: `Package import '${args.path}' is not available in Artifact Preview.` }] };
        return { path: require.resolve(args.path) };
      });
      buildApi.onResolve({ filter: /^\.{1,2}\// }, async (args) => {
        if (!isWithin(root, args.importer)) return undefined;
        const resolved = await resolveArtifactSource(root, dirname(args.importer), args.path);
        return typeof resolved === "string" ? { path: resolved } : { errors: [{ text: resolved.error }] };
      });
      buildApi.onLoad({ filter: /.*/ }, async (args) => {
        if (!isWithin(root, args.path)) return undefined;
        const stats = await lstat(args.path);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
          return { errors: [{ text: "Artifact imports must resolve to one regular, non-linked file." }] };
        }
        const contents = await readFile(args.path);
        if (!sources.has(args.path)) {
          sourceBytes += contents.byteLength;
          if (sources.size + 1 > MAX_SOURCE_FILES) return { errors: [{ text: `Artifact project exceeds the ${MAX_SOURCE_FILES}-file limit.` }] };
          if (sourceBytes > MAX_SOURCE_BYTES) return { errors: [{ text: `Artifact project exceeds the ${MAX_SOURCE_BYTES}-byte source limit.` }] };
          sources.set(args.path, {
            signature: sourceSignature(stats),
            digest: createHash("sha256").update(contents).digest("hex"),
          });
        }
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };
}

async function resolveArtifactSource(
  root: string,
  importerDirectory: string,
  specifier: string,
): Promise<string | { error: string }> {
  const base = resolve(importerDirectory, specifier);
  if (!isWithin(root, base)) return { error: `Artifact import '${specifier}' escapes the artifact directory.` };
  const candidates = extname(base) === "" ? [base, ...SOURCE_EXTENSIONS.map((extension) => base + extension)] : [base];
  const matches: string[] = [];
  for (const candidate of candidates) {
    try {
      const stats = await lstat(candidate);
      if (stats.isFile() && !stats.isSymbolicLink()) matches.push(candidate);
    } catch {
      // Candidate absence is resolved after all supported extensions are tried.
    }
  }
  if (matches.length === 0) return { error: `Artifact import '${specifier}' does not resolve to a supported source file.` };
  if (matches.length > 1) return { error: `Artifact import '${specifier}' is ambiguous; include its extension.` };
  if (await hasLinkedPathComponent(root, matches[0]!)) {
    return { error: `Artifact import '${specifier}' crosses a symbolic link.` };
  }
  const physical = await realpath(matches[0]!);
  return isWithin(root, physical) ? physical : { error: `Artifact import '${specifier}' escapes the artifact directory.` };
}

async function hasLinkedPathComponent(root: string, path: string): Promise<boolean> {
  const parts = relative(root, path).split(sep).filter((part) => part !== "");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

function loaderFor(path: string): "tsx" | "ts" | "jsx" | "js" | "json" | "css" {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return "tsx";
  if (extension === ".ts") return "ts";
  if (extension === ".jsx") return "jsx";
  if (extension === ".json") return "json";
  if (extension === ".css") return "css";
  return "js";
}

/**
 * esbuild offers no cancellation, so the loser of this race keeps running. That
 * is acceptable because its result is discarded and never cached; what matters
 * is that the request stops waiting. `Promise.race` also observes the abandoned
 * build's eventual rejection, so a late failure cannot surface as an unhandled
 * rejection that takes the Studio process down.
 */
async function withCompileTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ArtifactCompileTimeout(`Artifact build exceeded the ${COMPILE_TIMEOUT_MS}ms compile limit.`)),
        COMPILE_TIMEOUT_MS,
      );
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function sourcesStillCurrent(sources: Map<string, SourceStamp>): Promise<boolean> {
  for (const [path, stamp] of sources) {
    try {
      if (sourceSignature(await lstat(path)) !== stamp.signature) return false;
    } catch {
      return false;
    }
  }
  return sources.size > 0;
}

function sourceSignature(stats: Awaited<ReturnType<typeof lstat>>): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.nlink}`;
}

function digestBuild(
  root: string,
  descriptor: ArtifactDescriptor,
  sources: Map<string, SourceStamp>,
  code: string | undefined,
  css: string,
  diagnostics: ArtifactBuildDiagnostic[],
): ArtifactDigest {
  const sourceDigests = [...sources]
    .map(([path, stamp]) => [relative(root, path).split(sep).join("/"), stamp.digest] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const digest = createHash("sha256").update(JSON.stringify([
    COMPILE_RUNTIME_VERSION,
    descriptor.id,
    descriptor.revision.id,
    sourceDigests,
    code ?? null,
    css,
    diagnostics,
  ])).digest("hex");
  return `sha256:${digest}`;
}

function diagnosticsFromError(error: unknown, root: string): ArtifactBuildDiagnostic[] {
  const messages = (error as { errors?: Message[] }).errors;
  if (Array.isArray(messages) && messages.length > 0) {
    return messages.slice(0, MAX_DIAGNOSTICS).map((message) => diagnosticFromMessage(message, root, "error"));
  }
  return [{ level: "error", message: safeDiagnostic(error instanceof Error ? error.message : String(error), root) }];
}

function diagnosticFromMessage(message: Message, root: string, level: "warning" | "error"): ArtifactBuildDiagnostic {
  const source = message.location?.file;
  return {
    level,
    message: safeDiagnostic(message.text, root),
    ...(source === undefined ? {} : {
      source: !isAbsolute(source) ? source : isWithin(root, source) ? relative(root, source) : `<runtime>/${basename(source)}`,
    }),
    ...(message.location?.line === undefined ? {} : { line: message.location.line }),
    ...(message.location?.column === undefined ? {} : { column: message.location.column }),
  };
}

function safeDiagnostic(message: string, root: string): string {
  return message
    .replaceAll(root, "<artifact-root>")
    .replaceAll(process.cwd(), "<studio>")
    .replaceAll(homedir(), "<home>")
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function isWithin(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
}

function escapeInlineScript(source: string): string {
  return source.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
}
