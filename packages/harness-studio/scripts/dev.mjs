#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildStudioServerRuntime,
  createStudioAppDevelopmentContext,
  packageRoot,
  watchStudioStaticSources,
} from "./app-build.mjs";

const require = createRequire(import.meta.url);

export function studioServerArgv(argv) {
  return [join(packageRoot, "scripts", "start-inspector-workspace.mjs"), ...argv];
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      child.removeListener("exit", onExit);
      rejectPromise(error);
    };
    const onExit = (code, signal) => {
      child.removeListener("error", onError);
      resolvePromise({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

async function compileStudioServer() {
  const typescriptManifest = require("typescript/package.json");
  const tscPath = join(dirname(require.resolve("typescript/package.json")), typescriptManifest.bin.tsc);
  const child = spawn(process.execPath, [tscPath, "--project", join(packageRoot, "tsconfig.json")], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  const result = await waitForChild(child);
  if (result.code !== 0) {
    throw new Error(`Studio TypeScript build failed${result.signal === null ? ` with exit code ${result.code}` : ` after ${result.signal}`}.`);
  }
}

export async function runStudioDevelopmentServer(argv = process.argv.slice(2)) {
  await rm(join(packageRoot, "dist"), { recursive: true, force: true });
  await compileStudioServer();
  await buildStudioServerRuntime();

  let rebuildQueued = false;
  let rebuilding = false;
  const buildContext = await createStudioAppDevelopmentContext({
    onPublished(revision) {
      process.stdout.write(`[studio-dev] browser build ready (revision ${revision})\n`);
    },
  });
  const requestStaticRebuild = async () => {
    rebuildQueued = true;
    if (rebuilding) return;
    rebuilding = true;
    try {
      while (rebuildQueued) {
        rebuildQueued = false;
        try {
          await buildContext.rebuild();
        } catch {
          // esbuild reports the concrete diagnostics and keeps the context alive.
        }
      }
    } finally {
      rebuilding = false;
    }
  };
  const closeStaticWatchers = watchStudioStaticSources(() => {
    void requestStaticRebuild();
  });

  const server = spawn(process.execPath, studioServerArgv(argv), {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  let closePromise;
  const close = async (signal) => {
    closePromise ??= (async () => {
      closeStaticWatchers();
      await buildContext.dispose();
      if (server.exitCode === null && server.signalCode === null) server.kill(signal ?? "SIGTERM");
    })();
    await closePromise;
  };
  let requestedSignal;
  const handleSignal = (signal) => {
    requestedSignal = signal;
    void close(signal);
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTermination = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  let result;
  try {
    result = await waitForChild(server);
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
    await close(requestedSignal);
  }
  if (requestedSignal !== undefined) return requestedSignal === "SIGINT" ? 130 : 143;
  if (result.signal !== null) return result.signal === "SIGINT" ? 130 : 143;
  return result.code ?? 1;
}

const isMain = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runStudioDevelopmentServer().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`[studio-dev] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
