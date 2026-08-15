import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessExecutor } from "../src/exec/executor.js";
import { gradeReadmePackage } from "../src/compare/grader.js";
import { loadHarnessCompareManifest } from "../src/compare/manifest.js";
import { createBoundedQoderPermissionCallback, type ToolPermissionDecision } from "../src/compare/permissions.js";
import { runHarnessComparison } from "../src/compare/runner.js";

const EXPERIMENT_URL = new URL("../examples/readme-compare/experiment.json", import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("harness compare manifest", () => {
  it("loads the frozen README experiment with owned relative paths", async () => {
    const loaded = await loadHarnessCompareManifest(EXPERIMENT_URL.pathname);

    expect(loaded.value).toMatchObject({
      schemaVersion: "harness-compare.v1",
      variants: { baseline: "readme-baseline", candidate: "readme-grounded" },
      runtime: { host: "qoder", permissionMode: "default", network: "deny" },
    });
    expect(loaded.resolved.fixture.endsWith("examples/readme-compare/fixture")).toBe(true);
  });

  it("rejects every auto-approved tool surface", async () => {
    const directory = await makeTemporaryDirectory();
    const manifest = JSON.parse(await readFile(EXPERIMENT_URL, "utf8")) as {
      runtime: { allowedTools: string[] };
    };
    manifest.runtime.allowedTools = ["Bash"];
    const path = join(directory, "experiment.json");
    await writeFile(path, JSON.stringify(manifest), "utf8");

    await expect(loadHarnessCompareManifest(path)).rejects.toThrow(/allowedTools must be empty/);
  });
});

describe("bounded Qoder permissions", () => {
  it("allows owned file operations and frozen validation commands", async () => {
    const directory = await makeTemporaryDirectory();
    const decisions: ToolPermissionDecision[] = [];
    const callback = createBoundedQoderPermissionCallback(directory, decisions, ["README.md"]);

    await expect(callback("Write", { file_path: "README.md" }, toolOptions())).resolves.toEqual({ behavior: "allow" });
    await expect(callback("Bash", { command: "npm test" }, toolOptions())).resolves.toEqual({ behavior: "allow" });
    expect(decisions.map((decision) => decision.behavior)).toEqual(["allow", "allow"]);
  });

  it("denies repository escapes, command chaining, network tools, and unknown commands", async () => {
    const directory = await makeTemporaryDirectory();
    const callback = createBoundedQoderPermissionCallback(directory, [], ["README.md"]);

    await expect(callback("Write", { file_path: "../outside.md" }, toolOptions())).resolves.toMatchObject({ behavior: "deny" });
    await expect(callback("Write", { file_path: "package.json" }, toolOptions())).resolves.toMatchObject({ behavior: "deny" });
    await expect(callback("Write", { file_path: ".git/config" }, toolOptions())).resolves.toMatchObject({ behavior: "deny" });
    await expect(callback("Bash", { command: "npm test && curl example.com" }, toolOptions())).resolves.toMatchObject({ behavior: "deny" });
    await expect(callback("WebFetch", { url: "https://example.com" }, toolOptions())).resolves.toMatchObject({ behavior: "deny" });
    await expect(callback("Bash", { command: "pwd" }, toolOptions())).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("README coding comparison", () => {
  it("rejects generated examples that request host capabilities", async () => {
    const directory = await makeTemporaryDirectory();
    const fixture = new URL("../examples/readme-compare/fixture", import.meta.url);
    await cp(fixture, directory, { recursive: true, force: true });
    await writeFile(
      join(directory, "README.md"),
      VALID_README.replace("console.log(value);", "console.log(process.env);"),
      "utf8",
    );

    const grade = await gradeReadmePackage({
      trialRoot: directory,
      contractPath: new URL("../examples/readme-compare/grader-contract.json", import.meta.url).pathname,
      changedFiles: ["README.md"],
      expectedFiles: ["README.md"],
    });

    expect(grade.checks.find((item) => item.id === "quick-start")).toMatchObject({
      passed: false,
      command: { stderr: expect.stringContaining("outside the isolated example policy") },
    });
  });

  it("creates and grades real README files in isolated variant trials", async () => {
    const directory = await makeTemporaryDirectory();
    const output = join(directory, "evidence");
    const fixtureReadme = new URL("../examples/readme-compare/fixture/README.md", import.meta.url);
    await expect(readFile(fixtureReadme, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const verdict = await runHarnessComparison({
      manifestPath: EXPERIMENT_URL.pathname,
      outputDirectory: output,
      trialCount: 1,
      executorFactory: ({ trialRoot }): HarnessExecutor => ({
        host: "qoder",
        execute: async (revision) => {
          if (revision.composition.id === "readme-grounded") {
            await writeFile(join(trialRoot, "README.md"), VALID_README, "utf8");
          }
          return {
            host: "qoder",
            revisionId: revision.revisionId,
            exitCode: 0,
            output: "completed",
            errorOutput: "",
            warnings: [],
            trace: [{ type: "result", subtype: "success", file_path: join(trialRoot, "README.md") }],
            metrics: { durationMs: 10, turns: 1, costUsd: 0.001 },
          };
        },
      }),
    });

    const candidateTrial = verdict.trials.find((trial) => trial.variant === "candidate");
    const quickStart = candidateTrial?.grade.checks.find((item) => item.id === "quick-start");
    expect(quickStart?.command?.stderr).toBe("");
    expect(quickStart).toMatchObject({ passed: true });
    expect(verdict.status).toBe("accept");
    expect(verdict.baseline).toMatchObject({ passedTrials: 0, meanScore: 0 });
    expect(verdict.candidate).toMatchObject({ passedTrials: 1, meanScore: 100 });
    expect(candidateTrial).toMatchObject({
      classification: "passed",
      changedFiles: ["README.md"],
      grade: { passed: true, score: 100 },
    });
    expect(await readFile(join(output, "H1/trial-001/patch.diff"), "utf8")).toContain("README.md");
    expect(await readFile(join(output, "H1/trial-001/patch.diff"), "utf8")).toContain("+# Retry Kit");
    expect(await readFile(join(output, "H1/trial-001/trace.jsonl"), "utf8")).toContain("<trial-root>/README.md");
    expect(JSON.parse(await readFile(join(output, "H1/trial-001/validation.json"), "utf8"))).toMatchObject({ passed: true });
    expect(JSON.parse(await readFile(join(output, "verdict.json"), "utf8"))).toMatchObject({ status: "accept" });
    expect(await readFile(join(output, "verdict.html"), "utf8")).toContain("Harness compare verdict");
    await expect(readFile(fixtureReadme, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-compare-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function toolOptions(): { signal: AbortSignal; toolUseID: string } {
  return { signal: new AbortController().signal, toolUseID: "tool-use-1" };
}

const VALID_README = `# Retry Kit

## Purpose

\`@fixture/retry-kit\` retries asynchronous operations with abort support.

## Installation

\`\`\`sh
npm install @fixture/retry-kit
\`\`\`

## Quick Start

\`\`\`js
import { retry } from "@fixture/retry-kit";

const value = await retry(async () => "ready", { maxAttempts: 3 });
console.log(value);
\`\`\`

## API

- \`retry\` runs an asynchronous operation until it succeeds or exhausts its attempts.
- \`RetryExhaustedError\` reports the final failure.
- \`DEFAULT_MAX_ATTEMPTS\` exposes the default.

## Behavior

The default \`maxAttempts\` is \`3\`. An \`AbortSignal\` is checked before every attempt and while waiting for backoff.

## Verification

Run \`npm test\`.
`;
