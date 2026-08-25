import { GitCommitDetail } from "../../contracts/git-history.js";
import { isUserInputTrace, projectUserInputTrace } from "../../contracts/input-trace.js";
import { IntentCorrelationAnalysisV1, IntentCorrelationContractError, validateIntentCorrelationAnalysis } from "../../contracts/intent-correlation.js";
import { validateStudioCustomizationAnalysis } from "../customization-collector.js";
import { sessionFromRetainedRun } from "../debugger-session-transform.js";
import { resolveGitRepositoryRoot } from "../git-history.js";
import { buildIntentCorrelationPacket } from "../intent-correlation.js";
import { parseSavedRunRecord } from "../run-log.js";
import { pickLocalWorkspaceDirectory } from "../workspace/native-directory-picker.js";
import { collectWorkspaceArtifactObservations } from "../workspace/workspace-artifacts.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { IMPORT_SESSION_TTL_MS, MAX_IMPORT_BYTES, MAX_IMPORT_SESSIONS, respondJson, sameOriginRequest } from "../http-utils.js";
import { HarnessStudioServerOptions, HarnessStudioState, StoredWorkspaceSession, StudioWorkspaceSession, WorkspaceImportSession } from "../studio-types.js";

export const MAX_WORKSPACE_FILES = 512;
export const MAX_WORKSPACE_SESSIONS = 200;

