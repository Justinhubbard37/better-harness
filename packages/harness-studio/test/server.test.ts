import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunEmitter, loadSkillDeliveries, type HarnessExecutor } from "@qoder-ai/harness/exec";
import { decodeSseStream, type HarnessUiExecutorFactory } from "@qoder-ai/harness-ui";
import { parseHarnessStudioArgs, resolveHarnessStudioSourceRoot, runHarnessStudioCli, discoverDefaultInspectorReport } from "../src/server/cli.js";
import { parseSourceCatalog } from "../src/server/source-catalog.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import { extractInspectorReportJson } from "../src/server/query/inspector-query.js";
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

describe("harness-studio server", () => {
  it("reports which surfaces are enabled through /api/config", async () => {
    const appDir = await makeAppDir();
    const evidenceDir = await makeTempDir("studio-evidence-");
    await writeFile(join(evidenceDir, "verdict.json"), JSON.stringify(FIXTURE_VERDICT), "utf8");
    started = await startHarnessStudioServer({ appDir, evidenceDir });

    const config = await (await fetch(`${started.url}/api/config`)).json();

    expect(config).toEqual({
      aguiEnabled: false,
      evidenceEnabled: true,
      experimentEnabled: false,
      historyEnabled: false,
      inspectorEnabled: false,
    });
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

  it("requires at least one Studio surface", async () => {
    const errors: string[] = [];

    const code = await runHarnessStudioCli([], {
      stdout: () => undefined,
      stderr: (text) => errors.push(text),
    });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/--source-catalog/);
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
});
