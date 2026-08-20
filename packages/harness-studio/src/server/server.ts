import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import {
  assertBindAddressAllowed,
  handleAguiRun,
  type HarnessUiExecutorFactory,
} from "@qoder-ai/harness-ui";
import { PiSdkExecutor, QoderSdkExecutor } from "@qoder-ai/harness/exec";
import {
  loadHarnessExperimentManifest,
  runHarnessExperiment,
  type ExperimentRunEvent,
  type HarnessExperimentCompareSet,
  type RunHarnessExperimentOptions,
} from "@qoder-ai/harness/experiment";
import { canLockCompare, countLaneMaterializations } from "../experiment-setup.js";
import type {
  CheckpointSourcePreview,
  ExperimentLockReceipt,
  ResolvedHistoryDraftPreview,
} from "../experiment-setup.js";
import {
  createCheckpointHistoryCatalogAdapter,
  type CheckpointHistoryAdapter,
  type ResolvedCheckpointHistory,
} from "./query/checkpoint-history.js";
import { buildExperimentPreview, readObservedCallsPage } from "./query/experiment-query.js";
import { loadEvidenceVerdict } from "./query/evidence-query.js";
import { extractInspectorReportJson, loadInspectorReport } from "./query/inspector-query.js";
import { ObservedCallIndex } from "./query/observed-call-index.js";
import { lockHistoryExperiment } from "./experiment-lock.js";
import { canonicalToolEvents } from "./experiment-events.js";
import { listRunRecords, parseRunSnapshot, parseSavedRunRecord, readRunRecord, saveRunRecord, type SavedRunRecord } from "./run-log.js";
import {
  activeSourcePath,
  assertSourceSelection,
  describeSources,
  initialActiveSources,
  mergeSourceCatalog,
  startupSource,
  type StudioSourceCandidate,
  type StudioSourceKind,
} from "./source-catalog.js";
import { sessionFromRetainedRun, type DebuggerSession } from "../app/session-debugger-model.js";
import { pickLocalWorkspaceDirectory } from "./native-directory-picker.js";
import {
  assertArtifactId,
  describeArtifacts,
  findArtifact,
  indexArtifactDirectory,
  type ArtifactEntry,
} from "./artifact-catalog.js";
import { compileCanvasViewerModule, formatCanvasViewerCompileError } from "./canvas-viewer-compile.js";
import {
  discoverCanvasViewers,
  matchCanvasViewer,
  presentArtifact,
  type CanvasViewer,
} from "./artifact-viewers.js";
import {
  prepareCanvasViewer,
  resolveCanvasRuntime,
  serveRuntimeFile,
  type CanvasRuntime,
} from "./artifact-viewer-runtime.js";

const builtInExecutorFactory: HarnessUiExecutorFactory = (context) => {
  if (context.runtimeId === "qoder") {
    return new QoderSdkExecutor({ onRunEvent: context.onRunEvent });
  }
  if (context.runtimeId === "pi") {
    return new PiSdkExecutor({ onRunEvent: context.onRunEvent });
  }
  throw new Error(`No built-in executor for runtime '${context.runtimeId}'.`);
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMPORT_FILES = 256;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
const MAX_IMPORT_SESSIONS = 4;
const IMPORT_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_WORKSPACE_FILES = 512;
const MAX_WORKSPACE_SESSIONS = 200;

export interface StudioWorkspaceSessionSummary {
  id: string;
  savedAt: string;
  prompt: string;
  status: "finished" | "error" | "observed";
  toolCallCount: number;
  provider?: string;
  messageCount?: number;
  warningCount?: number;
}

export interface StudioWorkspaceSession {
  summary: StudioWorkspaceSessionSummary;
  debugger: DebuggerSession;
}

export interface StudioWorkspaceProviderDiagnostic {
  provider: string;
  status: "ok" | "no-evidence" | "error";
  discovered: number;
  included: number;
  message?: string;
}

export interface StudioWorkspaceDiscovery {
  label: string;
  sessions: StudioWorkspaceSession[];
  providers?: StudioWorkspaceProviderDiagnostic[];
}

export interface StudioWorkspaceSessionProvider {
  discover(workspacePath: string): Promise<StudioWorkspaceDiscovery>;
}

export interface HarnessStudioServerOptions {
  /** Directory holding the built React app (index.html + assets/). */
  appDir: string;
  /** Self-contained Harness Inspector HTML report mounted read-only at /inspector. */
  inspectorReportPath?: string;
  /** harness-compare evidence directory containing verdict.json. */
  evidenceDir?: string;
  /** `.harness` source text; enables the embedded AG-UI endpoint. */
  harnessSource?: string;
  harnessId?: string;
  runtimeId?: string;
  cwd?: string;
  /** Root a `source`-backed skill's path is locked and delivered against. */
  sourceRoot?: string;
  /** Durable directory for saved Debugger run records (default: .harness-studio-runs under cwd). */
  runDirectory?: string;
  /** Directory of run-produced artifacts exposed read-only under /api/artifacts. */
  artifactDirectory?: string;
  /** Provisioned Canvas format viewers (default: $QODER_HOME/canvas/canvases). */
  canvasViewerRoot?: string;
  /** Canvas SDK checkout used to host trusted format viewers. */
  canvasSdkRoot?: string;
  /** Prebuilt Canvas SDK media directory containing canvas-sdk.js and index-canvas.html. */
  canvasSdkMedia?: string;
  /** Additional bounded source candidates selectable from inside Studio. */
  sourceCatalog?: StudioSourceCandidate[];
  executorFactory?: HarnessUiExecutorFactory;
  /** `harness-experiment.v1` manifest; enables the live three-lane trace view. */
  experimentManifestPath?: string;
  /** Runtime-only trajectory sources, useful for previewing imported host history before it is copied. */
  experimentTrajectoryOverrides?: Record<string, string>;
  /** Adapter-owned browser projection; omitted to use the built-in session-plan adapter. */
  checkpointSourcePreview?: CheckpointSourcePreview;
  /** Optional source-owned history adapter; its opaque ids are the browser contract. */
  checkpointHistoryAdapter?: CheckpointHistoryAdapter;
  /** File-backed first adapter, used when no injected history adapter is supplied. */
  checkpointHistoryCatalogPath?: string;
  /** Durable root for content-addressed locked experiment definitions. */
  experimentLockDirectory?: string;
  /** Test/embedder seam; defaults to the durable content-addressed locker. */
  experimentLocker?: typeof lockHistoryExperiment;
  experimentOutputDirectory?: string;
  experimentRunner?: (options: RunHarnessExperimentOptions) => Promise<HarnessExperimentCompareSet>;
  /** In-process Inspector-style workspace-to-Session discovery capability. */
  workspaceSessionProvider?: StudioWorkspaceSessionProvider;
  /** Test/embedder seam for the server-owned native working-directory chooser. */
  workspaceDirectoryPicker?: () => Promise<string | undefined>;
}

/**
 * The studio host: serves the React bundle, exposes the compare evidence as
 * JSON, and (when a harness is loaded) mounts the same AG-UI endpoint as
 * `@qoder-ai/harness-ui` under `/agui`.
 */
export function createHarnessStudioServer(options: HarnessStudioServerOptions): Server {
  const experimentRuns = new Map<string, AbortController>();
  const startupSources = [
    startupSource("inspector", options.inspectorReportPath),
    startupSource("evidence", options.evidenceDir),
    startupSource("experiment", options.experimentManifestPath),
  ];
  const sourceCatalog = mergeSourceCatalog(startupSources, options.sourceCatalog);
  const activeSources = initialActiveSources(sourceCatalog, {
    inspector: options.inspectorReportPath === undefined ? undefined : "inspector_startup",
    evidence: options.evidenceDir === undefined ? undefined : "evidence_startup",
    experiment: options.experimentManifestPath === undefined ? undefined : "experiment_startup",
  });
  const activeManifestPath = activeSourcePath(sourceCatalog, activeSources, "experiment");
  const state: HarnessStudioState = {
    sourceCatalog,
    activeSources,
    activeManifestPath,
    templateManifestPath: activeManifestPath,
    trajectoryOverrides: options.experimentTrajectoryOverrides,
    historyAdapter: options.checkpointHistoryAdapter
      ?? (options.checkpointHistoryCatalogPath === undefined
        ? undefined
        : createCheckpointHistoryCatalogAdapter(options.checkpointHistoryCatalogPath)),
    observedIndexes: new Map(),
    artifactDirectory: options.artifactDirectory,
    artifactImports: new Map(),
    workspaceImports: new Map(),
    workspaceOpenStage: "idle",
  };
  const server = createServer((request, response) => {
    void route(request, response, options, state, experimentRuns).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      respondJson(response, 500, { error: "Harness Studio could not complete this request." });
    });
  });
  server.once("close", () => {
    void Promise.all([cleanupArtifactImports(state), cleanupWorkspaceImports(state)]);
  });
  return server;
}

