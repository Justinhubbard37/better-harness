import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunEmitter, type HarnessExecutor } from "@qoder-ai/harness/exec";
import { decodeSseStream, type HarnessUiExecutorFactory } from "@qoder-ai/harness-ui";
import { runHarnessStudioCli } from "../src/server/cli.js";
import { startHarnessStudioServer, type StartedHarnessStudioServer } from "../src/server/server.js";
import { FIXTURE_VERDICT } from "./compare-model.test.js";

const SOURCE = `
  skill require-tests {
    description "Do not report the task complete until tests prove it."
  }
  workflow single-pass {
    stop when coder.done
  }
  harness my-agent {
    workflow single-pass
    agent coder {
      use skill require-tests
    }
  }
  target qoder
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

    expect(config).toEqual({ aguiEnabled: false, evidenceEnabled: true });
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

  it("keeps /agui closed when no harness is loaded", async () => {
    const appDir = await makeAppDir();
    started = await startHarnessStudioServer({ appDir });

    const response = await fetch(`${started.url}/agui`, { method: "POST", body: "{}" });

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

  it("requires at least one of --evidence or --harness", async () => {
    const errors: string[] = [];

    const code = await runHarnessStudioCli([], {
      stdout: () => undefined,
      stderr: (text) => errors.push(text),
    });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/--evidence <dir>, --harness <file\.harness>/);
  });
});
