import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, normalize, resolve, sep } from "node:path";
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
import { loadInspectorReport } from "./query/inspector-query.js";
import { ObservedCallIndex } from "./query/observed-call-index.js";
import { lockHistoryExperiment } from "./experiment-lock.js";
import { canonicalToolEvents } from "./experiment-events.js";

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
};

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
}

/**
 * The studio host: serves the React bundle, exposes the compare evidence as
 * JSON, and (when a harness is loaded) mounts the same AG-UI endpoint as
 * `@qoder-ai/harness-ui` under `/agui`.
 */
export function createHarnessStudioServer(options: HarnessStudioServerOptions): Server {
  const experimentRuns = new Map<string, AbortController>();
  const state: HarnessStudioState = {
    activeManifestPath: options.experimentManifestPath,
    templateManifestPath: options.experimentManifestPath,
    trajectoryOverrides: options.experimentTrajectoryOverrides,
    historyAdapter: options.checkpointHistoryAdapter
      ?? (options.checkpointHistoryCatalogPath === undefined
        ? undefined
        : createCheckpointHistoryCatalogAdapter(options.checkpointHistoryCatalogPath)),
    observedIndexes: new Map(),
  };
  return createServer((request, response) => {
    void route(request, response, options, state, experimentRuns);
  });
}

interface HarnessStudioState {
  activeManifestPath?: string;
  templateManifestPath?: string;
  trajectoryOverrides?: Record<string, string>;
  historyAdapter?: CheckpointHistoryAdapter;
  lockReceipt?: ExperimentLockReceipt;
  observedIndexes: Map<string, ObservedCallIndex>;
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
      evidenceEnabled: options.evidenceDir !== undefined,
      experimentEnabled: state.activeManifestPath !== undefined,
      historyEnabled: state.historyAdapter !== undefined,
      inspectorEnabled: options.inspectorReportPath !== undefined,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/inspector") {
    await serveInspectorReport(response, options.inspectorReportPath);
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
    const runId = decodeURIComponent(cancellation[1]!);
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
    await serveEvidence(response, options.evidenceDir);
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 32_768) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