interface ArtifactImportSession {
  directory: string;
  fileCount: number;
  totalBytes: number;
  labels: Set<string>;
  expiry: NodeJS.Timeout;
}

interface WorkspaceImportSession {
  directory: string;
  fileCount: number;
  totalBytes: number;
  paths: Set<string>;
  label: string;
  expiry: NodeJS.Timeout;
}

interface StudioWorkspace {
  label: string;
  sessionCount: number;
  omittedCount: number;
  sessions: Map<string, StoredWorkspaceSession>;
  providers: StudioWorkspaceProviderDiagnostic[];
  ownedDirectory?: string;
}

interface StoredWorkspaceSession extends StudioWorkspaceSession {
  retainedRun?: SavedRunRecord;
}

interface HarnessStudioState {
  sourceCatalog: StudioSourceCandidate[];
  activeSources: Partial<Record<StudioSourceKind, string>>;
  activeManifestPath?: string;
  templateManifestPath?: string;
  trajectoryOverrides?: Record<string, string>;
  historyAdapter?: CheckpointHistoryAdapter;
  lockReceipt?: ExperimentLockReceipt;
  observedIndexes: Map<string, ObservedCallIndex>;
  artifactDirectory?: string;
  ownedArtifactDirectory?: string;
  artifactImports: Map<string, ArtifactImportSession>;
  workspace?: StudioWorkspace;
  workspaceImports: Map<string, WorkspaceImportSession>;
  workspaceOpenStage: "idle" | "choosing" | "discovering";
}

