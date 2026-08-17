import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  assertBindAddressAllowed,
  handleAguiRun,
  type HarnessUiExecutorFactory,
} from "@qoder-ai/harness-ui";
import { PiSdkExecutor, QoderSdkExecutor } from "@qoder-ai/harness/exec";
import {
  deriveContrastAttribution,
  loadHarnessExperimentManifest,
  runHarnessExperiment,
  type ExperimentRunEvent,
  type HarnessExperimentCompareSet,
  type RunHarnessExperimentOptions,
} from "@qoder-ai/harness/experiment";

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
  return createServer((request, response) => {
    void route(request, response, options, experimentRuns);
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  experimentRuns: Map<string, AbortController>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/config") {
    respondJson(response, 200, {
      aguiEnabled: options.harnessSource !== undefined,
      evidenceEnabled: options.evidenceDir !== undefined,
      experimentEnabled: options.experimentManifestPath !== undefined,
    });
    return;
  }
  if (url.pathname === "/api/experiment") {
    if (request.method === "GET") {
      await serveExperiment(response, options);
      return;
    }
    if (request.method === "POST") {
      await streamExperiment(request, response, options, experimentRuns);
      return;
    }
  }
  const cancellation = url.pathname.match(/^\/api\/experiment\/([^/]+)$/);
  if (request.method === "DELETE" && cancellation !== null) {
    const experimentId = decodeURIComponent(cancellation[1]!);
    const controller = experimentRuns.get(experimentId);
    if (controller === undefined) {
      respondJson(response, 404, { error: `Experiment '${experimentId}' is not running.` });
    } else {
      controller.abort(new Error("Cancelled from Harness Studio."));
      respondJson(response, 202, { experimentId, status: "cancelling" });
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

async function serveExperiment(response: ServerResponse, options: HarnessStudioServerOptions): Promise<void> {
  const manifestPath = options.experimentManifestPath;
  if (manifestPath === undefined) {
    respondJson(response, 404, { error: "No experiment loaded; start with --experiment <experiment.json>." });
    return;
  }
  try {
    const loaded = await loadHarnessExperimentManifest(manifestPath);
    const observedEvents: Record<string, unknown[]> = {};
    for (const [laneId, trajectory] of Object.entries({
      ...loaded.resolved.trajectories,
      ...options.experimentTrajectoryOverrides,
    })) {
      observedEvents[laneId] = await readJsonLines(trajectory).catch(() => []);
    }
    const prompt = await readFile(loaded.resolved.prompt);
    const attributionContext = {
      taskPromptHash: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
      completeness: { kind: "unverified" as const, reason: "preflight runs when the experiment starts" },
    };
    respondJson(response, 200, {
      manifest: loaded.value,
      checkpoint: {
        digest: loaded.value.checkpointRef.digest,
        plan: loaded.value.checkpointRef.plan,
      },
      contrasts: loaded.value.contrasts.map((contrast) => ({
        id: contrast.id,
        lanes: contrast.lanes,
        attribution: deriveContrastAttribution(loaded.value, contrast, attributionContext),
      })),
      observedEvents,
    });
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function streamExperiment(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  experimentRuns: Map<string, AbortController>,
): Promise<void> {
  if (options.experimentManifestPath === undefined) {
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
  const send = (event: ExperimentRunEvent): void => {
    response.write(`event: experiment\ndata: ${JSON.stringify(event)}\n\n`);
  };
  try {
    const outputRoot = options.experimentOutputDirectory
      ?? resolve(options.experimentManifestPath, "..", ".harness-experiments");
    const outputDirectory = resolve(outputRoot, experimentId);
    await (options.experimentRunner ?? runHarnessExperiment)({
      manifestPath: options.experimentManifestPath,
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

async function readJsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
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
    const raw = await readFile(join(evidenceDir, "verdict.json"), "utf8");
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
