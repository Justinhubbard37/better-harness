import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type {
  ArtifactCapability,
  ArtifactKind,
  ArtifactRendererReference,
} from "../artifact-model.js";
import type { ArtifactEntry } from "./artifact-catalog.js";

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

interface ViewerManifest {
  id?: unknown;
  label?: unknown;
  extensions?: unknown;
  pathGlobs?: unknown;
  dataKey?: unknown;
  overrideBuiltIn?: unknown;
  overridesBuiltIn?: unknown;
}

export interface ArtifactPluginResolution {
  adapter: {
    id: string;
    version: string;
    schemaId: string;
  };
  renderer: ArtifactRendererReference;
  capabilities: ArtifactCapability[];
}

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

export function presentArtifact(entry: ArtifactEntry, viewers: readonly CanvasViewer[]): ArtifactPluginResolution {
  const viewer = matchCanvasViewer(entry, viewers);
  if (viewer?.overrideBuiltIn === true) return canvasPresentation(viewer);
  const native = nativePresentation(entry.kind);
  if (native !== undefined) return native;
  if (viewer !== undefined) return canvasPresentation(viewer);
  return {
    adapter: { id: "studio.raw", version: "1", schemaId: "artifact/raw-v1" },
    renderer: {
      id: "studio.unavailable",
      label: "Unavailable",
      provider: "studio",
      type: "unavailable",
      status: "unavailable",
      reason: "No native renderer or provisioned Qoder Canvas viewer matches this file.",
    },
    capabilities: [],
  };
}

function nativePresentation(kind: ArtifactKind): ArtifactPluginResolution | undefined {
  if (kind === "pptx") {
    return {
      adapter: { id: "studio.pptx-ooxml", version: "1", schemaId: "pptx/v1" },
      renderer: {
        id: "studio.pptx-dom",
        label: "Studio PPTX",
        provider: "studio",
        type: "native",
        status: "ready",
      },
      capabilities: ["navigate", "outline", "search", "select", "thumbnail", "zoom"],
    };
  }
  if (kind === "unknown") return undefined;
  return {
    adapter: { id: "studio.raw", version: "1", schemaId: "artifact/raw-v1" },
    renderer: {
      id: `studio.${kind}`,
      label: nativeRendererLabel(kind),
      provider: "studio",
      type: "native",
      status: "ready",
    },
    capabilities: kind === "image" || kind === "svg" ? ["select", "zoom"] : ["search", "select"],
  };
}

function nativeRendererLabel(kind: Exclude<ArtifactKind, "unknown" | "pptx">): string {
  return ({
    code: "Studio code",
    diff: "Studio diff",
    image: "Studio image",
    json: "Studio JSON",
    svg: "Studio SVG",
    text: "Studio text",
  })[kind];
}

function canvasPresentation(viewer: CanvasViewer): ArtifactPluginResolution {
  if (viewer.scriptPath === undefined || viewer.dataKey === undefined) {
    return {
      adapter: { id: `qoder-canvas.${viewer.id}.sidecar`, version: "1", schemaId: `qoder-canvas/${viewer.id}/v1` },
      renderer: {
        id: `qoder-canvas.${viewer.id}`,
        label: viewer.label,
        provider: "qoder-canvas",
        type: "unavailable",
        status: "unavailable",
        reason: "The matching Qoder Canvas viewer has no target-file data adapter.",
      },
      capabilities: [],
    };
  }
  return {
    adapter: { id: `qoder-canvas.${viewer.id}.sidecar`, version: "1", schemaId: `qoder-canvas/${viewer.id}/v1` },
    renderer: {
      id: `qoder-canvas.${viewer.id}`,
      label: viewer.label,
      provider: "qoder-canvas",
      type: "qoder-canvas",
      status: "ready",
    },
    capabilities: ["navigate", "select", "zoom"],
  };
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
