import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { githubFailureAnnotation } from "../support/github-actions-reporter.mjs";
import { discoverTestCategories, nodeTestFileArgument, runCiTests } from "../support/run-ci.mjs";

const REPORTER_PATH = fileURLToPath(new URL("../support/github-actions-reporter.mjs", import.meta.url));

test("CI test discovery finds capability tests without treating support or fixtures as categories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-test-discovery-"));
  try {
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await mkdir(path.join(root, "support"), { recursive: true });
    await mkdir(path.join(root, "fixtures"), { recursive: true });
    await writeFile(path.join(root, "sessions", "usage.test.mjs"), "export {};\n");
    await writeFile(path.join(root, "support", "runner.mjs"), "export {};\n");
    await writeFile(path.join(root, "fixtures", "helper.mjs"), "export {};\n");

    assert.deepEqual(await discoverTestCategories(root), [{
      name: "sessions",
      files: [path.join(root, "sessions", "usage.test.mjs")],
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI test files use portable relative arguments on Windows", () => {
  assert.equal(nodeTestFileArgument(
    "D:\\a\\better-harness\\better-harness\\test\\agents\\example.test.mjs",
    {
      cwd: "D:\\a\\better-harness\\better-harness",
      pathApi: path.win32,
    },
  ), "./test/agents/example.test.mjs");
});

test("GitHub failure annotations retain location and escape command data", () => {
  const annotation = githubFailureAnnotation({
    name: "rejects bad, input: safely",
    file: path.join(process.cwd(), "test", "governance", "example.test.mjs"),
    line: 17,
    column: 4,
    details: { error: new Error("first line\nsecond 100%") },
  });

  assert.ok(annotation.startsWith("::error file=test/governance/example.test.mjs,line=17,col=4,"));
  assert.ok(annotation.includes("title=Test failed%3A rejects bad%2C input%3A safely"));
  assert.ok(annotation.includes("first line%0Asecond 100%25"));
});

test("the custom reporter turns a real Node test failure into one GitHub annotation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-test-reporter-"));
  const failingTest = path.join(root, "failure.test.mjs");
  try {
    await writeFile(failingTest, [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("example reporter failure", () => assert.equal(1, 2));',
      "",
    ].join("\n"));
    const childEnv = { ...process.env, GITHUB_ACTIONS: "true" };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      "--test",
      `--test-reporter=${REPORTER_PATH}`,
      "--test-reporter-destination=stdout",
      failingTest,
    ], {
      cwd: root,
      encoding: "utf8",
      env: childEnv,
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.split("::error ").length - 1, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes("title=Test failed%3A example reporter failure"));
    assert.ok(result.stdout.includes("Expected values to be strictly equal"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CI runner continues after a failed capability and summarizes every result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-test-runner-"));
  const resultsRoot = path.join(root, "results");
  const summaryPath = path.join(root, "summary.md");
  try {
    await mkdir(path.join(root, "alpha"));
    await mkdir(path.join(root, "omega"));
    await writeFile(path.join(root, "alpha", "failure.test.mjs"), [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("intentional failure", () => assert.equal(1, 2));',
      "",
    ].join("\n"));
    await writeFile(path.join(root, "omega", "success.test.mjs"), [
      'import test from "node:test";',
      'test("success after failure", () => {});',
      "",
    ].join("\n"));

    const status = await runCiTests([], {
      cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_STEP_SUMMARY: summaryPath },
      resultsRoot,
      stderr: { write: () => true },
      stdio: "pipe",
      stdout: { write: () => true },
      testRoot: root,
    });

    assert.equal(status, 1);
    assert.deepEqual((await readdir(resultsRoot)).sort(), ["alpha.xml", "omega.xml"]);
    const summary = await readFile(summaryPath, "utf8");
    assert.ok(summary.includes("| alpha | 1 | fail |"));
    assert.ok(summary.includes("| omega | 1 | pass |"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