function artifactOptions(options: HarnessStudioServerOptions, state: HarnessStudioState): HarnessStudioServerOptions {
  return state.artifactDirectory === options.artifactDirectory
    ? options
    : { ...options, artifactDirectory: state.artifactDirectory };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
  experimentRuns: Map<string, AbortController>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/config") {
    respondJson(response, 200, {
      aguiEnabled: options.harnessSource !== undefined,
      artifactsEnabled: state.artifactDirectory !== undefined,
      evidenceEnabled: activeSourcePath(state.sourceCatalog, state.activeSources, "evidence") !== undefined,
      experimentEnabled: state.activeManifestPath !== undefined,
      historyEnabled: state.historyAdapter !== undefined,
      inspectorEnabled: activeSourcePath(state.sourceCatalog, state.activeSources, "inspector") !== undefined,
      workspaceConnected: state.workspace !== undefined,
      sessionCount: state.workspace?.sessionCount ?? 0,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workspace") {
    respondJson(response, 200, state.workspace === undefined
      ? { connected: false, sessionCount: 0, omittedCount: 0 }
      : { connected: true, label: state.workspace.label, sessionCount: state.workspace.sessionCount, omittedCount: state.workspace.omittedCount, providers: state.workspace.providers });
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/workspace") {
    await disconnectWorkspace(request, response, state);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workspace/open/status") {
    respondJson(response, 200, { stage: state.workspaceOpenStage });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workspace/open") {
    await openWorkspace(request, response, options, state);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workspaces") {
    await createWorkspaceImport(request, response, state, url.searchParams.get("label"));
    return;
  }
  const workspaceImportFile = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/files$/);
  if (request.method === "PUT" && workspaceImportFile !== null) {
    const sessionId = decodeRouteComponent(response, workspaceImportFile[1]!);
    if (sessionId !== undefined) await importWorkspaceFile(request, response, state, sessionId, url.searchParams.get("path"));
    return;
  }
  const workspaceImportCommit = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/commit$/);
  if (request.method === "POST" && workspaceImportCommit !== null) {
    const sessionId = decodeRouteComponent(response, workspaceImportCommit[1]!);
    if (sessionId !== undefined) await commitWorkspaceImport(request, response, state, sessionId);
    return;
  }
  const workspaceImportAbort = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  if (request.method === "DELETE" && workspaceImportAbort !== null) {
    const sessionId = decodeRouteComponent(response, workspaceImportAbort[1]!);
    if (sessionId !== undefined) await abortWorkspaceImport(request, response, state, sessionId);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    await serveWorkspaceSessions(response, state);
    return;
  }
  const workspaceSession = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(debugger))?$/);
  if (request.method === "GET" && workspaceSession !== null) {
    const sessionId = decodeRouteComponent(response, workspaceSession[1]!);
    if (sessionId !== undefined) await serveWorkspaceSession(response, state, sessionId, workspaceSession[2] === "debugger");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session-compare") {
    await serveSessionComparison(response, state, url.searchParams.get("left"), url.searchParams.get("right"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sources") {
    respondJson(response, 200, {
      sources: describeSources(state.sourceCatalog, state.activeSources),
      active: state.activeSources,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sources/select") {
    await selectSource(request, response, state);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/inspector-report") {
    await serveInspectorReportJson(response, activeSourcePath(state.sourceCatalog, state.activeSources, "inspector"));
    return;
  }
  const runRead = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(session))?$/);
  if (url.pathname === "/api/runs" || runRead !== null) {
    const runId = runRead === null ? undefined : decodeRouteComponent(response, runRead[1]!);
    if (runRead === null || runId !== undefined) await routeRuns(request, response, options, url, runId, runRead?.[2] === "session");
    return;
  }
  if (request.method === "GET" && url.pathname === "/inspector") {
    await serveInspectorReport(response, activeSourcePath(state.sourceCatalog, state.activeSources, "inspector"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/checkpoint-history") {
    await serveCheckpointHistory(response, state);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/checkpoint-history/resolve") {
    await resolveCheckpointHistory(request, response, state);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/experiment/lock") {
    await lockCheckpointHistory(request, response, options, state);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/experiment/observed-calls") {
    await serveObservedCalls(response, url, state);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/experiment") {
    await serveExperiment(response, options, state);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/experiment/runs") {
    await streamExperiment(request, response, options, state, experimentRuns);
    return;
  }
  const cancellation = url.pathname.match(/^\/api\/experiment\/runs\/([^/]+)$/);
  if (request.method === "DELETE" && cancellation !== null) {
    const runId = decodeRouteComponent(response, cancellation[1]!);
    if (runId === undefined) return;
    const controller = experimentRuns.get(runId);
    if (controller === undefined) {
      respondJson(response, 404, { error: `Experiment run '${runId}' is not running.` });
    } else {
      controller.abort(new Error("Cancelled from Harness Studio."));
      respondJson(response, 202, { runId, status: "cancelling" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/evidence") {
    await serveEvidence(response, activeSourcePath(state.sourceCatalog, state.activeSources, "evidence"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/artifacts") {
    await serveArtifactCatalog(response, artifactOptions(options, state));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/artifact-imports") {
    await createArtifactImport(request, response, state);
    return;
  }
  const artifactImportFile = url.pathname.match(/^\/api\/artifact-imports\/([^/]+)\/files$/);
  if (request.method === "PUT" && artifactImportFile !== null) {
    const sessionId = decodeRouteComponent(response, artifactImportFile[1]!);
    if (sessionId !== undefined) await importArtifactFile(request, response, state, sessionId, url.searchParams.get("name"));
    return;
  }
  const artifactImportCommit = url.pathname.match(/^\/api\/artifact-imports\/([^/]+)\/commit$/);
  if (request.method === "POST" && artifactImportCommit !== null) {
    const sessionId = decodeRouteComponent(response, artifactImportCommit[1]!);
    if (sessionId !== undefined) await commitArtifactImport(request, response, state, sessionId);
    return;
  }
  const artifactImportAbort = url.pathname.match(/^\/api\/artifact-imports\/([^/]+)$/);
  if (request.method === "DELETE" && artifactImportAbort !== null) {
    const sessionId = decodeRouteComponent(response, artifactImportAbort[1]!);
    if (sessionId !== undefined) await abortArtifactImport(request, response, state, sessionId);
    return;
  }
  const artifactContent = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
  if (request.method === "GET" && artifactContent !== null) {
    const id = decodeRouteComponent(response, artifactContent[1]!);
    if (id !== undefined) await serveArtifactContent(response, state.artifactDirectory, id);
    return;
  }
  const artifactViewer = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/viewer\/(?:index\.html)?$/);
  if (request.method === "GET" && artifactViewer !== null) {
    const id = decodeRouteComponent(response, artifactViewer[1]!);
    if (id !== undefined) await serveArtifactViewer(response, artifactOptions(options, state), id);
    return;
  }
  const artifactViewerModule = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/viewer\/canvas-module\.js(?:\.map)?$/);
  if (request.method === "GET" && artifactViewerModule !== null) {
    const id = decodeRouteComponent(response, artifactViewerModule[1]!);
    if (id !== undefined) await serveArtifactViewerModule(response, artifactOptions(options, state), id, url.pathname.endsWith(".map"));
    return;
  }
  const artifactViewerResource = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/viewer\/(runtime\/.*)$/);
  if (request.method === "GET" && artifactViewerResource !== null) {
    const id = decodeRouteComponent(response, artifactViewerResource[1]!);
    const resource = decodeRouteComponent(response, artifactViewerResource[2]!);
    if (id !== undefined && resource !== undefined) await serveArtifactViewerResource(response, artifactOptions(options, state), id, resource);
    return;
  }
  if (request.method === "GET" && (url.pathname === "/canvas-sdk.js" || url.pathname === "/canvas-sdk.js.map")) {
    await serveCanvasSdk(response, options, url.pathname.endsWith(".map"));
    return;
  }
  if (url.pathname === "/agui" || url.pathname === "/healthz") {
    if (options.harnessSource === undefined) {
      respondJson(response, 404, { error: "No harness loaded; start with --harness <file.harness>." });
      return;
    }
    if (request.method === "POST" && url.pathname === "/agui") {
      await handleAguiRun(request, response, {
        source: options.harnessSource,
        ...(options.harnessId !== undefined ? { harnessId: options.harnessId } : {}),
        ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.sourceRoot !== undefined ? { sourceRoot: options.sourceRoot } : {}),
        executorFactory: options.executorFactory ?? builtInExecutorFactory,
      });
      return;
    }
    respondJson(response, url.pathname === "/healthz" ? 200 : 405, url.pathname === "/healthz"
      ? { ok: true }
      : { error: "Use POST for /agui." });
    return;
  }
  if (request.method === "GET") {
    await serveStatic(response, options.appDir, url.pathname);
    return;
  }
  respondJson(response, 404, { error: `No route for ${request.method} ${url.pathname}` });
}

async function createWorkspaceImport(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  requestedLabel: string | null,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace imports are not allowed." });
    return;
  }
  if (state.workspaceImports.size >= MAX_IMPORT_SESSIONS) {
    respondJson(response, 429, { error: "Too many workspace import sessions are open." });
    return;
  }
  const sessionId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "harness-studio-workspace-"));
  const expiry = setTimeout(() => { void removeWorkspaceImport(state, sessionId); }, IMPORT_SESSION_TTL_MS);
  expiry.unref();
  state.workspaceImports.set(sessionId, {
    directory,
    fileCount: 0,
    totalBytes: 0,
    paths: new Set(),
    label: portableWorkspaceLabel(requestedLabel),
    expiry,
  });
  respondJson(response, 201, { sessionId, maxFiles: MAX_WORKSPACE_FILES, maxBytes: MAX_IMPORT_BYTES });
}

async function openWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace changes are not allowed." });
    return;
  }
  if (options.workspaceSessionProvider === undefined) {
    respondJson(response, 501, { error: "This Studio launcher does not provide workspace Session discovery." });
    return;
  }
  if (state.workspaceOpenStage !== "idle") {
    respondJson(response, 409, { error: "A workspace directory chooser is already open." });
    return;
  }
  state.workspaceOpenStage = "choosing";
  try {
    const selected = await (options.workspaceDirectoryPicker ?? pickLocalWorkspaceDirectory)();
    if (selected === undefined) {
      respondJson(response, 200, { opened: false, cancelled: true });
      return;
    }
    state.workspaceOpenStage = "discovering";
    const workspacePath = await realpath(selected);
    if (!(await stat(workspacePath)).isDirectory()) {
      respondJson(response, 422, { error: "The selected workspace is not a directory." });
      return;
    }
    const discovered = await options.workspaceSessionProvider.discover(workspacePath);
    const sessions = new Map<string, StoredWorkspaceSession>();
    for (const candidate of discovered.sessions.slice(0, MAX_WORKSPACE_SESSIONS)) {
      const normalized = normalizeDiscoveredWorkspaceSession(candidate);
      if (!sessions.has(normalized.summary.id)) sessions.set(normalized.summary.id, normalized);
    }
    const providers = (discovered.providers ?? []).map((provider) => ({
      provider: portableWorkspaceLabel(provider.provider),
      status: provider.status,
      discovered: boundedNonNegativeInteger(provider.discovered),
      included: boundedNonNegativeInteger(provider.included),
      ...(provider.status === "error" ? { message: "Provider discovery failed." } : {}),
    }));
    const previous = state.workspace?.ownedDirectory;
    state.workspace = {
      label: portableWorkspaceLabel(discovered.label),
      sessionCount: sessions.size,
      omittedCount: Math.max(0, discovered.sessions.length - sessions.size),
      sessions,
      providers,
    };
    if (previous !== undefined) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
    respondJson(response, 200, {
      opened: true,
      label: state.workspace.label,
      sessionCount: state.workspace.sessionCount,
      providers,
    });
  } catch {
    respondJson(response, 422, { error: "Studio could not discover Sessions for the selected workspace." });
  } finally {
    state.workspaceOpenStage = "idle";
  }
}