export async function createWorkspaceImport(
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
export async function openWorkspace(
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
    const inspectorReport = discovered.inspectorReport === undefined
      ? undefined
      : validWorkspaceInspectorReport(discovered.inspectorReport)
        ? discovered.inspectorReport
        : (() => { throw new Error("Workspace Inspector report is malformed."); })();
    const inputTrace = inspectorReport === undefined ? undefined : projectUserInputTrace(inspectorReport);
    const previous = state.workspace?.ownedDirectory;
    const gitRoot = await resolveGitRepositoryRoot(workspacePath);
    const artifactObservations = await collectWorkspaceArtifactObservations(workspacePath, [...sessions.values()]);
    const artifactPaths = [...new Set(artifactObservations.map((observation) => observation.relativePath))];
    state.workspace = {
      label: portableWorkspaceLabel(discovered.label),
      sessionCount: sessions.size,
      omittedCount: Math.max(0, discovered.sessions.length - sessions.size),
      sessions,
      providers,
      ...(inspectorReport === undefined ? {} : { inspectorReport, inputTrace }),
      localDirectory: workspacePath,
      artifactObservations,
      ...(gitRoot === undefined ? {} : { gitRoot, gitCommitCache: new Map<string, GitCommitDetail>() }),
    };
    state.artifactDirectory = workspacePath;
    state.artifactPaths = artifactPaths;
    state.customizationAnalysis = undefined;
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
function validWorkspaceInspectorReport(report: Record<string, unknown> | undefined): report is Record<string, unknown> {
  return report !== undefined
    && report.kind === "HarnessInspectorReportV1"
    && Array.isArray(report.sessions)
    && Array.isArray(report.days)
    && report.featureTree !== null
    && typeof report.featureTree === "object";
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
export async function importWorkspaceFile(
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
export async function commitWorkspaceImport(
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
  state.customizationAnalysis = undefined;
  if (previous !== undefined && previous !== session.directory) {
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  respondJson(response, 200, { label: session.label, sessionCount: accepted.size, omittedCount });
}
export async function abortWorkspaceImport(
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
export async function disconnectWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin workspace changes are not allowed." });
    return;
  }
  const workspace = state.workspace;
  state.workspace = undefined;
  state.artifactDirectory = options.artifactDirectory;
  state.artifactPaths = options.artifactPaths;
  state.customizationAnalysis = undefined;
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
export async function cleanupWorkspaceImports(state: HarnessStudioState): Promise<void> {
  await Promise.all([...state.workspaceImports.keys()].map((sessionId) => removeWorkspaceImport(state, sessionId)));
  if (state.workspace?.ownedDirectory !== undefined) await rm(state.workspace.ownedDirectory, { recursive: true, force: true });
  state.workspace = undefined;
  state.customizationAnalysis = undefined;
}
export async function serveWorkspaceSessions(response: ServerResponse, state: HarnessStudioState): Promise<void> {
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
export function serveWorkspaceInputs(response: ServerResponse, state: HarnessStudioState): void {
  if (state.workspace === undefined) {
    respondJson(response, 404, { error: "No project workspace is open." });
    return;
  }
  if (state.workspace.inputTrace === undefined) {
    respondJson(response, 404, { error: "The current workspace has no retained user input trace." });
    return;
  }
  if (!isUserInputTrace(state.workspace.inputTrace)) {
    respondJson(response, 500, { error: "The current workspace input trace failed contract validation." });
    return;
  }
  respondJson(response, 200, state.workspace.inputTrace, { "Cache-Control": "no-store" });
}
export function serveWorkspaceCustomizations(response: ServerResponse, state: HarnessStudioState): void {
  if (state.customizationAnalysis === undefined) {
    respondJson(response, 404, { error: "Customizations have not been analyzed for this workspace." });
    return;
  }
  respondJson(response, 200, state.customizationAnalysis, { "Cache-Control": "no-store" });
}
export async function analyzeWorkspaceCustomizations(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin customization analysis is not allowed." });
    return;
  }
  if (options.customizationCollector === undefined) {
    respondJson(response, 501, { error: "This Studio launcher does not provide customization analysis." });
    return;
  }
  const workspacePath = state.workspace === undefined
    ? resolve(options.cwd ?? process.cwd())
    : state.workspace.localDirectory;
  if (workspacePath === undefined) {
    respondJson(response, 422, { error: "An imported run folder cannot be used as a local customization workspace." });
    return;
  }
  if (state.customizationAnalysisRunning) {
    respondJson(response, 409, { error: "Customization analysis is already running." });
    return;
  }
  state.customizationAnalysisRunning = true;
  try {
    const analysis = validateStudioCustomizationAnalysis(
      await options.customizationCollector.analyze(workspacePath),
      [workspacePath],
    );
    state.customizationAnalysis = analysis;
    respondJson(response, 200, analysis, { "Cache-Control": "no-store" });
  } catch {
    respondJson(response, 503, { error: "Customization analysis could not complete for this workspace." }, { "Cache-Control": "no-store" });
  } finally {
    state.customizationAnalysisRunning = false;
  }
}
export async function analyzeWorkspaceIntent(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessStudioServerOptions,
  state: HarnessStudioState,
): Promise<void> {
  if (!sameOriginRequest(request)) {
    respondJson(response, 403, { error: "Cross-origin Intent analysis is not allowed." });
    return;
  }
  if (options.intentAnalyzer === undefined) {
    respondJson(response, 501, { error: "This Studio launcher does not provide online Intent analysis." });
    return;
  }
  if (state.workspace?.inputTrace === undefined) {
    respondJson(response, 404, { error: "The current workspace has no retained user input trace." });
    return;
  }
  if (state.intentAnalysisRunning) {
    respondJson(response, 409, { error: "An Intent analysis is already running." });
    return;
  }
  state.intentAnalysisRunning = true;
  try {
    const packet = buildIntentCorrelationPacket(state.workspace.inputTrace);
    const proposed = await options.intentAnalyzer.analyze(packet);
    const analysis: IntentCorrelationAnalysisV1 = validateIntentCorrelationAnalysis(packet, proposed);
    respondJson(response, 200, analysis, { "Cache-Control": "no-store" });
  } catch (error) {
    respondJson(response, error instanceof IntentCorrelationContractError ? 502 : 503, {
      error: error instanceof IntentCorrelationContractError
        ? "The Intent analyzer returned claims that failed local evidence validation."
        : "The Intent analyzer could not complete this request.",
    }, { "Cache-Control": "no-store" });
  } finally {
    state.intentAnalysisRunning = false;
  }
}
export async function serveWorkspaceSession(
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
export async function serveSessionComparison(
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
