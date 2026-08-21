import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, normalize, resolve, sep } from "node:path";
import type {
  ArtifactCatalogResponse,
  ArtifactFamily,
  ArtifactDigest,
  ArtifactKind,
} from "../artifact-catalog-contract.js";
import { ARTIFACT_CATALOG_RESPONSE_KIND } from "../artifact-catalog-contract.js";
import type { ArtifactPluginResolution } from "./artifact-plugin-registry.js";

export type { ArtifactKind } from "../artifact-catalog-contract.js";

export interface ArtifactEntry {
  id: string;
  kind: ArtifactKind;
  label: string;
  path: string;
  size: number;
  digest?: ArtifactDigest;
}

export interface IndexArtifactDirectoryOptions {
  /** Exact-byte SHA-256 digests are required for public revision snapshots. */
  includeDigests?: boolean;
}

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ArtifactFormat {
  kind: ArtifactKind;
  mediaType: string;
  active?: true;
}

const UNKNOWN_FORMAT: ArtifactFormat = { kind: "unknown", mediaType: "application/octet-stream" };

/** One registry owns both renderer classification and advertised content type. */
const FORMAT_BY_EXTENSION = new Map<string, ArtifactFormat>([
  [".css", { kind: "code", mediaType: "text/css; charset=utf-8" }],
  [".diff", { kind: "diff", mediaType: "text/plain; charset=utf-8" }],
  [".docx", { kind: "unknown", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
  [".gif", { kind: "image", mediaType: "image/gif" }],
  [".html", { kind: "code", mediaType: "text/html; charset=utf-8", active: true }],
  [".jpeg", { kind: "image", mediaType: "image/jpeg" }],
  [".jpg", { kind: "image", mediaType: "image/jpeg" }],
  [".js", { kind: "code", mediaType: "text/javascript; charset=utf-8" }],
  [".json", { kind: "json", mediaType: "application/json" }],
  [".jsx", { kind: "code", mediaType: "text/plain; charset=utf-8" }],
  [".lottie", { kind: "unknown", mediaType: "application/zip" }],
  [".mjs", { kind: "code", mediaType: "text/javascript; charset=utf-8" }],
  [".md", { kind: "text", mediaType: "text/markdown; charset=utf-8" }],
  [".patch", { kind: "diff", mediaType: "text/plain; charset=utf-8" }],
  [".pdf", { kind: "unknown", mediaType: "application/pdf" }],
  [".png", { kind: "image", mediaType: "image/png" }],
  [".pptx", { kind: "pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
  [".sh", { kind: "code", mediaType: "text/plain; charset=utf-8" }],
  [".svg", { kind: "svg", mediaType: "image/svg+xml", active: true }],
  [".ts", { kind: "code", mediaType: "text/plain; charset=utf-8" }],
  [".tsx", { kind: "code", mediaType: "text/plain; charset=utf-8" }],
  [".txt", { kind: "text", mediaType: "text/plain; charset=utf-8" }],
  [".webp", { kind: "image", mediaType: "image/webp" }],
  [".xlsx", { kind: "unknown", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
]);

export class ArtifactCatalogContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCatalogContractError";
  }
}

/**
 * Resolve an artifact kind from its path. Unrecognized extensions resolve to
 * `unknown` so the caller renders escaped text rather than guessing a renderer.
 */
export function resolveArtifactKind(path: string): ArtifactKind {
  return resolveArtifactFormat(path).kind;
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
export async function indexArtifactDirectory(
  directory: string,
  options: IndexArtifactDirectoryOptions = {},
): Promise<ArtifactEntry[]> {
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
    const digest = options.includeDigests === true ? await digestFile(path) : undefined;
    entries.push({
      id,
      kind: resolveArtifactKind(name),
      label: name,
      path,
      size: stats.size,
      ...(digest === undefined ? {} : { digest }),
    });
  }
  return entries;
}

function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

export function describeArtifactCatalog(
  entries: readonly ArtifactEntry[],
  presentationFor: (entry: ArtifactEntry) => ArtifactPluginResolution,
  catalogId = "harness-studio-artifacts",
): ArtifactCatalogResponse {
  if (entries.some((entry) => entry.digest === undefined)) {
    throw new ArtifactCatalogContractError("Artifact catalog snapshots require exact-byte digests.");
  }
  const revisionEntries = entries
    .map(({ id, label, size, digest }) => [id, label, size, digest] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const catalogRevision = createHash("sha256")
    .update(JSON.stringify(revisionEntries))
    .digest("hex");
  return {
    kind: ARTIFACT_CATALOG_RESPONSE_KIND,
    snapshot: {
      catalogId,
      revision: `sha256:${catalogRevision}`,
    },
    artifacts: entries.map((entry) => {
      const selected = presentationFor(entry);
      const digest = entry.digest!;
      const snapshotId = `sha256:${createHash("sha256")
        .update(JSON.stringify([digest, selected.adapter.id, selected.adapter.version, selected.adapter.schemaId]))
        .digest("hex")}` as ArtifactDigest;
      return {
        id: entry.id,
        threadId: entry.id,
        kind: entry.kind,
        family: resolveArtifactFamily(entry.label, entry.kind),
        format: resolveArtifactFormatLabel(entry.label, entry.kind),
        backing: "data" as const,
        label: entry.label,
        size: entry.size,
        revision: {
          id: digest,
          digest,
          content: {
            mediaType: resolveArtifactMediaType(entry.label),
            uri: `/api/artifacts/${encodeURIComponent(entry.id)}/content`,
            digest,
          },
        },
        adapter: {
          ...selected.adapter,
          snapshotId,
          snapshotUri: `/api/artifacts/${encodeURIComponent(entry.id)}/snapshot`,
        },
        renderer: selected.renderer,
        capabilities: selected.capabilities,
      };
    }),
  };
}

export function resolveArtifactFamily(path: string, kind = resolveArtifactKind(path)): ArtifactFamily {
  const extension = extname(path).toLowerCase();
  if ([".pptx", ".xlsx", ".docx", ".pdf"].includes(extension)) return "documents";
  if (kind === "image" || kind === "svg") return "images-diagrams";
  if (kind === "json" || extension === ".lottie") return "data";
  if (["code", "diff", "text"].includes(kind)) return "source-text";
  return "other";
}

export function resolveArtifactFormatLabel(path: string, kind = resolveArtifactKind(path)): string {
  const extension = extname(path).toLowerCase();
  const known: Record<string, string> = {
    ".docx": "Word",
    ".lottie": "Lottie",
    ".pdf": "PDF",
    ".pptx": "PowerPoint",
    ".xlsx": "Excel",
  };
  return known[extension] ?? ({
    code: "Source",
    diff: "Diff",
    image: "Image",
    json: "JSON",
    pptx: "PowerPoint",
    svg: "SVG",
    text: extension === ".md" ? "Markdown" : "Text",
    unknown: extension === "" ? "File" : extension.slice(1).toUpperCase(),
  })[kind];
}

export function resolveArtifactMediaType(path: string): string {
  return resolveArtifactFormat(path).mediaType;
}

export function isActiveArtifactContent(path: string): boolean {
  return resolveArtifactFormat(path).active === true;
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

async function digestFile(path: string): Promise<ArtifactDigest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return `sha256:${hash.digest("hex")}`;
}

function resolveArtifactFormat(path: string): ArtifactFormat {
  return FORMAT_BY_EXTENSION.get(extname(path).toLowerCase()) ?? UNKNOWN_FORMAT;
}
