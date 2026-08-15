import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunEmitter, type HarnessExecutor } from "@qoder-ai/harness/exec";
import { decodeSseStream } from "../src/sse.js";
import { parseHarnessUiArgs, runHarnessUiCli } from "../src/cli.js";
import { startHarnessUiServer, type StartedHarnessUiServer } from "../src/server.js";
import type { HarnessUiExecutorFactory } from "../src/run.js";

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
      emitter.finish(0, { turns: 1 });
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

let started: StartedHarnessUiServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
});

async function postAgui(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/agui`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postRaw(
  url: string,
  headers: Record<string, string>,
  body: string,
  includeContentLength = true,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        ...headers,
        ...(includeContentLength ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: responseBody }));
    });
    request.on("error", rejectPromise);
    request.end(body);
  });
}

describe("harness-ui server", () => {
  it("answers the liveness probe", async () => {
    started = await startHarnessUiServer({ source: SOURCE, executorFactory: scriptedExecutorFactory });

    const response = await fetch(`${started.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("streams a protocol-complete AG-UI run for a RunAgentInput", async () => {
    started = await startHarnessUiServer({ source: SOURCE, executorFactory: scriptedExecutorFactory });

    const response = await postAgui(started.url, {
      threadId: "thread-9",
      runId: "run-9",
      messages: [{ id: "m1", role: "user", content: "Explain the repo" }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = decodeSseStream(await response.text());
    expect(events[0]).toEqual({ type: "RUN_STARTED", threadId: "thread-9", runId: "run-9" });
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
      expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "echo: Explain the repo" }),
    );
    expect(events.at(-1)).toEqual({
      type: "RUN_FINISHED",
      threadId: "thread-9",
      runId: "run-9",
      result: { exitCode: 0, metrics: { turns: 1 } },
    });
  });

  it("rejects malformed run input before starting a run", async () => {
    started = await startHarnessUiServer({ source: SOURCE, executorFactory: scriptedExecutorFactory });

    const missingIds = await postAgui(started.url, { messages: [] });
    expect(missingIds.status).toBe(400);

    const missingPrompt = await postAgui(started.url, { threadId: "t", runId: "r", messages: [] });
    expect(missingPrompt.status).toBe(400);
    expect((await missingPrompt.json()).error).toMatch(/user message/);
  });

  it("turns a compile failure into a terminal RUN_ERROR stream", async () => {
    started = await startHarnessUiServer({
      source: "harness broken {",
      executorFactory: scriptedExecutorFactory,
    });

    const response = await postAgui(started.url, {
      threadId: "t1",
      runId: "r1",
      messages: [{ role: "user", content: "run" }],
    });

    const events = decodeSseStream(await response.text());
    expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
  });

  it("owns the outer lifecycle when an injected executor throws or emits no lifecycle events", async () => {
    started = await startHarnessUiServer({
      source: SOURCE,
      executorFactory: () => {
        throw new Error("executor construction failed");
      },
    });
    const failed = await postAgui(started.url, {
      threadId: "t1",
      runId: "failed-run",
      messages: [{ role: "user", content: "run" }],
    });
    expect(decodeSseStream(await failed.text()).map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);

    await started.close();
    started = await startHarnessUiServer({
      source: SOURCE,
      executorFactory: () => ({
        host: "qoder",
        async execute(revision) {
          return {
            host: "qoder",
            revisionId: revision.revisionId,
            exitCode: 0,
            output: "done",
            errorOutput: "",
            warnings: [],
            metrics: { turns: 1 },
          };
        },
      }),
    });
    const succeeded = await postAgui(started.url, {
      threadId: "t1",
      runId: "quiet-run",
      messages: [{ role: "user", content: "run" }],
    });
    const events = decodeSseStream(await succeeded.text());
    expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(events.at(-1)).toMatchObject({ result: { exitCode: 0, metrics: { turns: 1 } } });
  });

  it("rejects cross-origin and non-JSON browser requests unless an exact origin is allowed", async () => {
    started = await startHarnessUiServer({ source: SOURCE, executorFactory: scriptedExecutorFactory });
    const body = JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ role: "user", content: "run" }],
    });

    const hostile = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hostile.example" },
      body,
    });
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("access-control-allow-origin")).toBeNull();

    const nonJson = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
    });
    expect(nonJson.status).toBe(415);

    const sameOrigin = await fetch(`${started.url}/agui`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: started.url },
      body,
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(started.url);

    await started.close();
    started = await startHarnessUiServer({
      source: SOURCE,
      executorFactory: scriptedExecutorFactory,
      allowedOrigins: ["https://trusted.example"],
    });
    const allowed = await fetch(`${started.url}/agui`, {
      method: "OPTIONS",
      headers: { Origin: "https://trusted.example" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://trusted.example");
  });

  it("does not derive same-origin trust from a client-controlled non-loopback Host", async () => {
    started = await startHarnessUiServer({ source: SOURCE, executorFactory: scriptedExecutorFactory });
    const response = await postRaw(`${started.url}/agui`, {
      Host: "attacker.example",
      Origin: "http://attacker.example",
      "Content-Type": "application/json",
    }, JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ role: "user", content: "must not run" }],
    }));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "Browser origin 'http://attacker.example' is not allowed.",
    });
  });

  it("returns a structured 413 response for request bodies over 1 MiB", async () => {
    started = await startHarnessUiServer({ source: SOURCE, executorFactory: scriptedExecutorFactory });
    const body = "x".repeat(1_048_577);
    const declared = await postRaw(`${started.url}/agui`, {
      "Content-Type": "application/json",
    }, body);
    const chunked = await postRaw(`${started.url}/agui`, {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked",
    }, body, false);

    for (const response of [declared, chunked]) {
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toEqual({ error: "Request body exceeds 1048576 bytes." });
    }
  });

  it("fails fast on malformed allowed origins", async () => {
    await expect(startHarnessUiServer({
      source: SOURCE,
      allowedOrigins: ["https://trusted.example/path"],
    })).rejects.toThrow(/Invalid allowed browser origin/);
  });
});

describe("harness-ui CLI", () => {
  it("prints help and exits 0 without touching files or ports", async () => {
    const out: string[] = [];

    const code = await runHarnessUiCli(["--help"], {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("harness-ui serve <file.harness>");
  });

  it("fails with exit 2 on unknown options and missing subcommands", async () => {
    const errors: string[] = [];
    const io = { stdout: () => undefined, stderr: (text: string) => errors.push(text) };

    expect(await runHarnessUiCli(["--bogus"], io)).toBe(2);
    expect(await runHarnessUiCli(["serve"], io)).toBe(2);
    expect(errors.join("")).toContain("Unknown option '--bogus'");
  });

  it("parses repeatable exact browser origins", () => {
    const parsed = parseHarnessUiArgs([
      "serve",
      "agent.harness",
      "--allow-origin",
      "https://one.example",
      "--allow-origin",
      "http://localhost:5173",
    ]);

    expect(parsed.allowedOrigins).toEqual(["https://one.example", "http://localhost:5173"]);
  });
});
