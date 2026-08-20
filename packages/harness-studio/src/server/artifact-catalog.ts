import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, normalize, resolve, sep } from "node:path";

/** Artifact kinds are inert data presentations; none is executable code. */
export type ArtifactKind = "code" | "diff" | "image" | "json" | "svg" | "text" | "unknown";

export interface ArtifactEntry {
  id: string;
  kind: ArtifactKind;
  label: string;
  path: string;
  size: number;
}

export interface ArtifactDescriptor {
  id: string;
  kind: ArtifactKind;
  label: string;
  size: number;
}

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const KIND_BY_EXTENSION = new Map<string, ArtifactKind>([
  [".tsx", "code"],
  [".jsx", "code"],
  [".ts", "code"],
  [".js", "code"],
  [".mjs", "code"],
  [".css", "code"],
  [".html", "code"],
  [".sh", "code"],
  [".patch", "diff"],
  [".diff", "diff"],
  [".json", "json"],
  [".svg", "svg"],
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".md", "text"],
  [".txt", "text"],
]);

/**
 * Resolve an artifact kind from its path. Unrecognized extensions resolve to
 * `unknown` so the caller renders escaped text rather than guessing a renderer.
 */
export function resolveArtifactKind(path: string): ArtifactKind {
  return KIND_BY_EXTENSION.get(extname(path).toLowerCase()) ?? "unknown";
}

/** Reject anything that is not an opaque catalog id. */
export function assertArtifactId(value: unknown): string {
  if (typeof value !== "string" || !ARTIFACT_ID_PATTERN.test(value)) {
    throw new Error("Artifact id must match /^[A-Za-z0-9_-]+$/.");
  }
  return value;
}

/**
 * Index a directory of run-produced artifacts.
 *
 * Ids are derived from the file name but are treated as opaque afterwards: the
 * only supported way back to a path is through this catalog, so a client can
 * never name a path.
 */
export async function indexArtifactDirectory(directory: string): Promise<ArtifactEntry[]> {
  const root = resolve(directory);
  const physicalRoot = await realpath(root);
  const entries: ArtifactEntry[] = [];
  const used = new Set<string>();
  for (const name of (await readdir(root)).sort()) {
    const path = confineToRoot(root, name);
    const stats = await lstat(path);
    // Artifact directories are data boundaries. Following a symlink would let
    // an otherwise harmless catalog id read bytes outside that boundary.
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const physicalPath = await realpath(path);
    if (!isWithinRoot(physicalRoot, physicalPath)) continue;
    const id = uniqueId(basename(name, extname(name)), used);
    used.add(id);
    entries.push({ id, kind: resolveArtifactKind(name), label: name, path, size: stats.size });
  }
  return entries;
}

function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

export function describeArtifacts(entries: readonly ArtifactEntry[]): ArtifactDescriptor[] {
  return entries.map(({ id, kind, label, size }) => ({ id, kind, label, size }));
}

export function findArtifact(entries: readonly ArtifactEntry[], id: string): ArtifactEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/**
 * Resolve a name under `root` and reject anything that escapes it. The Studio's
 * static handler is rooted at the app directory, so artifacts need their own
 * confinement rather than reusing it.
 */
export function confineToRoot(root: string, name: string): string {
  const resolvedRoot = resolve(root);
  const target = normalize(resolve(resolvedRoot, name));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new Error("Artifact path escapes the artifact directory.");
  }
  return target;
}

function uniqueId(stem: string, used: Set<string>): string {
  const base = stem.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "artifact";
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