function normalizeDiscoveredWorkspaceSession(candidate: StudioWorkspaceSession): StudioWorkspaceSession {
  const id = String(candidate?.summary?.id ?? "").normalize("NFKC").trim();
  if (id === "" || id.length > 240 || /[\u0000-\u001f\u007f/\\]/u.test(id)) {
    throw new Error("Discovered Session id is not a bounded opaque identifier.");
  }
  const savedAt = new Date(candidate.summary.savedAt);
  if (Number.isNaN(savedAt.valueOf())) throw new Error("Discovered Session requires an observed timestamp.");
  if (candidate.debugger === null || typeof candidate.debugger !== "object" || !Array.isArray(candidate.debugger.events)) {
    throw new Error("Discovered Session requires a debugger projection.");
  }
  return {
    summary: {
      id,
      savedAt: savedAt.toISOString(),
      prompt: String(candidate.summary.prompt || "Untitled Session").slice(0, 500),
      status: ["finished", "error", "observed"].includes(candidate.summary.status) ? candidate.summary.status : "observed",
      toolCallCount: boundedNonNegativeInteger(candidate.summary.toolCallCount),
      ...(candidate.summary.provider === undefined ? {} : { provider: portableWorkspaceLabel(candidate.summary.provider) }),
      ...(candidate.summary.messageCount === undefined ? {} : { messageCount: boundedNonNegativeInteger(candidate.summary.messageCount) }),
      ...(candidate.summary.warningCount === undefined ? {} : { warningCount: boundedNonNegativeInteger(candidate.summary.warningCount) }),
    },
    debugger: candidate.debugger,
  };
}

function boundedNonNegativeInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(numeric))) : 0;
}

async function importWorkspaceFile(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
  requestedPath: string | null,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace imports are not allowed." });
    return;
  }
  const session = workspaceImportSession(state, sessionId);
  if (session === undefined) {
    respondJson(response, 404, { error: "Workspace import session is unavailable." });
    return;
  }
  if (session.fileCount >= MAX_WORKSPACE_FILES) {
    respondJson(response, 413, { error: `Workspace imports are limited to ${MAX_WORKSPACE_FILES} files.` });
    return;
  }
  let relativePath: string;
  try {
    relativePath = portableWorkspacePath(requestedPath);
    if ([...session.paths].some((candidate) => candidate.toLowerCase() === relativePath.toLowerCase())) {
      throw new Error("Workspace file paths must be unique on every supported platform.");
    }
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const declaredBytes = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredBytes) && declaredBytes >= 0 && session.totalBytes + declaredBytes > MAX_IMPORT_BYTES) {
    request.resume();
    respondJson(response, 413, { error: "Workspace import exceeds the 128 MiB aggregate limit." });
    return;
  }
  const chunks: Buffer[] = [];
  let fileBytes = 0;
  const destination = resolve(session.directory, ...relativePath.split("/"));
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fileBytes += bytes.length;
      if (session.totalBytes + fileBytes > MAX_IMPORT_BYTES) throw new Error("Workspace import exceeds the 128 MiB aggregate limit.");
      chunks.push(bytes);
    }
    await mkdir(dirname(destination), { recursive: true });
    const handle = await open(destination, "wx");
    try {
      await handle.writeFile(Buffer.concat(chunks));
    } finally {
      await handle.close();
    }
    session.fileCount += 1;
    session.totalBytes += fileBytes;
    session.paths.add(relativePath);
    respondJson(response, 201, { path: relativePath, size: fileBytes });
  } catch (error) {
    await rm(destination, { force: true });
    respondJson(response, 413, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function commitWorkspaceImport(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace imports are not allowed." });
    return;
  }
  const session = workspaceImportSession(state, sessionId);
  if (session === undefined) {
    respondJson(response, 404, { error: "Workspace import session is unavailable." });
    return;
  }
  const accepted = new Map<string, StoredWorkspaceSession>();
  let omittedCount = 0;
  for (const relativePath of session.paths) {
    if (!/^run_[A-Za-z0-9_-]+\.json$/u.test(basename(relativePath)) || accepted.size >= MAX_WORKSPACE_SESSIONS) {
      omittedCount += 1;
      continue;
    }
    try {
      const sourcePath = resolve(session.directory, ...relativePath.split("/"));
      const record = parseSavedRunRecord(JSON.parse(await readFile(sourcePath, "utf8")));
      if (accepted.has(record.id)) {
        omittedCount += 1;
        continue;
      }
      accepted.set(record.id, {
        summary: {
          id: record.id,
          savedAt: record.savedAt,
          prompt: record.prompt,
          status: record.status,
          toolCallCount: record.toolCallCount,
          provider: "Harness Studio",
          messageCount: record.timeline.filter((item) => item.kind === "message").length,
          warningCount: record.warnings.length,
        },
        debugger: sessionFromRetainedRun(record),
        retainedRun: record,
      });
    } catch {
      omittedCount += 1;
    }
  }
  if (accepted.size === 0) {
    respondJson(response, 422, { error: "No supported retained run records were found in this folder." });
    return;
  }
  clearTimeout(session.expiry);
  state.workspaceImports.delete(sessionId);
  const previous = state.workspace?.ownedDirectory;
  state.workspace = {
    label: session.label,
    sessionCount: accepted.size,
    omittedCount,
    sessions: accepted,
    providers: [{ provider: "Harness Studio", status: "ok", discovered: accepted.size, included: accepted.size }],
    ownedDirectory: session.directory,
  };
  if (previous !== undefined && previous !== session.directory) {
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  respondJson(response, 200, { label: session.label, sessionCount: accepted.size, omittedCount });
}

async function abortWorkspaceImport(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace imports are not allowed." });
    return;
  }
  if (workspaceImportSession(state, sessionId) === undefined) {
    respondJson(response, 404, { error: "Workspace import session is unavailable." });
    return;
  }
  await removeWorkspaceImport(state, sessionId);
  respondJson(response, 200, { aborted: true });
}

async function disconnectWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace changes are not allowed." });
    return;
  }
  const workspace = state.workspace;
  state.workspace = undefined;
  if (workspace?.ownedDirectory !== undefined) await rm(workspace.ownedDirectory, { recursive: true, force: true });
  respondJson(response, 200, { disconnected: workspace !== undefined });
}

