#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInspectorWorkspaceSessionProvider } from "./inspector-workspace-provider.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const { startHarnessStudioServer } = await import(path.join(packageRoot, "dist", "server", "server.js"));
const { createQoderCliIntentAnalyzer } = await import(path.join(packageRoot, "dist", "server", "qoder-intent-analyzer.js"));
const { createBundledAgentCustomizationCollector } = await import(path.join(packageRoot, "dist", "server", "customization-collector.js"));
const portIndex = process.argv.indexOf("--port");
const requestedPort = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 3311;
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3311;
const intentAnalysisEnabled = process.argv.includes("--intent-analysis");
const started = await startHarnessStudioServer({
  appDir: path.join(packageRoot, "dist", "app"),
  port,
  workspaceSessionProvider: createInspectorWorkspaceSessionProvider(),
  customizationCollector: createBundledAgentCustomizationCollector(),
  ...(intentAnalysisEnabled ? { intentAnalyzer: createQoderCliIntentAnalyzer({ pluginRoot: repositoryRoot }) } : {}),
});
process.stdout.write(`Harness Studio workspace: ${started.url}${intentAnalysisEnabled ? " (experimental qoder Intent analysis enabled)" : ""}\n`);
