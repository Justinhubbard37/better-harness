import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUPPORT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SUPPORT_DIR, "../..");
const TEST_ROOT = path.join(REPO_ROOT, "test");
const RESULTS_ROOT = path.join(REPO_ROOT, "test-results");
const REPORTER_PATH = path.join(SUPPORT_DIR, "github-actions-reporter.mjs");

export async function discoverTestCategories(testRoot = TEST_ROOT) {
  const entries = await readdir(testRoot, { withFileTypes: true });
  const categories = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(testRoot, entry.name);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((file) => file.isFile() && file.name.endsWith(".test.mjs"))
      .map((file) => path.join(directory, file.name))
      .sort();
    if (files.length > 0) categories.push({ name: entry.name, files });
  }
  return categories;
}

function durationLabel(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function writeStepSummary(rows, summaryPath) {
  if (!summaryPath) return;
  const markdown = [
    "## Test results by capability",
    "",
    "| Capability | Files | Status | Duration |",
    "| --- | ---: | --- | ---: |",
    ...rows.map((row) => `| ${row.name} | ${row.files} | ${row.status === 0 ? "pass" : "fail"} | ${durationLabel(row.durationMs)} |`),
    "",
  ].join("\n");
  await appendFile(summaryPath, markdown, "utf8");
}

export async function runCiTests(selectedNames = process.argv.slice(2), {
  cwd = REPO_ROOT,
  env = process.env,
  resultsRoot = RESULTS_ROOT,
  stderr = process.stderr,
  stdio = "inherit",
  stdout = process.stdout,
  testRoot = TEST_ROOT,
} = {}) {
  const discovered = await discoverTestCategories(testRoot);
  const selected = selectedNames.length === 0
    ? discovered
    : discovered.filter((category) => selectedNames.includes(category.name));
  const missing = selectedNames.filter((name) => !discovered.some((category) => category.name === name));
  if (missing.length > 0) {
    stderr.write(`Unknown test capabilities: ${missing.join(", ")}\n`);
    return 64;
  }

  await mkdir(resultsRoot, { recursive: true });
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const rows = [];
  for (const category of selected) {
    const junitPath = path.join(resultsRoot, `${category.name}.xml`);
    await rm(junitPath, { force: true });
    const grouped = env.GITHUB_ACTIONS === "true";
    if (grouped) stdout.write(`::group::Tests: ${category.name}\n`);
    else stdout.write(`\n## Tests: ${category.name}\n`);

    const started = performance.now();
    const result = spawnSync(process.execPath, [
      "--test",
      `--test-reporter=${REPORTER_PATH}`,
      "--test-reporter=junit",
      "--test-reporter-destination=stdout",
      `--test-reporter-destination=${junitPath}`,
      ...category.files,
    ], {
      cwd,
      env: childEnv,
      stdio,
      windowsHide: true,
    });
    const durationMs = performance.now() - started;
    const status = Number.isInteger(result.status) ? result.status : 1;
    rows.push({ name: category.name, files: category.files.length, status, durationMs });
    if (result.error) stderr.write(`${result.error.message}\n`);
    if (grouped) stdout.write("::endgroup::\n");
  }

  await writeStepSummary(rows, env.GITHUB_STEP_SUMMARY);
  const failed = rows.filter((row) => row.status !== 0);
  stdout.write(`\nTest capabilities: ${rows.length - failed.length} passed, ${failed.length} failed.\n`);
  if (failed.length > 0) stderr.write(`Failed capabilities: ${failed.map((row) => row.name).join(", ")}\n`);
  return failed.length === 0 ? 0 : 1;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await runCiTests();
