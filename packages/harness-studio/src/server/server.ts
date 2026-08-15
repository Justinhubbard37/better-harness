import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { handleAguiRun, type HarnessUiExecutorFactory } from "@qoder-ai/harness-ui";
import { PiSdkExecutor, QoderSdkExecutor } from "@qoder-ai/harness/exec";

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
  executorFactory?: HarnessUiExecutorFactory;
}

/**
 * The studio host: serves the React bundle, exposes the compare evidence as
 * JSON, and (when a harness is loaded) mounts the same AG-UI endpoint as
 * `@qoder-ai/harness-ui` under `/agui`.
 */
export function createHarnessStudioServer(options: HarnessStudioServerOptions): Server {
  return createServer((request, response) => {
    void route(request, response, options);
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/config") {
    respondJson(response, 200, {
      aguiEnabled: options.harnessSource !== undefined,
      evidenceEnabled: options.evidenceDir !== undefined,
    });
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
  options: HarnessStudioServerOptions & { port?: number; host?: string },
): Promise<StartedHarnessStudioServer> {
  const server = createHarnessStudioServer(options);
  const host = options.host ?? "127.0.0.1";
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
