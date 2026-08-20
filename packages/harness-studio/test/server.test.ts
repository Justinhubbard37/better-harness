import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunEmitter, loadSkillDeliveries, type HarnessExecutor } from "@qoder-ai/harness/exec";
import { decodeSseStream, type HarnessUiExecutorFactory } from "@qoder-ai/harness-ui";
import { parseHarnessStudioArgs, resolveHarnessStudioSourceRoot, runHarnessStudioCli, discoverDefaultInspectorReport } from "../src/server/cli.js";
import { parseSourceCatalog } from "../src/server/source-catalog.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer, type StudioWorkspaceDiscovery } from "../src/server/server.js";
import { sessionFromRetainedRun } from "../src/app/session-debugger-model.js";
import { extractInspectorReportJson } from "../src/server/query/inspector-query.js";
import { DEFAULT_LOCAL_HARNESS_ID, DEFAULT_LOCAL_RUNTIME_ID } from "../src/server/default-local-harness.js";
import type { CheckpointHistoryAdapter } from "../src/server/query/checkpoint-history.js";
import { FIXTURE_VERDICT } from "./compare-model.test.js";

const EXPERIMENT_MANIFEST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../harness/examples/checkpoint-experiment/experiment.json",
);

const SOURCE = `
  language 0.3
  skill require-tests {
    description "Do not report the task complete until tests prove it."
  }
  workflow single-pass {
    session coder
  }
  harness my-agent {
    workflow single-pass
    agent coder {
      use skill require-tests
    }
  }
  runtime qoder {
    adapter "@harness/adapter-qoder"
  }
  deployment my-agent-qoder {
    harness my-agent
    runtime qoder
  }
`;

const SOURCE_SKILL_HARNESS = `
  language 0.3
  skill deep-guide {
    source "./skills/deep-guide"
  }
  workflow single-pass {
    session coder
  }
  harness my-agent {
    workflow single-pass
    agent coder {
      use skill deep-guide
    }
  }
  runtime qoder {
    adapter "@harness/adapter-qoder"
  }
  deployment my-agent-qoder {
    harness my-agent
    runtime qoder
  }
`;

const scriptedExecutorFactory: HarnessUiExecutorFactory = (context) => {
  const executor: HarnessExecutor = {
    host: "qoder",
    async execute(revision, _bundle, task) {
      const emitter = new HarnessRunEmitter(context.onRunEvent);
      emitter.start({ revisionId: revision.revisionId, host: "qoder" });
      emitter.text(`echo: ${task.prompt}`);
      emitter.toolCall("Read", { toolUseId: "tu_1", input: { path: "README.md" } });
      emitter.toolResult("tu_1", '{"bytes":42}', { messageId: "result_1" });
      emitter.finish(0);
      return {
        host: "qoder",
        revisionId: revision.revisionId,
        exitCode: 0,
        output: `echo: ${task.prompt}`,
        errorOutput: "",
        warnings: [],
      };
    },
  };
  return executor;
};

let started: StartedHarnessStudioServer | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await started?.close();
  started = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeAppDir(): Promise<string> {
  const dir = await makeTempDir("studio-app-");
  await writeFile(join(dir, "index.html"), "<!doctype html><title>studio fixture</title>\n", "utf8");
  return dir;
}

async function waitForWorkspaceOpenStage(
  serverUrl: string,
  expected: "idle" | "choosing" | "discovering",
): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${serverUrl}/api/workspace/open/status`);
    const payload = await response.json() as { stage?: string };
    if (payload.stage === expected) return payload.stage;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Workspace open stage did not become '${expected}'.`);
}

function retainedRunFixture(id: string, savedAt: string, prompt: string, tools: string[]) {
  return {
    id,
    savedAt,
    prompt,
    status: "finished",
    runId: id.replace(/^run_/u, "session_"),
    toolCallCount: tools.length,
    warnings: [],
    timeline: [
      ...tools.map((name, index) => ({ kind: "tool-call", id: `tool_${index}`, name, argsText: "{}", status: "completed", resultText: "ok" })),
      { kind: "message", id: "message_1", text: `${prompt} complete`, complete: true },
    ],
  };
}

