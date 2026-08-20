#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInspectorWorkspaceSessionProvider } from "./inspector-workspace-provider.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { startHarnessStudioServer } = await import(path.join(packageRoot, "dist", "server", "server.js"));
const portIndex = process.argv.indexOf("--port");
const requestedPort = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 3311;
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3311;
const started = await startHarnessStudioServer({
  appDir: path.join(packageRoot, "dist", "app"),
  port,
  workspaceSessionProvider: createInspectorWorkspaceSessionProvider(),
});
process.stdout.write(`Harness Studio workspace: ${started.url}\n`);