function workspaceImportSession(state: HarnessStudioState, sessionId: string): WorkspaceImportSession | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)
    ? state.workspaceImports.get(sessionId)
    : undefined;
}

function portableWorkspaceLabel(value: string | null): string {
  const label = (value ?? "Selected workspace").trim().replace(/[\u0000-\u001f]/gu, " ").slice(0, 80);
  return label || "Selected workspace";
}

function portableWorkspacePath(value: string | null): string {
  if (value === null || value.trim() === "") throw new Error("Workspace file path is required.");
  if (/^(?:\/|[A-Za-z]:[\\/])/u.test(value)) throw new Error("Workspace file path must be relative.");
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 12 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Workspace file path must be a bounded relative path.");
  }
  const portable = segments.map((segment) => {
    const cleaned = segment.replace(/[<>:"|?*\u0000-\u001f]/gu, "-").replace(/[. ]+$/u, "");
    if (cleaned === "") throw new Error("Workspace file path contains an empty portable segment.");
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned) ? `_${cleaned}` : cleaned;
  }).join("/");
  if (portable.length > 320) throw new Error("Workspace file path exceeds the portable length limit.");
  return portable;
}

async function removeWorkspaceImport(state: HarnessStudioState, sessionId: string): Promise<void> {
  const session = state.workspaceImports.get(sessionId);
  if (session === undefined) return;
  clearTimeout(session.expiry);
  state.workspaceImports.delete(sessionId);
  await rm(session.directory, { recursive: true, force: true });
}

async function cleanupWorkspaceImports(state: HarnessStudioState): Promise<void> {
  await Promise.all([...state.workspaceImports.keys()].map((sessionId) => removeWorkspaceImport(state, sessionId)));
  if (state.workspace?.ownedDirectory !== undefined) await rm(state.workspace.ownedDirectory, { recursive: true, force: true });
  state.workspace = undefined;
}

async function serveWorkspaceSessions(response: ServerResponse, state: HarnessStudioState): Promise<void> {
  if (state.workspace === undefined) {
    respondJson(response, 404, { error: "No project workspace is open." });
    return;
  }
  respondJson(response, 200, {
    workspace: { label: state.workspace.label, omittedCount: state.workspace.omittedCount, providers: state.workspace.providers },
    sessions: [...state.workspace.sessions.values()].map((session) => session.summary)
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt)),
  });
}

async function serveWorkspaceSession(
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
  debuggerProjection: boolean,
): Promise<void> {
  if (state.workspace === undefined) {
    respondJson(response, 404, { error: "No project workspace is open." });
    return;
  }
  const session = state.workspace.sessions.get(sessionId);
  if (session === undefined) {
    respondJson(response, 404, { error: `Session '${sessionId}' is not available in the current workspace.` });
    return;
  }
  respondJson(response, 200, debuggerProjection ? session.debugger : session.retainedRun ?? session.summary);
}

async function serveSessionComparison(
  response: ServerResponse,
  state: HarnessStudioState,
  leftId: string | null,
  rightId: string | null,
): Promise<void> {
  if (state.workspace === undefined) {
    respondJson(response, 404, { error: "No project workspace is open." });
    return;
  }
  if (leftId === null || rightId === null || leftId === rightId) {
    respondJson(response, 400, { error: "Choose two different sessions to compare." });
    return;
  }
  const left = state.workspace.sessions.get(leftId);
  const right = state.workspace.sessions.get(rightId);
  if (left === undefined || right === undefined) {
    respondJson(response, 404, { error: "One or both sessions are unavailable in the current workspace." });
    return;
  }
  respondJson(response, 200, {
    kind: "observational-session-compare.v1",
    boundary: "Observed retained evidence only; no winner is inferred.",
    left: sessionComparisonSide(left),
    right: sessionComparisonSide(right),
  });
}

function sessionComparisonSide(session: StoredWorkspaceSession): Record<string, unknown> {
  const tools = session.debugger.events.flatMap((event) => event.toolCalls ?? []);
  const messages = session.summary.messageCount
    ?? session.debugger.events.filter((event) => event.kind === "prompt" || event.kind === "response").length;
  return {
    id: session.summary.id,
    prompt: session.summary.prompt,
    savedAt: session.summary.savedAt,
    status: session.summary.status,
    retainedEventCount: session.debugger.events.length,
    toolCallCount: session.summary.toolCallCount,
    messageCount: messages,
    warningCount: session.summary.warningCount ?? 0,
    toolSequence: tools.map((tool) => tool.name),
  };
}

async function createArtifactImport(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin artifact imports are not allowed." });
    return;
  }
  if (state.artifactImports.size >= MAX_IMPORT_SESSIONS) {
    respondJson(response, 429, { error: "Too many artifact import sessions are open." });
    return;
  }
  const sessionId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "harness-studio-import-"));
  const expiry = setTimeout(() => { void removeArtifactImport(state, sessionId); }, IMPORT_SESSION_TTL_MS);
  expiry.unref();
  state.artifactImports.set(sessionId, { directory, fileCount: 0, totalBytes: 0, labels: new Set(), expiry });
  respondJson(response, 201, { sessionId, maxFiles: MAX_IMPORT_FILES, maxBytes: MAX_IMPORT_BYTES });
}

async function importArtifactFile(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
  requestedName: string | null,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin artifact imports are not allowed." });
    return;
  }
  const session = artifactImportSession(state, sessionId);
  if (session === undefined) {
    respondJson(response, 404, { error: "Artifact import session is unavailable." });
    return;
  }
  if (session.fileCount >= MAX_IMPORT_FILES) {
    respondJson(response, 413, { error: `Artifact imports are limited to ${MAX_IMPORT_FILES} files.` });
    return;
  }
  const declaredBytes = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredBytes) && declaredBytes >= 0 && session.totalBytes + declaredBytes > MAX_IMPORT_BYTES) {
    request.resume();
    respondJson(response, 413, { error: "Artifact import exceeds the 128 MiB aggregate limit." });
    return;
  }
  let label: string;
  try {
    label = uniqueImportLabel(portableImportLabel(requestedName), session.labels);
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const chunks: Buffer[] = [];
  let fileBytes = 0;
  let destination: string | undefined;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fileBytes += bytes.length;
      if (session.totalBytes + fileBytes > MAX_IMPORT_BYTES) throw new Error("Artifact import exceeds the 128 MiB aggregate limit.");
      chunks.push(bytes);
    }
    destination = join(session.directory, label);
    const handle = await open(destination, "wx");
    try {
      await handle.writeFile(Buffer.concat(chunks));
    } finally {
      await handle.close();
    }
    session.fileCount += 1;
    session.totalBytes += fileBytes;
    session.labels.add(label.toLowerCase());
    respondJson(response, 201, { label, size: fileBytes });
  } catch (error) {
    if (destination !== undefined) await rm(destination, { force: true });
    respondJson(response, 413, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function commitArtifactImport(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin artifact imports are not allowed." });
    return;
  }
  const session = artifactImportSession(state, sessionId);
  if (session === undefined) {
    respondJson(response, 404, { error: "Artifact import session is unavailable." });
    return;
  }
  if (session.fileCount === 0) {
    respondJson(response, 400, { error: "Select at least one artifact before committing the import." });
    return;
  }
  clearTimeout(session.expiry);
  state.artifactImports.delete(sessionId);
  const previous = state.ownedArtifactDirectory;
  state.artifactDirectory = session.directory;
  state.ownedArtifactDirectory = session.directory;
  if (previous !== undefined && previous !== session.directory) {
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  respondJson(response, 200, { imported: session.fileCount, totalBytes: session.totalBytes });
}

async function abortArtifactImport(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
  sessionId: string,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin artifact imports are not allowed." });
    return;
  }
  if (artifactImportSession(state, sessionId) === undefined) {
    respondJson(response, 404, { error: "Artifact import session is unavailable." });
    return;
  }
  await removeArtifactImport(state, sessionId);
  respondJson(response, 200, { aborted: true });
}

function artifactImportSession(state: HarnessStudioState, sessionId: string): ArtifactImportSession | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)
    ? state.artifactImports.get(sessionId)
    : undefined;
}

