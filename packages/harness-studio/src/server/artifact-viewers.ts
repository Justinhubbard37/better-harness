import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { ArtifactEntry, ArtifactKind } from "./artifact-catalog.js";

export type ArtifactRenderer = ArtifactKind | "canvas" | "unavailable";

export interface CanvasViewer {
  id: string;
  label: string;
  extensions: string[];
  pathGlobs: string[];
  dataKey?: string;
  overrideBuiltIn: boolean;
  rootPath: string;
  modulePath: string;
  scriptPath?: string;
}

export interface PresentedArtifact {
  renderer: ArtifactRenderer;
  viewerId?: string;
  viewerLabel?: string;
  reason?: string;
}

interface ViewerManifest {
  id?: unknown;
  label?: unknown;
  extensions?: unknown;
  pathGlobs?: unknown;
  dataKey?: unknown;
  overrideBuiltIn?: unknown;
  overridesBuiltIn?: unknown;
}

const DIRECT_RENDERERS = new Set<ArtifactKind>(["code", "diff", "image", "json", "svg", "text"]);

/** Qoder stores provisioned format viewers below the canvas subtree. */
export function defaultCanvasViewerRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const qoderHome = env.QODER_HOME === undefined ? join(home, ".qoder") : resolve(env.QODER_HOME);
  return join(qoderHome, "canvas", "canvases");
}

export async function discoverCanvasViewers(root?: string): Promise<CanvasViewer[]> {
  const roots = root === undefined
    ? [...new Set([defaultCanvasViewerRoot(), join(homedir(), ".qoder", "canvas", "canvases")])]
    : [root];
  const merged = new Map<string, CanvasViewer>();
  for (const candidate of roots) {
    const viewers = await discoverCanvasViewersAt(candidate);
    for (const viewer of viewers) if (!merged.has(viewer.id)) merged.set(viewer.id, viewer);
  }
  return [...merged.values()];
}

async function discoverCanvasViewersAt(root: string): Promise<CanvasViewer[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const viewers: CanvasViewer[] = [];
  for (const name of names.sort()) {
    const viewerRoot = join(root, name);
    try {
      const manifest = JSON.parse(await readFile(join(viewerRoot, "manifest.json"), "utf8")) as ViewerManifest;
      const id = portableString(manifest.id);
      const modulePath = join(viewerRoot, "index.canvas.tsx");
      if (id === undefined || !(await stat(modulePath)).isFile()) continue;
      const candidateScript = join(viewerRoot, "scripts", "index.mjs");
      const scriptPath = await stat(candidateScript).then((value) => value.isFile() ? candidateScript : undefined).catch(() => undefined);
      viewers.push({
        id,
        label: portableString(manifest.label) ?? id,
        extensions: stringArray(manifest.extensions).map(normalizeExtension),
        pathGlobs: stringArray(manifest.pathGlobs),
        ...(portableString(manifest.dataKey) === undefined ? {} : { dataKey: portableString(manifest.dataKey) }),
        overrideBuiltIn: manifest.overrideBuiltIn === true || manifest.overridesBuiltIn === true,
        rootPath: viewerRoot,
        modulePath,
        ...(scriptPath === undefined ? {} : { scriptPath }),
      });
    } catch {
      // A malformed or partially provisioned viewer is unavailable, not fatal
      // to the rest of the artifact catalog.
    }
  }
  return viewers;
}

export function matchCanvasViewer(entry: ArtifactEntry, viewers: readonly CanvasViewer[]): CanvasViewer | undefined {
  const extension = normalizeExtension(extname(entry.label));
  const fileName = basename(entry.label);
  return viewers.find((viewer) => viewer.extensions.includes(extension) || viewer.pathGlobs.some((glob) => matchesPathGlob(fileName, glob)));
}

export function presentArtifact(entry: ArtifactEntry, viewers: readonly CanvasViewer[]): PresentedArtifact {
  const viewer = matchCanvasViewer(entry, viewers);
  if (viewer?.overrideBuiltIn === true) return canvasPresentation(viewer);
  if (DIRECT_RENDERERS.has(entry.kind)) return { renderer: entry.kind };
  if (viewer !== undefined) return canvasPresentation(viewer);
  return { renderer: "unavailable", reason: "No direct renderer or provisioned Canvas viewer matches this file." };
}

function canvasPresentation(viewer: CanvasViewer): PresentedArtifact {
  if (viewer.scriptPath === undefined || viewer.dataKey === undefined) {
    return { renderer: "unavailable", viewerId: viewer.id, viewerLabel: viewer.label, reason: "The matching Canvas viewer has no target-file data adapter." };
  }
  return { renderer: "canvas", viewerId: viewer.id, viewerLabel: viewer.label };
}

function matchesPathGlob(fileName: string, glob: string): boolean {
  const normalized = glob.replaceAll("\\", "/");
  if (normalized.startsWith("**/*.")) return fileName.toLowerCase().endsWith(normalized.slice(4).toLowerCase());
  if (normalized.startsWith("**/")) return fileName === normalized.slice(3);
  return fileName === normalized;
}

function portableString(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._ -]+$/u.test(value) && value.trim() !== "" ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

function normalizeExtension(value: string): string {
  return value.replace(/^\./u, "").toLowerCase();
}