describe("harness-studio server", () => {
  it("reports which surfaces are enabled through /api/config", async () => {
    const appDir = await makeAppDir();
    const evidenceDir = await makeTempDir("studio-evidence-");
    await writeFile(join(evidenceDir, "verdict.json"), JSON.stringify(FIXTURE_VERDICT), "utf8");
    started = await startHarnessStudioServer({ appDir, evidenceDir });

    const config = await (await fetch(`${started.url}/api/config`)).json();

    expect(config).toEqual({
      aguiEnabled: false,
      artifactsEnabled: false,
      evidenceEnabled: true,
      experimentEnabled: false,
      harnessMode: "none",
      historyEnabled: false,
      inspectorEnabled: false,
      workspaceWorkbenchEnabled: false,
      workspaceDiscoveryEnabled: false,
      workspaceConnected: false,
      sessionCount: 0,
    });
  });

  it("opens a project workspace and serves provider-discovered Sessions without exposing its path", async () => {
    const appDir = await makeAppDir();
    const workspace = await makeTempDir("studio-project-workspace-");
    let pickerCalls = 0;
    const records = [
      retainedRunFixture("run_qoder", "2026-08-20T11:00:00.000Z", "Inspect Qoder session", ["Read", "Bash"]),
      retainedRunFixture("run_codex", "2026-08-20T10:00:00.000Z", "Inspect Codex session", ["Read"]),
    ];
    started = await startHarnessStudioServer({
      appDir,
      workspaceDirectoryPicker: async () => {
        pickerCalls += 1;
        return pickerCalls === 1 ? undefined : workspace;
      },
      workspaceSessionProvider: {
        discover: async (selected) => ({
          label: "fixture-repository",
          providers: [
            { provider: "qoder", status: "ok", discovered: 1, included: 1 },
            { provider: "codex", status: "ok", discovered: 1, included: 1 },
            { provider: "claude", status: "no-evidence", discovered: 0, included: 0 },
          ],
          inspectorReport: {
            kind: "HarnessInspectorReportV1",
            featureTree: { nodes: [], roots: [] },
            sessions: [{ sessionId: "session-structured" }],
            days: [{ date: "2026-08-20", sessionIds: ["session-structured"], commitHashes: [] }],
          },
          sessions: records.map((record, index) => ({
            summary: {
              id: `${index === 0 ? "qoder" : "codex"}:${record.id}`,
              savedAt: record.savedAt,
              prompt: record.prompt,
              status: "observed",
              toolCallCount: record.toolCallCount,
              provider: index === 0 ? "qoder" : "codex",
              messageCount: 1,
            },
            debugger: {
              ...sessionFromRetainedRun(record),
              id: `${index === 0 ? "qoder" : "codex"}:${record.id}`,
              agent: index === 0 ? "qoder" : "codex",
              protocol: "Inspector normalized local evidence",
              connection: "observed",
            },
          })),
          selected,
        }),
      },
    });

    expect(await (await fetch(`${started.url}/api/config`)).json()).toMatchObject({
      workspaceDiscoveryEnabled: true,
      workspaceConnected: false,
      workspaceWorkbenchEnabled: false,
    });
    expect((await fetch(`${started.url}/api/workspace-inspector-report`)).status).toBe(404);

    const hostile = await fetch(`${started.url}/api/workspace/open`, { method: "POST", headers: { Origin: "https://hostile.example" } });
    expect(hostile.status).toBe(403);
    expect(pickerCalls).toBe(0);

    const cancelled = await fetch(`${started.url}/api/workspace/open`, { method: "POST" });
    expect(await cancelled.json()).toEqual({ opened: false, cancelled: true });
    expect(await (await fetch(`${started.url}/api/workspace`)).json()).toMatchObject({ connected: false });

    const opened = await fetch(`${started.url}/api/workspace/open`, { method: "POST" });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ opened: true, label: "fixture-repository", sessionCount: 2 });
    const workspaceState = await (await fetch(`${started.url}/api/workspace`)).json();
    expect(workspaceState).toMatchObject({
      connected: true,
      label: "fixture-repository",
      sessionCount: 2,
      providers: [
        { provider: "qoder", status: "ok" },
        { provider: "codex", status: "ok" },
        { provider: "claude", status: "no-evidence" },
      ],
    });
    expect(JSON.stringify(workspaceState)).not.toContain(workspace);

    const connectedConfig = await (await fetch(`${started.url}/api/config`)).json();
    expect(connectedConfig).toMatchObject({ workspaceWorkbenchEnabled: true });
    const inspectorReport = await fetch(`${started.url}/api/workspace-inspector-report`);
    expect(inspectorReport.status).toBe(200);
    expect(inspectorReport.headers.get("cache-control")).toBe("no-store");
    expect(await inspectorReport.json()).toMatchObject({
      kind: "HarnessInspectorReportV1",
      sessions: [{ sessionId: "session-structured" }],
    });

    const catalog = await (await fetch(`${started.url}/api/sessions`)).json() as { sessions: Array<{ id: string; provider: string }> };
    expect(catalog.sessions.map((session) => session.id)).toEqual(["qoder:run_qoder", "codex:run_codex"]);
    expect(catalog.sessions.map((session) => session.provider)).toEqual(["qoder", "codex"]);
    const detail = await (await fetch(`${started.url}/api/sessions/${encodeURIComponent("qoder:run_qoder")}/debugger`)).json();
    expect(detail).toMatchObject({ name: "Inspect Qoder session", agent: "qoder", protocol: "Inspector normalized local evidence" });
    const comparison = await (await fetch(`${started.url}/api/session-compare?left=${encodeURIComponent("qoder:run_qoder")}&right=${encodeURIComponent("codex:run_codex")}`)).json();
    expect(comparison).toMatchObject({
      left: { prompt: "Inspect Qoder session", status: "observed", toolSequence: ["Read", "Bash"] },
      right: { prompt: "Inspect Codex session", status: "observed", toolSequence: ["Read"] },
    });
  });

  it("provides a default local harness and runs it inside the selected workspace", async () => {
    const appDir = await makeAppDir();
    const workspace = await makeTempDir("studio-default-harness-workspace-");
    let observedTask: { cwd?: string; sourceRoot?: string } | undefined;
    let observedRevision: { harnessId: string; runtimeId: string } | undefined;
    started = await startHarnessStudioServer({
      appDir,
      workspaceDirectoryPicker: async () => workspace,
      workspaceSessionProvider: {
        discover: async () => ({ label: "default-harness-project", sessions: [] }),
      },
      executorFactory: (context) => ({
        host: "qoder",
        async execute(revision, _bundle, task) {
          observedTask = task;
          observedRevision = { harnessId: revision.harness.id, runtimeId: revision.target.runtime };
          const emitter = new HarnessRunEmitter(context.onRunEvent);
          emitter.start({ revisionId: revision.revisionId, host: "qoder" });
          emitter.text(`workspace: ${task.prompt}`);
          emitter.finish(0);
          return {
            host: "qoder",
            revisionId: revision.revisionId,
            exitCode: 0,
            output: `workspace: ${task.prompt}`,
            errorOutput: "",
            warnings: [],
          };
        },
      }),
    });

    expect(await (await fetch(`${started.url}/api/config`)).json()).toMatchObject({
      aguiEnabled: true,
      harnessMode: "workspace-default",
      workspaceDiscoveryEnabled: true,
    });
    expect(await (await fetch(`${started.url}/api/workspace/open`, { method: "POST" })).json()).toMatchObject({ opened: true });

    const response = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "default-thread",
        runId: "default-run",
        messages: [{ role: "user", content: "inspect this workspace" }],
      }),
    });
    const events = decodeSseStream(await response.text());

    expect(events).toContainEqual(expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "workspace: inspect this workspace" }));
    const canonicalWorkspace = await realpath(workspace);
    expect(observedTask).toMatchObject({ cwd: canonicalWorkspace, sourceRoot: canonicalWorkspace });
    expect(observedRevision).toEqual({ harnessId: DEFAULT_LOCAL_HARNESS_ID, runtimeId: DEFAULT_LOCAL_RUNTIME_ID });
  });

  it("keeps an explicitly configured harness and cwd authoritative after workspace selection", async () => {
    const appDir = await makeAppDir();
    const workspace = await makeTempDir("studio-configured-workspace-");
    const configuredCwd = await makeTempDir("studio-configured-cwd-");
    let observed: { cwd?: string; harnessId: string } | undefined;
    started = await startHarnessStudioServer({
      appDir,
      harnessSource: SOURCE,
      cwd: configuredCwd,
      workspaceDirectoryPicker: async () => workspace,
      workspaceSessionProvider: { discover: async () => ({ label: "configured-project", sessions: [] }) },
      executorFactory: (context) => ({
        host: "qoder",
        async execute(revision, _bundle, task) {
          observed = { cwd: task.cwd, harnessId: revision.harness.id };
          const emitter = new HarnessRunEmitter(context.onRunEvent);
          emitter.start({ revisionId: revision.revisionId, host: "qoder" });
          emitter.finish(0);
          return { host: "qoder", revisionId: revision.revisionId, exitCode: 0, output: "", errorOutput: "", warnings: [] };
        },
      }),
    });

    expect(await (await fetch(`${started.url}/api/config`)).json()).toMatchObject({ harnessMode: "configured" });
    await fetch(`${started.url}/api/workspace/open`, { method: "POST" });
    await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "configured-thread", runId: "configured-run", messages: [{ role: "user", content: "run configured" }] }),
    });

    expect(observed).toEqual({ cwd: configuredCwd, harnessId: "my-agent" });
  });

  it("reports directory selection and Session discovery as separate open stages", async () => {
    const appDir = await makeAppDir();
    const workspace = await makeTempDir("studio-progress-workspace-");
    let selectWorkspace!: (value: string) => void;
    let finishDiscovery!: (value: StudioWorkspaceDiscovery) => void;
    const selected = new Promise<string>((resolveSelection) => { selectWorkspace = resolveSelection; });
    const discovered = new Promise<StudioWorkspaceDiscovery>((resolveDiscovery) => { finishDiscovery = resolveDiscovery; });
    started = await startHarnessStudioServer({
      appDir,
      workspaceDirectoryPicker: async () => selected,
      workspaceSessionProvider: { discover: async () => discovered },
    });

    const opening = fetch(`${started.url}/api/workspace/open`, { method: "POST" });
    expect(await waitForWorkspaceOpenStage(started.url, "choosing")).toBe("choosing");

    selectWorkspace(workspace);
    expect(await waitForWorkspaceOpenStage(started.url, "discovering")).toBe("discovering");

    finishDiscovery({
      label: "progress-project",
      providers: [{ provider: "qoder", status: "no-evidence", discovered: 0, included: 0 }],
      sessions: [],
    });
    expect(await (await opening).json()).toMatchObject({ opened: true, label: "progress-project", sessionCount: 0 });
    expect(await waitForWorkspaceOpenStage(started.url, "idle")).toBe("idle");
  });

  it("opens a browser-selected workspace, indexes Sessions, and compares two retained runs", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });
    const created = await fetch(`${started.url}/api/workspaces?label=review-sessions`, { method: "POST" });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };

    const upload = async (path: string, value: unknown): Promise<Response> => fetch(
      `${started!.url}/api/workspaces/${sessionId}/files?path=${encodeURIComponent(path)}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) },
    );
    expect((await upload("review-sessions/nested/run_left.json", retainedRunFixture("run_left", "2026-08-20T10:00:00.000Z", "Repair parser", ["Read", "Edit", "Bash"]))).status).toBe(201);
    expect((await upload("review-sessions/run_right.json", retainedRunFixture("run_right", "2026-08-20T11:00:00.000Z", "Repair renderer", ["Read", "Bash"]))).status).toBe(201);
    expect((await upload("review-sessions/notes.json", { note: "unsupported" })).status).toBe(201);

    expect(await (await fetch(`${started.url}/api/workspace`)).json()).toMatchObject({ connected: false, sessionCount: 0 });
    expect((await fetch(`${started.url}/api/sessions`)).status).toBe(404);

    const committed = await fetch(`${started.url}/api/workspaces/${sessionId}/commit`, { method: "POST" });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toEqual({ label: "review-sessions", sessionCount: 2, omittedCount: 1 });

    const config = await (await fetch(`${started.url}/api/config`)).json() as { workspaceConnected: boolean; sessionCount: number };
    expect(config).toMatchObject({ workspaceConnected: true, sessionCount: 2 });
    const catalog = await (await fetch(`${started.url}/api/sessions`)).json() as { sessions: Array<{ id: string; prompt: string }> };
    expect(catalog.sessions.map((session) => session.id)).toEqual(["run_right", "run_left"]);
    const debuggerSession = await (await fetch(`${started.url}/api/sessions/run_left/debugger`)).json();
    expect(debuggerSession).toMatchObject({ name: "Repair parser", mode: "Retained run" });

    const comparison = await (await fetch(`${started.url}/api/session-compare?left=run_left&right=run_right`)).json();
    expect(comparison).toMatchObject({
      kind: "observational-session-compare.v1",
      boundary: expect.stringMatching(/no winner/i),
      left: { prompt: "Repair parser", toolCallCount: 3, toolSequence: ["Read", "Edit", "Bash"] },
      right: { prompt: "Repair renderer", toolCallCount: 2, toolSequence: ["Read", "Bash"] },
    });

    expect((await fetch(`${started.url}/api/workspace`, { method: "DELETE" })).status).toBe(200);
    expect(await (await fetch(`${started.url}/api/workspace`)).json()).toMatchObject({ connected: false, sessionCount: 0 });
  });

  it("rejects cross-origin and traversal-shaped workspace imports", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });
    expect((await fetch(`${started.url}/api/workspaces`, { method: "POST", headers: { Origin: "https://hostile.example" } })).status).toBe(403);
    const created = await fetch(`${started.url}/api/workspaces`, { method: "POST" });
    const { sessionId } = await created.json() as { sessionId: string };
    const traversal = await fetch(`${started.url}/api/workspaces/${sessionId}/files?path=${encodeURIComponent("../run_escape.json")}`, { method: "PUT", body: "{}" });
    expect(traversal.status).toBe(400);
    expect((await fetch(`${started.url}/api/workspaces/${sessionId}/commit`, { method: "POST" })).status).toBe(422);
    expect((await fetch(`${started.url}/api/workspaces/${sessionId}`, { method: "DELETE" })).status).toBe(200);
  });

  it("serves one explicitly configured Inspector report without exposing a file picker", async () => {
    const appDir = await makeAppDir();
    const reportDir = await makeTempDir("studio-inspector-");
    const reportPath = join(reportDir, "inspector.html");
    await writeFile(reportPath, "<!doctype html><title>Inspector fixture</title><h1>Evidence Workbench</h1>\n", "utf8");
    started = await startHarnessStudioServer({ appDir, inspectorReportPath: reportPath });

    const config = await (await fetch(`${started.url}/api/config`)).json();
    const report = await fetch(`${started.url}/inspector`);
    const structured = await fetch(`${started.url}/api/inspector-report`);

    expect(config.inspectorEnabled).toBe(true);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toContain("text/html");
    expect(report.headers.get("cache-control")).toBe("no-store");
    expect(await report.text()).toContain("Evidence Workbench");
    expect(structured.status).toBe(204);

    await started.close();
    started = await startHarnessStudioServer({ appDir });
    const missing = await fetch(`${started.url}/inspector`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/--inspector/);
  });

  it("switches bounded Studio sources without exposing browser file paths", async () => {
    const appDir = await makeAppDir();
    const reportDir = await makeTempDir("studio-source-switch-");
    const primaryReport = join(reportDir, "primary.html");
    const alternateReport = join(reportDir, "alternate.html");
    await writeFile(primaryReport, "<!doctype html><h1>Primary Evidence</h1>", "utf8");
    await writeFile(alternateReport, "<!doctype html><h1>Alternate Evidence</h1>", "utf8");
    started = await startHarnessStudioServer({
      appDir,
      inspectorReportPath: primaryReport,
      sourceCatalog: [{ id: "inspector_alt", kind: "inspector", label: "Alternate Inspector", path: alternateReport }],
    });

    const listed = await (await fetch(`${started.url}/api/sources`)).json();
    expect(listed.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "inspector_startup", kind: "inspector", active: true }),
      expect.objectContaining({ id: "inspector_alt", kind: "inspector", label: "Alternate Inspector", active: false }),
    ]));
    expect(JSON.stringify(listed)).not.toContain(reportDir);
    expect(await (await fetch(`${started.url}/inspector`)).text()).toContain("Primary Evidence");

    const hostile = await fetch(`${started.url}/api/sources/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hostile.example" },
      body: JSON.stringify({ kind: "inspector", sourceId: "inspector_alt" }),
    });
    expect(hostile.status).toBe(403);

    const switched = await fetch(`${started.url}/api/sources/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "inspector", sourceId: "inspector_alt" }),
    });
    expect(switched.status).toBe(200);
    expect((await switched.json()).sources).toContainEqual(expect.objectContaining({ id: "inspector_alt", active: true }));
    expect((await (await fetch(`${started.url}/api/config`)).json()).inspectorEnabled).toBe(true);
    expect(await (await fetch(`${started.url}/inspector`)).text()).toContain("Alternate Evidence");

    const unknown = await fetch(`${started.url}/api/sources/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "inspector", sourceId: "unknown_source" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("serves structured Inspector report JSON for the native Studio workbench", async () => {
    const appDir = await makeAppDir();
    const reportDir = await makeTempDir("studio-inspector-json-");
    const reportPath = join(reportDir, "inspector.html");
    const payload = {
      kind: "HarnessInspectorReportV1",
      workspace: { name: "fixture <repo>" },
      featureTree: { nodes: [], roots: [] },
      stories: [],
      days: [],
      sessions: [],
      commits: [],
      providers: [],
      filters: { platform: "qoder" },
    };
    const html = `<!doctype html><title>Inspector fixture</title><script type="application/json" id="inspector-data">${JSON.stringify(payload).replaceAll("<", "\\u003c")}</script>`;
    await writeFile(reportPath, html, "utf8");
    started = await startHarnessStudioServer({ appDir, inspectorReportPath: reportPath });

    expect(JSON.parse(extractInspectorReportJson(html))).toMatchObject({ kind: "HarnessInspectorReportV1", workspace: { name: "fixture <repo>" } });
    expect(() => extractInspectorReportJson("<!doctype html><title>No data</title>")).toThrow(/embedded workbench data/);
    const response = await fetch(`${started.url}/api/inspector-report`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ kind: "HarnessInspectorReportV1", workspace: { name: "fixture <repo>" } });
  });

  it("resolves source-neutral history and activates only the successfully locked manifest", async () => {
    const appDir = await makeAppDir();
    const alternateDir = await makeTempDir("studio-locked-manifest-");
    await cp(dirname(EXPERIMENT_MANIFEST), alternateDir, { recursive: true });
    await writeFile(join(alternateDir, "prompt.md"), "Locked presentation request.\n", "utf8");
    const alternateManifest = join(alternateDir, "experiment.json");
    const adapter: CheckpointHistoryAdapter = {
      descriptor: { id: "pptx-history-v1", label: "Presentation history" },
      async list() {
        return {
          adapter: this.descriptor,
          items: [{
            id: "deck_revision_42",
            title: "Quarterly review edit",
            requestPreview: "Tighten the executive summary.",
            occurredAt: "2026-08-17T08:00:00.000Z",
            adapter: this.descriptor,
            provenance: "verified-history",
            checkpointVerified: true,
          }],
        };
      },
      async resolve() {
        return {
          item: (await this.list()).items[0]!,
          checkpointRef: { planPath: "/adapter-owned/deck-checkpoint.json", digest: `sha256:${"a".repeat(64)}` },
          checkpointSource: {
            status: "ready",
            adapter: this.descriptor,
            resource: { label: "Presentation", value: "Quarterly review.pptx" },
            revision: { label: "Version", value: "42" },
            history: { label: "Edit history", value: "change-108" },
            materialization: { label: "Isolated document copy", value: "10 copies", timing: "on-run", count: 10 },
            capabilities: { isolatedMaterialization: true, observedHistory: true, preserveResult: true },
          },
          request: {
            promptPath: "/adapter-owned/prompt.md",
            prompt: "Tighten the executive summary.\n",
            promptHash: `sha256:${"b".repeat(64)}`,
            verified: true,
          },
          observed: {
            trajectoryPath: "/adapter-owned/trajectory.jsonl",
            startCheckpointVerified: true,
            identity: { harnessId: "readme-grounded", model: "performance" },
          },
        };
      },
    };
    started = await startHarnessStudioServer({
      appDir,
      experimentManifestPath: EXPERIMENT_MANIFEST,
      checkpointHistoryAdapter: adapter,
      experimentLocker: async () => ({
        manifestPath: alternateManifest,
        receipt: {
          lockId: "lock_presentation",
          historyId: "deck_revision_42",
          manifestDigest: `sha256:${"c".repeat(64)}`,
          checkpointDigest: `sha256:${"a".repeat(64)}`,
          manifestName: "experiment.json",
        },
      }),
    });

    const history = await (await fetch(`${started.url}/api/checkpoint-history`)).json();
    expect(history.items[0]).toMatchObject({ id: "deck_revision_42", adapter: { id: "pptx-history-v1" } });
    expect(JSON.stringify(history)).not.toContain("adapter-owned");

    const resolved = await fetch(`${started.url}/api/checkpoint-history/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ historyId: "deck_revision_42" }),
    });
    expect(await resolved.json()).toMatchObject({
      lockable: true,
      setup: {
        checkpointSource: { resource: { label: "Presentation" } },
        request: { provenance: "verified-history" },
      },
    });

    const hostile = await fetch(`${started.url}/api/experiment/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hostile.example" },
      body: JSON.stringify({ historyId: "deck_revision_42" }),
    });
    expect(hostile.status).toBe(403);

    const locked = await fetch(`${started.url}/api/experiment/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ historyId: "deck_revision_42" }),
    });
    expect(await locked.json()).toMatchObject({
      lock: { lockId: "lock_presentation" },
      setup: { request: { prompt: "Locked presentation request.\n" } },
    });
    const active = await (await fetch(`${started.url}/api/experiment`)).json();
    expect(active).toMatchObject({
      lock: { lockId: "lock_presentation" },
      setup: { request: { prompt: "Locked presentation request.\n" } },
    });
  });

  it("serves the evidence verdict.json and 404s when it is absent", async () => {
    const appDir = await makeAppDir();
    const evidenceDir = await makeTempDir("studio-evidence-");
    await writeFile(join(evidenceDir, "verdict.json"), JSON.stringify(FIXTURE_VERDICT), "utf8");
    started = await startHarnessStudioServer({ appDir, evidenceDir });

    const response = await fetch(`${started.url}/api/evidence`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(FIXTURE_VERDICT)));

    await started.close();
    started = await startHarnessStudioServer({ appDir });
    const missing = await fetch(`${started.url}/api/evidence`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/--evidence/);
  });

  it("serves an experiment preview and multiplexes lane-scoped events", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({
      appDir,
      experimentManifestPath: EXPERIMENT_MANIFEST,
      experimentRunner: async (options) => {
        options.onEvent?.({
          type: "lane-started",
          experimentId: options.experimentId!,
          laneId: "fresh-default",
          runId: `${options.experimentId}:fresh-default:1`,
          at: "2026-08-17T00:00:00.000Z",
        });
        options.onEvent?.({
          type: "lane-event",
          experimentId: options.experimentId!,
          laneId: "fresh-default",
          runId: `${options.experimentId}:fresh-default:1`,
          at: "2026-08-17T00:00:01.000Z",
          event: {
            type: "tool.requested",
            toolInvocationId: "read-1",
            toolName: "Read",
            filePath: "README.md",
          } as never,
        });
        return {} as never;
      },
    });

    const preview = await (await fetch(`${started.url}/api/experiment`)).json();
    expect(preview.manifest.lanes.map((lane: { id: string }) => lane.id)).toEqual([
      "history",
      "fresh-default",
      "fresh-minimal",
    ]);
    expect(preview.contrasts[0]).toMatchObject({
      id: "profile-effect",
      attribution: { mode: "attributable", axis: "runtime-profile" },
    });
    expect(preview.setup).toMatchObject({
      scenario: "historical-replay",
      checkpointSource: {
        status: "unavailable",
        materialization: { timing: "on-run", count: 10 },
      },
      request: { provenance: "unverified-history" },
    });
    expect(preview.setup.historicalGaps[0]).toMatchObject({ laneId: "history" });
    expect(preview.observedCalls.history[0]).toMatchObject({
      name: "Read",
      input: { path: "README.md" },
      status: "completed",
    });
    expect(preview.observedCallPages.history).toMatchObject({ complete: true, malformedLines: 0 });
    expect(preview).not.toHaveProperty("observedEvents");

    const observedPage = await (await fetch(`${started.url}/api/experiment/observed-calls?laneId=history&limit=100`)).json();
    expect(observedPage.complete).toBe(true);
    expect(observedPage.calls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Read" })]));
    const invalidPage = await fetch(`${started.url}/api/experiment/observed-calls?laneId=../history`);
    expect(invalidPage.status).toBe(400);

    const stream = await fetch(`${started.url}/api/experiment/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experimentId: "exp_server_test" }),
    });
    const body = await stream.text();
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"experimentId":"exp_server_test"');
    expect(body).toContain('"laneId":"fresh-default"');
    expect(body).toContain('"type":"tool-call-started"');
    expect(body).toContain('"toolName":"Read"');
    expect(body).not.toContain('"type":"tool.requested"');
  });

  it("rejects cross-origin experiment execution", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({
      appDir,
      experimentManifestPath: EXPERIMENT_MANIFEST,
      experimentRunner: async () => ({} as never),
    });

    const response = await fetch(`${started.url}/api/experiment/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hostile.example" },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("cancels a running experiment through its lifecycle endpoint", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({
      appDir,
      experimentManifestPath: EXPERIMENT_MANIFEST,
      experimentRunner: (options) => new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    });
    const stream = await fetch(`${started.url}/api/experiment/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experimentId: "exp_cancel_test" }),
    });

    const cancellation = await fetch(`${started.url}/api/experiment/runs/exp_cancel_test`, { method: "DELETE" });

    expect(cancellation.status).toBe(202);
    expect(await cancellation.json()).toMatchObject({ status: "cancelling" });
    expect(await stream.text()).toContain('"type":"experiment-cancelled"');
  });

  it("serves the app shell and refuses path escapes", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });

    const index = await fetch(`${started.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");

    const escape = await fetch(`${started.url}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(escape.status);
  });

  it("mounts the embedded AG-UI endpoint when a harness is loaded", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({
      appDir,
      harnessSource: SOURCE,
      executorFactory: scriptedExecutorFactory,
    });

    const response = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "hello studio" }],
      }),
    });

    const events = decodeSseStream(await response.text());
    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "echo: hello studio" }),
    );

    const hostile = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hostile.example" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r2",
        messages: [{ role: "user", content: "must not run" }],
      }),
    });
    expect(hostile.status).toBe(403);
  });

  it("delivers a source-backed skill through the embedded AG-UI endpoint", async () => {
    const appDir = await makeAppDir();
    const sourceRoot = await makeTempDir("studio-source-");
    await mkdir(join(sourceRoot, "skills", "deep-guide"), { recursive: true });
    await writeFile(
      join(sourceRoot, "skills", "deep-guide", "SKILL.md"),
      "Never touch generated files.\n",
      "utf8",
    );

    let deliveredBody: string | undefined;
    let seenSourceRoot: string | undefined;
    started = await startHarnessStudioServer({
      appDir,
      harnessSource: SOURCE_SKILL_HARNESS,
      sourceRoot,
      executorFactory: (context) => ({
        host: "qoder",
        async execute(revision, bundle, task) {
          seenSourceRoot = task.sourceRoot;
          deliveredBody = (await loadSkillDeliveries(revision, bundle, {
            sourceRoot: task.sourceRoot,
          })).get("deep-guide")?.body;
          const emitter = new HarnessRunEmitter(context.onRunEvent);
          emitter.start({ revisionId: revision.revisionId, host: "qoder" });
          emitter.finish(0);
          return {
            host: "qoder",
            revisionId: revision.revisionId,
            exitCode: 0,
            output: "",
            errorOutput: "",
            warnings: [],
          };
        },
      }),
    });

    const response = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r-source",
        messages: [{ role: "user", content: "run" }],
      }),
    });

    expect(decodeSseStream(await response.text()).map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
    expect(seenSourceRoot).toBe(sourceRoot);
    expect(deliveredBody).toBe("Never touch generated files.\n");
  });

  it("keeps /agui closed when no harness is loaded", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });

    const response = await fetch(`${started.url}/agui`, { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/--harness/);
  });

  it("saves, lists, and replays Debugger runs behind the harness and same-origin boundary", async () => {
    const appDir = await makeAppDir();
    const runDirectory = join(await makeTempDir("studio-runs-"), "runs");
    started = await startHarnessStudioServer({
      appDir,
      harnessSource: SOURCE,
      executorFactory: scriptedExecutorFactory,
      runDirectory,
    });

    const snapshot = {
      prompt: "Verify saved run catalog",
      status: "finished",
      runId: "r_catalog",
      threadId: "t_catalog",
      warnings: ["one warning"],
      result: { exitCode: 0 },
      timeline: [
        { kind: "message", id: "m1", text: "echo: catalog", complete: true },
        { kind: "tool-call", id: "tu_1", name: "Read", argsText: '{"path":"README.md"}', status: "completed", resultText: '{"bytes":42}' },
        { kind: "tool-call", id: "tu_2", name: "Bash", argsText: '{"command":"npm test"}', status: "failed", resultText: "1 failed" },
      ],
    };

    const hostile = await fetch(`${started.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hostile.example" },
      body: JSON.stringify(snapshot),
    });
    expect(hostile.status).toBe(403);

    const savedResponse = await fetch(`${started.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    expect(savedResponse.status).toBe(201);
    const saved = await savedResponse.json();
    expect(saved.id).toMatch(/^run_/);

    const listed = await (await fetch(`${started.url}/api/runs`)).json();
    expect(listed.runs).toEqual([
      expect.objectContaining({ id: saved.id, prompt: "Verify saved run catalog", status: "finished", toolCallCount: 2 }),
    ]);

    const record = await (await fetch(`${started.url}/api/runs/${saved.id}`)).json();
    expect(record).toMatchObject({
      id: saved.id,
      prompt: "Verify saved run catalog",
      warnings: ["one warning"],
      result: { exitCode: 0 },
    });
    expect(record.timeline).toHaveLength(3);
    expect(record.timeline[1]).toMatchObject({ kind: "tool-call", name: "Read", status: "completed" });

    const session = await (await fetch(`${started.url}/api/runs/${saved.id}/session`)).json();
    expect(session).toMatchObject({
      id: "r_catalog",
      name: "Verify saved run catalog",
      mode: "Retained run",
      protocol: "AG-UI retained evidence",
    });
    expect(session.events.map((event: { kind: string }) => event.kind)).toEqual(["prompt", "response", "explore", "verify"]);
    expect(session.events.find((event: { phase: string }) => event.phase === "Verify")).toMatchObject({
      title: "Bash tool call",
      validation: { command: "npm test", status: "failed" },
      stopConditions: ["tests", "failures"],
    });

    const missing = await fetch(`${started.url}/api/runs/run_does_not_exist`);
    expect(missing.status).toBe(404);

    const invalid = await fetch(`${started.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "finished", timeline: [] }),
    });
    expect(invalid.status).toBe(400);
  });

  it("keeps the run catalog closed when no harness is loaded", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });

    const response = await fetch(`${started.url}/api/runs`);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/--harness/);
  });
});

describe("harness-studio CLI", () => {
  it("prints help and exits 0 without touching files or ports", async () => {
    const out: string[] = [];

    const code = await runHarnessStudioCli(["--help"], {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("--evidence <dir>");
  });

  it("accepts an empty startup so Studio can acquire artifacts in the UI", () => {
    expect(parseHarnessStudioArgs([])).toMatchObject({ host: "127.0.0.1", port: 3311 });
    expect(parseHarnessStudioArgs([]).error).toBeUndefined();
  });

  it("resolves the default source root from the harness file and honors an override", () => {
    expect(resolveHarnessStudioSourceRoot("/workspace/harnesses/agent.harness")).toBe(
      resolve("/workspace/harnesses"),
    );
    expect(resolveHarnessStudioSourceRoot("/workspace/harnesses/agent.harness", "/skills")).toBe(
      "/skills",
    );
    expect(resolveHarnessStudioSourceRoot(undefined)).toBeUndefined();
  });

  it("parses Inspector, history catalog, runs, source catalog, and lock directory options", () => {
    expect(parseHarnessStudioArgs([
      "--inspector", "inspector.html",
      "--experiment", "experiment.json",
      "--history-catalog", "history.json",
      "--experiment-locks", ".locks",
      "--runs", ".runs",
      "--source-catalog", "sources.json",
    ])).toMatchObject({
      inspector: "inspector.html",
      experiment: "experiment.json",
      historyCatalog: "history.json",
      experimentLocks: ".locks",
      runs: ".runs",
      sourceCatalog: "sources.json",
    });

    expect(parseSourceCatalog({ sources: [{ kind: "evidence", id: "ev_local", label: "Local evidence", path: "evidence" }] }, "/workspace")).toEqual([
      { kind: "evidence", id: "ev_local", label: "Local evidence", path: resolve("/workspace/evidence") },
    ]);
  });

  it("discovers the conventional Inspector report only at its fixed path", async () => {
    const cwd = await makeTempDir("studio-discover-");
    expect(await discoverDefaultInspectorReport(cwd)).toBeUndefined();

    const reportDir = join(cwd, ".qoder", "better-harness-runs", "harness-inspector");
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, "inspector.html"), "<!doctype html><title>local report</title>", "utf8");

    expect(await discoverDefaultInspectorReport(cwd)).toBe(join(reportDir, "inspector.html"));
  });

  it("serves TSX as inert source instead of executing it as an artifact module", async () => {
    const appDir = await makeAppDir();
    const artifactDirectory = await makeTempDir("studio-artifacts-");
    await writeFile(join(artifactDirectory, "card.tsx"), "export default () => <p>hi</p>;\n", "utf8");
    started = await startHarnessStudioServer({ appDir, artifactDirectory });

    const catalog = await (await fetch(`${started.url}/api/artifacts`)).json() as { artifacts: Array<{ kind: string; renderer: string }> };
    expect(catalog.artifacts).toEqual([expect.objectContaining({ kind: "code", renderer: "code" })]);
    const source = await fetch(`${started.url}/api/artifacts/card/content`);
    expect(source.status).toBe(200);
    expect(await source.text()).toContain("export default");
    expect((await fetch(`${started.url}/api/artifacts/card/module.js`)).status).toBe(404);
  });

  it("imports a manually selected artifact set and switches the live catalog atomically", async () => {
    const appDir = await makeAppDir();
    const originalDirectory = await makeTempDir("studio-artifacts-original-");
    const originalPath = join(originalDirectory, "old.tsx");
    await writeFile(originalPath, "export const old = true;\n", "utf8");
    started = await startHarnessStudioServer({ appDir, artifactDirectory: originalDirectory });

    const created = await fetch(`${started.url}/api/artifact-imports`, { method: "POST" });
    expect(created.status).toBe(201);
    const { sessionId, maxFiles, maxBytes } = await created.json() as { sessionId: string; maxFiles: number; maxBytes: number };
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(maxFiles).toBe(256);
    expect(maxBytes).toBe(128 * 1024 * 1024);

    const deck = await fetch(`${started.url}/api/artifact-imports/${sessionId}/files?name=${encodeURIComponent("slides/deck.pptx")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("pptx fixture"),
    });
    const source = await fetch(`${started.url}/api/artifact-imports/${sessionId}/files?name=${encodeURIComponent("code/card.tsx")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("export default () => <p>imported</p>;\n"),
    });
    expect(deck.status).toBe(201);
    expect(await deck.json()).toMatchObject({ label: "slides--deck.pptx" });
    expect(source.status).toBe(201);
    expect(await source.json()).toMatchObject({ label: "code--card.tsx" });

    const beforeCommit = await (await fetch(`${started.url}/api/artifacts`)).json() as { artifacts: Array<{ label: string }> };
    expect(beforeCommit.artifacts.map((artifact) => artifact.label)).toEqual(["old.tsx"]);

    const committed = await fetch(`${started.url}/api/artifact-imports/${sessionId}/commit`, { method: "POST" });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ imported: 2 });
    expect(await readFile(originalPath, "utf8")).toBe("export const old = true;\n");

    const config = await (await fetch(`${started.url}/api/config`)).json() as { artifactsEnabled: boolean };
    expect(config.artifactsEnabled).toBe(true);
    const catalog = await (await fetch(`${started.url}/api/artifacts`)).json() as { artifacts: Array<{ label: string }> };
    expect(catalog.artifacts.map((artifact) => artifact.label).sort()).toEqual(["code--card.tsx", "slides--deck.pptx"]);
  });

  it("rejects hostile or incomplete manual artifact imports without changing the catalog", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });

    const hostile = await fetch(`${started.url}/api/artifact-imports`, {
      method: "POST",
      headers: { Origin: "https://hostile.example" },
    });
    expect(hostile.status).toBe(403);

    const created = await fetch(`${started.url}/api/artifact-imports`, { method: "POST" });
    const { sessionId, maxBytes } = await created.json() as { sessionId: string; maxBytes: number };
    const oversizedStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
      const upload = httpRequest(
        `${started!.url}/api/artifact-imports/${sessionId}/files?name=oversized.bin`,
        { method: "PUT", headers: { "Content-Length": String(maxBytes + 1) } },
        (response) => {
          response.resume();
          response.once("end", () => resolveStatus(response.statusCode));
        },
      );
      upload.once("error", reject);
      upload.end();
    });
    expect(oversizedStatus).toBe(413);
    const traversal = await fetch(`${started.url}/api/artifact-imports/${sessionId}/files?name=${encodeURIComponent("../secret.txt")}`, {
      method: "PUT",
      body: Buffer.from("must not land"),
    });
    expect(traversal.status).toBe(400);
    expect((await fetch(`${started.url}/api/artifact-imports/${sessionId}/commit`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${started.url}/api/artifact-imports/${sessionId}`, { method: "DELETE" })).status).toBe(200);

    const config = await (await fetch(`${started.url}/api/config`)).json() as { artifactsEnabled: boolean };
    expect(config.artifactsEnabled).toBe(false);
    expect((await fetch(`${started.url}/api/artifacts`)).status).toBe(404);
  });

  it("rejects malformed percent-encoded artifact ids without taking down the server", async () => {
    const appDir = await makeAppDir();
    const artifactDirectory = await makeTempDir("studio-artifacts-");
    await writeFile(join(artifactDirectory, "card.tsx"), "export default () => null;\n", "utf8");
    started = await startHarnessStudioServer({ appDir, artifactDirectory });
    expect((await fetch(`${started.url}/api/artifacts/%E0%A4%A/content`)).status).toBe(400);
    expect((await fetch(`${started.url}/api/config`)).status).toBe(200);
  });

  it("answers with a status when the artifact directory disappears after startup", async () => {
    const appDir = await makeAppDir();
    const artifactDirectory = await makeTempDir("studio-artifacts-");
    await writeFile(join(artifactDirectory, "card.tsx"), "export default () => <p>hi</p>;\n", "utf8");
    started = await startHarnessStudioServer({ appDir, artifactDirectory });
    expect((await fetch(`${started.url}/api/artifacts/card/content`)).status).toBe(200);

    await rm(artifactDirectory, { recursive: true, force: true });

    // An unreadable directory must not reject out of the route handler: that is
    // an unhandled rejection, which takes the whole Studio process down.
    const response = await fetch(`${started.url}/api/artifacts/card/content`);
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("Cannot read the configured artifact directory.");
    expect(body.error).not.toContain(artifactDirectory);

    // The server is still answering, which is the point of the guard.
    expect((await fetch(`${started.url}/api/config`)).status).toBe(200);
  });
});