function portableImportLabel(value: string | null): string {
  if (value === null || value.trim() === "") throw new Error("Artifact file name is required.");
  const segments = value.replaceAll("\\", "/").split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Artifact file name must not contain traversal segments.");
  }
  const flattened = segments.join("--")
    .replace(/[<>:"|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/u, "")
    .slice(0, 180);
  if (flattened === "") throw new Error("Artifact file name has no portable characters.");
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(flattened) ? `_${flattened}` : flattened;
}

function uniqueImportLabel(label: string, used: ReadonlySet<string>): string {
  if (!used.has(label.toLowerCase())) return label;
  const extension = extname(label);
  const stem = label.slice(0, label.length - extension.length);
  for (let suffix = 2; suffix <= MAX_IMPORT_FILES; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("Artifact file name cannot be made unique.");
}

async function removeArtifactImport(state: HarnessStudioState, sessionId: string): Promise<void> {
  const session = state.artifactImports.get(sessionId);
  if (session === undefined) return;
  clearTimeout(session.expiry);
  state.artifactImports.delete(sessionId);
  await rm(session.directory, { recursive: true, force: true });
}

async function cleanupArtifactImports(state: HarnessStudioState): Promise<void> {
  await Promise.all([...state.artifactImports.keys()].map((sessionId) => removeArtifactImport(state, sessionId)));
  if (state.ownedArtifactDirectory !== undefined) {
    await rm(state.ownedArtifactDirectory, { recursive: true, force: true });
    state.ownedArtifactDirectory = undefined;
  }
}

/**
 * Resolve an artifact through the catalog. The client only ever names an opaque
 * id, so no request can turn into a filesystem path of its own choosing.
 */
async function resolveArtifactEntry(
  directory: string | undefined,
  id: string,
): Promise<{ entry: ArtifactEntry } | { error: string; status: number }> {
  if (directory === undefined) {
    return { error: "No artifact set loaded; choose files or a folder in Artifacts.", status: 404 };
  }
  try {
    assertArtifactId(id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), status: 400 };
  }
  let indexed: ArtifactEntry[];
  try {
    indexed = await indexArtifactDirectory(directory);
  } catch {
    // A directory that vanished or turned unreadable after startup must answer
    // with a status, not reject out of the route handler and take the server
    // down. The message stays generic so no filesystem path reaches the client.
    return { error: "Cannot read the configured artifact directory.", status: 404 };
  }
  const entry = findArtifact(indexed, id);
  if (entry === undefined) {
    return { error: `No artifact '${id}'.`, status: 404 };
  }
  return { entry };
}

async function serveArtifactCatalog(response: ServerResponse, options: HarnessStudioServerOptions): Promise<void> {
  if (options.artifactDirectory === undefined) {
    respondJson(response, 404, { error: "No artifact set loaded; choose files or a folder in Artifacts." });
    return;
  }
  try {
    const [entries, viewers] = await Promise.all([
      indexArtifactDirectory(options.artifactDirectory),
      discoverCanvasViewers(options.canvasViewerRoot),
    ]);
    respondJson(response, 200, {
      artifacts: describeArtifacts(entries).map((descriptor, index) => ({
        ...descriptor,
        ...presentArtifact(entries[index]!, viewers),
      })),
    });
  } catch {
    respondJson(response, 404, { error: "Cannot read the configured artifact directory." });
  }
}

/**
 * Artifact module responses are read from an opaque origin, so both the success
 * and the failure body need CORS: without it the host frame sees only a generic
 * "failed to fetch dynamically imported module" and the compile diagnostic is
 * lost before it reaches the reader.
 */
function respondArtifactJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function serveArtifactContent(
  response: ServerResponse,
  directory: string | undefined,
  id: string,
): Promise<void> {
  const resolved = await resolveArtifactEntry(directory, id);
  if ("error" in resolved) {
    respondArtifactJson(response, resolved.status, { error: resolved.error });
    return;
  }
  try {
    const stats = await stat(resolved.entry.path);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(resolved.entry.label).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(resolved.entry.path).pipe(response);
  } catch {
    respondArtifactJson(response, 404, { error: `Artifact '${id}' is no longer readable.` });
  }
}

async function resolveArtifactViewer(
  options: HarnessStudioServerOptions,
  id: string,
): Promise<{ entry: ArtifactEntry; viewer: CanvasViewer; runtime: CanvasRuntime } | { error: string; status: number }> {
  const resolved = await resolveArtifactEntry(options.artifactDirectory, id);
  if ("error" in resolved) return resolved;
  const viewers = await discoverCanvasViewers(options.canvasViewerRoot);
  const viewer = matchCanvasViewer(resolved.entry, viewers);
  if (viewer === undefined || presentArtifact(resolved.entry, viewers).renderer !== "canvas") {
    return { error: `Artifact '${id}' has no Canvas viewer.`, status: 415 };
  }
  const runtime = resolveCanvasRuntime({ sdkRoot: options.canvasSdkRoot, sdkMedia: options.canvasSdkMedia, cwd: options.cwd });
  if (runtime === undefined) return { error: "Canvas SDK runtime is unavailable.", status: 503 };
  return { entry: resolved.entry, viewer, runtime };
}

async function serveArtifactViewer(
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  id: string,
): Promise<void> {
  const resolved = await resolveArtifactViewer(options, id);
  if ("error" in resolved) {
    respondArtifactJson(response, resolved.status, { error: resolved.error });
    return;
  }
  try {
    const prepared = await prepareCanvasViewer(
      resolved.entry,
      resolved.viewer,
      resolved.runtime,
      `/api/artifacts/${id}/viewer/canvas-module.js?v=1`,
    );
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:;",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(prepared.html);
  } catch (error) {
    respondArtifactJson(response, 422, { error: formatCanvasViewerCompileError(error) });
  }
}

async function serveArtifactViewerModule(
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  id: string,
  map: boolean,
): Promise<void> {
  const resolved = await resolveArtifactViewer(options, id);
  if ("error" in resolved) {
    respondArtifactJson(response, resolved.status, { error: resolved.error });
    return;
  }
  try {
    const compiled = await compileCanvasViewerModule(resolved.viewer.modulePath);
    if (map) {
      respondArtifactJson(response, 200, JSON.parse(compiled.map));
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[".js"]!,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(`${compiled.code}//# sourceMappingURL=canvas-module.js.map\n`);
  } catch (error) {
    respondArtifactJson(response, 422, { error: formatCanvasViewerCompileError(error) });
  }
}

async function serveCanvasSdk(response: ServerResponse, options: HarnessStudioServerOptions, map: boolean): Promise<void> {
  const runtime = resolveCanvasRuntime({ sdkRoot: options.canvasSdkRoot, sdkMedia: options.canvasSdkMedia, cwd: options.cwd });
  const path = map ? runtime?.sdkMapPath : runtime?.sdkPath;
  if (path === undefined) {
    respondArtifactJson(response, 404, { error: "Canvas SDK runtime asset is unavailable." });
    return;
  }
  await serveRuntimeFile(response, path, map ? "application/json" : CONTENT_TYPES[".js"]!);
}

async function serveArtifactViewerResource(
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  id: string,
  resource: string,
): Promise<void> {
  const resolved = await resolveArtifactViewer(options, id);
  if ("error" in resolved) {
    respondArtifactJson(response, resolved.status, { error: resolved.error });
    return;
  }
  const root = await realpath(resolved.viewer.rootPath);
  const candidate = resolve(root, resource);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    respondArtifactJson(response, 400, { error: "Canvas viewer resource escapes its viewer root." });
    return;
  }
  try {
    const physical = await realpath(candidate);
    if (physical !== root && !physical.startsWith(root + sep)) throw new Error("escape");
    await serveRuntimeFile(response, physical, CONTENT_TYPES[extname(physical).toLowerCase()] ?? "application/octet-stream");
  } catch {
    respondArtifactJson(response, 404, { error: "Canvas viewer resource is unavailable." });
  }
}

function decodeRouteComponent(response: ServerResponse, value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    respondJson(response, 400, { error: "Malformed URL path segment." });
    return undefined;
  }
}

async function serveInspectorReport(response: ServerResponse, reportPath: string | undefined): Promise<void> {
  if (reportPath === undefined) {
    respondJson(response, 404, {
      error: "No Inspector report loaded; start with --inspector <report.html>.",
    });
    return;
  }
  try {
    const html = await loadInspectorReport(reportPath);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(html);
  } catch {
    respondJson(response, 404, {
      error: "Cannot read the configured Inspector report.",
    });
  }
}

async function serveInspectorReportJson(response: ServerResponse, reportPath: string | undefined): Promise<void> {
  if (reportPath === undefined) {
    respondJson(response, 404, {
      error: "No Inspector report loaded; start with --inspector <report.html>.",
    });
    return;
  }
  try {
    const html = await loadInspectorReport(reportPath);
    let json: string;
    try {
      json = extractInspectorReportJson(html);
    } catch {
      response.writeHead(204, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(`${json}\n`);
  } catch {
    respondJson(response, 404, {
      error: "Cannot read the configured Inspector report.",
    });
  }
}

async function serveExperiment(
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
): Promise<void> {
  const manifestPath = state.activeManifestPath;
  if (manifestPath === undefined) {
    respondJson(response, 404, { error: "No experiment loaded; start with --experiment <experiment.json>." });
    return;
  }
  try {
    respondJson(response, 200, await buildExperimentPreview({
      manifestPath,
      trajectoryOverrides: state.trajectoryOverrides,
      checkpointSourcePreview: state.lockReceipt === undefined ? options.checkpointSourcePreview : undefined,
      lockReceipt: state.lockReceipt,
      observedIndexes: state.observedIndexes,
    }));
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function serveCheckpointHistory(response: ServerResponse, state: HarnessStudioState): Promise<void> {
  if (state.historyAdapter === undefined) {
    respondJson(response, 404, { error: "No checkpoint history adapter is configured." });
    return;
  }
  try {
    respondJson(response, 200, await state.historyAdapter.list());
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function resolveCheckpointHistory(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin checkpoint resolution is not allowed." });
    return;
  }
  if (state.historyAdapter === undefined || state.templateManifestPath === undefined) {
    respondJson(response, 404, { error: "Checkpoint history requires both an adapter and an experiment template." });
    return;
  }
  try {
    const id = historyId(await readJsonBody(request));
    const loaded = await loadHarnessExperimentManifest(state.templateManifestPath);
    const resolved = await state.historyAdapter.resolve(id, countLaneMaterializations(loaded.value.lanes));
    respondJson(response, 200, historyDraftPreview(loaded.value.lanes, resolved));
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function lockCheckpointHistory(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin experiment locking is not allowed." });
    return;
  }
  if (state.historyAdapter === undefined || state.templateManifestPath === undefined) {
    respondJson(response, 404, { error: "Checkpoint history requires both an adapter and an experiment template." });
    return;
  }
  try {
    const id = historyId(await readJsonBody(request));
    const template = await loadHarnessExperimentManifest(state.templateManifestPath);
    const resolved = await state.historyAdapter.resolve(id, countLaneMaterializations(template.value.lanes));
    const locked = await (options.experimentLocker ?? lockHistoryExperiment)({
      templateManifestPath: state.templateManifestPath,
      history: resolved,
      outputRoot: options.experimentLockDirectory
        ?? resolve(dirname(state.templateManifestPath), ".harness-studio-locks"),
    });
    // Build the preview before committing server state so a failed preview
    // leaves the previously loaded experiment fully intact.
    const observedIndexes = new Map<string, ObservedCallIndex>();
    const preview = await buildExperimentPreview({
      manifestPath: locked.manifestPath,
      lockReceipt: locked.receipt,
      observedIndexes,
    });
    for (const index of state.observedIndexes.values()) index.close();
    state.observedIndexes = observedIndexes;
    state.activeManifestPath = locked.manifestPath;
    state.trajectoryOverrides = undefined;
    state.lockReceipt = locked.receipt;
    respondJson(response, 200, preview);
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function historyDraftPreview(
  lanes: Array<{ id: string; origin: "observed" | "execute"; trials?: number }>,
  resolved: ResolvedCheckpointHistory,
): ResolvedHistoryDraftPreview {
  const observed = lanes.find((lane) => lane.origin === "observed");
  const missing = [
    ...(!resolved.observed.startCheckpointVerified ? ["startCheckpointDigest"] : []),
    ...(!resolved.request.verified ? ["promptHash"] : []),
    ...(["harnessId", "revisionId", "profile", "model", "environmentReceipt"] as const)
      .filter((key) => resolved.observed.identity?.[key] === undefined),
  ];
  const setup = {
    scenario: "historical-replay" as const,
    checkpointSource: resolved.checkpointSource,
    request: {
      label: "Selected historical request",
      prompt: resolved.request.prompt,
      promptHash: resolved.request.promptHash,
      provenance: resolved.request.verified ? "verified-history" as const : "unverified-history" as const,
      ...(!resolved.request.verified
        ? { limitation: "The history source did not verify that these request bytes produced the observed trajectory." }
        : {}),
    },
    historicalGaps: observed === undefined || missing.length === 0 ? [] : [{ laneId: observed.id, missing }],
  };
  return {
    selection: resolved.item,
    checkpoint: { digest: resolved.checkpointRef.digest },
    setup,
    lockable: canLockCompare(setup),
    ...(resolved.checkpointSource.status === "ready"
      ? {}
      : { limitation: resolved.checkpointSource.limitation ?? "Checkpoint preflight failed." }),
  };
}

function historyId(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("History request body must be an object.");
  }
  const id = (value as { historyId?: unknown }).historyId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("historyId must be an opaque portable id.");
  }
  return id;
}

async function streamExperiment(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
  experimentRuns: Map<string, AbortController>,
): Promise<void> {
  const manifestPath = state.activeManifestPath;
  if (manifestPath === undefined) {
    respondJson(response, 404, { error: "No experiment loaded; start with --experiment <experiment.json>." });
    return;
  }
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin experiment execution is not allowed." });
    return;
  }
  const body = await readJsonBody(request).catch(() => ({})) as { experimentId?: unknown };
  const experimentId = typeof body.experimentId === "string" && /^exp_[A-Za-z0-9_-]+$/.test(body.experimentId)
    ? body.experimentId
    : `exp_${Date.now().toString(36)}`;
  if (experimentRuns.has(experimentId)) {
    respondJson(response, 409, { error: `Experiment '${experimentId}' is already running.` });
    return;
  }
  const controller = new AbortController();
  experimentRuns.set(experimentId, controller);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const sendPayload = (event: unknown): void => {
    response.write(`event: experiment\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const send = (event: ExperimentRunEvent): void => {
    if (event.type !== "lane-event") {
      sendPayload(event);
      return;
    }
    for (const canonical of canonicalToolEvents(event.event)) {
      sendPayload({ ...event, event: canonical });
    }
  };
  try {
    const outputRoot = options.experimentOutputDirectory
      ?? resolve(manifestPath, "..", ".harness-experiments");
    const outputDirectory = resolve(outputRoot, experimentId);
    await (options.experimentRunner ?? runHarnessExperiment)({
      manifestPath,
      outputDirectory,
      experimentId,
      signal: controller.signal,
      onEvent: send,
    });
  } catch (error) {
    send({
      type: controller.signal.aborted ? "experiment-cancelled" : "lane-failed",
      experimentId,
      laneId: null,
      runId: null,
      at: new Date().toISOString(),
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    experimentRuns.delete(experimentId);
    response.end();
  }
}

async function serveObservedCalls(response: ServerResponse, url: URL, state: HarnessStudioState): Promise<void> {
  if (state.activeManifestPath === undefined) {
    respondJson(response, 404, { error: "No experiment is loaded." });
    return;
  }
  try {
    const laneId = url.searchParams.get("laneId") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "100");
    if (!/^[A-Za-z0-9_-]+$/.test(laneId)) throw new Error("laneId must be a portable opaque id.");
    if (!Number.isFinite(limit)) throw new Error("limit must be a finite number.");
    const page = await readObservedCallsPage({
      manifestPath: state.activeManifestPath,
      trajectoryOverrides: state.trajectoryOverrides,
      observedIndexes: state.observedIndexes,
      laneId,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
    });
    respondJson(response, 200, page);
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function selectSource(
  request: IncomingMessage,
  response: ServerResponse,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin source switching is not allowed." });
    return;
  }
  try {
    const selection = assertSourceSelection(await readJsonBody(request));
    const source = state.sourceCatalog.find((candidate) => candidate.kind === selection.kind && candidate.id === selection.sourceId);
    if (source === undefined) {
      respondJson(response, 404, { error: "The requested Studio source is not in the bounded source catalog." });
      return;
    }
    state.activeSources[selection.kind] = source.id;
    if (selection.kind === "experiment") {
      for (const index of state.observedIndexes.values()) index.close();
      state.observedIndexes = new Map();
      state.activeManifestPath = source.path;
      state.templateManifestPath = source.path;
      state.trajectoryOverrides = undefined;
      state.lockReceipt = undefined;
    }
    respondJson(response, 200, {
      sources: describeSources(state.sourceCatalog, state.activeSources),
      active: state.activeSources,
    });
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes = 32_768): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Saved Debugger runs: retained browser-observed AG-UI evidence, one JSON file per run. */
async function routeRuns(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  url: URL,
  runId: string | undefined,
  sessionProjection = false,
): Promise<void> {
  if (options.harnessSource === undefined) {
    respondJson(response, 404, { error: "No harness loaded; saved runs require --harness <file.harness>." });
    return;
  }
  const directory = options.runDirectory ?? resolve(options.cwd ?? process.cwd(), ".harness-studio-runs");
  try {
    if (request.method === "GET" && runId !== undefined) {
      try {
        const record = await readRunRecord(directory, runId);
        respondJson(response, 200, sessionProjection ? sessionFromRetainedRun(record) : record);
      } catch {
        respondJson(response, 404, { error: `Saved run '${runId}' is not available.` });
      }
      return;
    }
    if (request.method === "GET") {
      respondJson(response, 200, { runs: await listRunRecords(directory) });
      return;
    }
    if (request.method === "POST" && runId === undefined) {
      if (!sameOriginRequest(request)) {
        respondJson(response, 403, { error: "Cross-origin run saving is not allowed." });
        return;
      }
      const snapshot = parseRunSnapshot(await readJsonBody(request, 2_000_000));
      respondJson(response, 201, await saveRunRecord(directory, snapshot));
      return;
    }
    respondJson(response, 405, { error: `Use GET or POST for ${url.pathname}.` });
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function sameOriginRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function serveEvidence(response: ServerResponse, evidenceDir: string | undefined): Promise<void> {
  if (evidenceDir === undefined) {
    respondJson(response, 404, { error: "No evidence directory loaded; start with --evidence <dir>." });
    return;
  }
  try {
    const raw = await loadEvidenceVerdict(evidenceDir);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(raw);
  } catch {
    respondJson(response, 404, { error: `No readable verdict.json in '${evidenceDir}'.` });
  }
}

async function serveStatic(response: ServerResponse, appDir: string, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = resolve(appDir);
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(root + sep)) {
    respondJson(response, 403, { error: "Path escapes the app directory." });
    return;
  }
  try {
    const stats = await stat(target);
    if (!stats.isFile()) {
      throw new Error("not a file");
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "Content-Length": stats.size,
    });
    createReadStream(target).pipe(response);
  } catch {
    respondJson(response, 404, { error: `No static asset for '${pathname}'.` });
  }
}

export interface StartedHarnessStudioServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startHarnessStudioServer(
  options: HarnessStudioServerOptions & { port?: number; host?: string; allowRemote?: boolean },
): Promise<StartedHarnessStudioServer> {
  const server = createHarnessStudioServer(options);
  const host = options.host ?? "127.0.0.1";
  // The studio mounts the same unauthenticated AG-UI run endpoint, so it
  // inherits the same bind-address boundary rather than restating it.
  assertBindAddressAllowed(host, options.allowRemote === true);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 0, host, resolvePromise);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        server.closeAllConnections();
      }),
  };
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}
