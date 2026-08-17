import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { HarnessRunEmitter, MAX_RETAINED_TOOL_RESULT_BYTES } from "@qoder-ai/harness/exec";
import { startHarnessStudioServer } from "../../dist/server/server.js";

const SOURCE = `
  language 0.3
  skill require-tests {
    description "Do not report the task complete until tests prove it."
  }
  workflow single-pass {
    session coder
  }
  harness browser-fixture {
    workflow single-pass
    agent coder {
      use skill require-tests
    }
  }
  runtime qoder {
    adapter "@harness/adapter-qoder"
  }
  deployment browser-fixture-qoder {
    harness browser-fixture
    runtime qoder
  }
`;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let studio;
let experimentStudio;
let lockedFixtureDir;

test.beforeAll(async () => {
  studio = await startHarnessStudioServer({
    appDir: resolve(packageRoot, "dist/app"),
    harnessSource: SOURCE,
    executorFactory: (context) => ({
      host: "qoder",
      async execute(revision) {
        const emitter = new HarnessRunEmitter(context.onRunEvent);
        emitter.start({ revisionId: revision.revisionId, host: "qoder" });
        emitter.text("Running the browser regression.");
        emitter.toolCall("Bash", { toolUseId: "tu_failed", input: { command: "npm test" } });
        emitter.toolResult(
          "tu_failed",
          `command failed\n${"x".repeat(MAX_RETAINED_TOOL_RESULT_BYTES + 1_024)}`,
          { messageId: "result_failed", isError: true },
        );
        emitter.finish(0);
        return {
          host: "qoder",
          revisionId: revision.revisionId,
          exitCode: 0,
          output: "Running the browser regression.",
          errorOutput: "",
          warnings: [],
        };
      },
    }),
  });
  lockedFixtureDir = await mkdtemp(join(tmpdir(), "studio-browser-lock-"));
  await cp(resolve(packageRoot, "../harness/examples/checkpoint-experiment"), lockedFixtureDir, { recursive: true });
  const historyDescriptor = { id: "browser-project-history-v1", label: "Project agent history" };
  const historyItems = [
    { id: "episode_alpha", title: "Original checkpoint inspection", requestPreview: "Inspect the original checkpoint.", occurredAt: "2026-08-16T08:00:00.000Z", adapter: historyDescriptor, provenance: "unverified-history", checkpointVerified: false },
    { id: "episode_beta", title: "ACP correlation request", requestPreview: "Compare ACP tool chains across lanes.", occurredAt: "2026-08-17T08:00:00.000Z", adapter: historyDescriptor, provenance: "verified-history", checkpointVerified: true },
  ];
  const historyAdapter = {
    descriptor: historyDescriptor,
    async list() { return { adapter: historyDescriptor, items: historyItems }; },
    async resolve(id) {
      const item = historyItems.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Unknown history item ${id}`);
      return {
        item,
        checkpointRef: { planPath: "/adapter/checkpoint.json", digest: `sha256:${(id === "episode_beta" ? "b" : "a").repeat(64)}` },
        checkpointSource: {
          status: "ready",
          adapter: historyDescriptor,
          resource: { label: "Project", value: "better-harness" },
          revision: { label: "Checkpoint", value: id === "episode_beta" ? "beta-42" : "alpha-17" },
          history: { label: "Episode", value: item.title },
          materialization: { label: "Isolated checkout", value: "10 copies", timing: "on-run", count: 10 },
          capabilities: { isolatedMaterialization: true, observedHistory: true, preserveResult: true },
        },
        request: {
          promptPath: "/adapter/prompt.md",
          prompt: id === "episode_beta" ? "Compare ACP tool chains across lanes.\n" : "Inspect the original checkpoint.\n",
          promptHash: `sha256:${(id === "episode_beta" ? "d" : "c").repeat(64)}`,
          verified: item.provenance === "verified-history",
        },
        observed: { trajectoryPath: "/adapter/trajectory.jsonl", startCheckpointVerified: item.checkpointVerified, identity: { harnessId: "readme-grounded", model: "performance" } },
      };
    },
  };
  experimentStudio = await startHarnessStudioServer({
    appDir: resolve(packageRoot, "dist/app"),
    experimentManifestPath: resolve(packageRoot, "../harness/examples/checkpoint-experiment/experiment.json"),
    checkpointSourcePreview: {
      status: "ready",
      adapter: { id: "browser-fixture-v1", label: "Versioned project fixture" },
      resource: { label: "Repository", value: "better-harness" },
      revision: { label: "Commit", value: "b80dccd3e3cc", detail: "tree e9b137fe3e0b" },
      history: { label: "Session position", value: "fixture · checkpoint" },
      materialization: {
        label: "Detached worktree",
        value: "10 isolated copies",
        detail: "Created per fresh trial only after Run",
        timing: "on-run",
        count: 10,
      },
      capabilities: { isolatedMaterialization: true, observedHistory: true, preserveResult: true },
    },
    checkpointHistoryAdapter: historyAdapter,
    experimentLocker: async ({ history }) => {
      await writeFile(join(lockedFixtureDir, "prompt.md"), history.request.prompt, "utf8");
      return {
        manifestPath: join(lockedFixtureDir, "experiment.json"),
        receipt: {
          lockId: `lock_${history.item.id}`,
          historyId: history.item.id,
          manifestDigest: `sha256:${"e".repeat(64)}`,
          checkpointDigest: history.checkpointRef.digest,
          manifestName: "experiment.json",
        },
      };
    },
    experimentRunner: async (options) => {
      const emit = (type, laneId, runId, event) => options.onEvent?.({
        type,
        experimentId: options.experimentId,
        laneId,
        runId,
        at: new Date().toISOString(),
        ...(event ? { event } : {}),
      });
      for (const laneId of ["fresh-default", "fresh-minimal"]) {
        const runId = `${options.experimentId}:${laneId}:1`;
        emit("lane-preparing", laneId, runId);
        emit("lane-started", laneId, runId);
        const readInput = laneId === "fresh-default" ? { path: "README.md" } : { file_path: "README.md" };
        emit("lane-event", laneId, runId, { type: "tool-call-started", toolCallId: "read", toolName: "Read", input: readInput });
        emit("lane-event", laneId, runId, { type: "tool-call-result", toolCallId: "read", content: "# fixture" });
        emit("lane-event", laneId, runId, { type: "tool-call-started", toolCallId: "edit", toolName: "Edit", input: { path: "README.md" } });
        emit("lane-event", laneId, runId, { type: "tool-call-result", toolCallId: "edit", content: "updated" });
        emit("lane-event", laneId, runId, { type: "tool-call-started", toolCallId: "test", toolName: "Bash", input: { command: laneId === "fresh-default" ? "npm test" : "npm run test" } });
        emit("lane-event", laneId, runId, { type: "tool-call-result", toolCallId: "test", content: "passed" });
        emit("lane-finished", laneId, runId);
      }
      const compareSet = {
        contrasts: [
          { id: "profile-effect", lanes: ["fresh-default", "fresh-minimal"], status: "accept", reason: "Matched trials favor the candidate profile." },
          { id: "history-context", lanes: ["history", "fresh-default", "fresh-minimal"], status: "descriptive", reason: "Historical identity is incomplete." },
        ],
      };
      options.onEvent?.({
        type: "experiment-finished",
        experimentId: options.experimentId,
        laneId: null,
        runId: null,
        at: new Date().toISOString(),
        compareSet,
      });
      return compareSet;
    },
  });
});

test.afterAll(async () => {
  await studio?.close();
  await experimentStudio?.close();
  if (lockedFixtureDir) await rm(lockedFixtureDir, { recursive: true, force: true });
});

test("compares a focused ACP pair across roles, views, filters, and evidence", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 576 });
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  await page.goto(experimentStudio.url);
  await expect(page.getByRole("heading", { name: "Compare a past agent run" })).toBeVisible();
  await expect(page.locator(".setup-details")).not.toHaveAttribute("open", "");
  await expect(page.getByLabel("History checkpoint")).toHaveValue("episode_alpha");
  await page.getByLabel("History checkpoint").selectOption("episode_beta");
  await expect(page.locator(".history-picker-meta")).toContainText("Ready");
  await expect(page.locator(".setup-summary")).toContainText("beta-42");
  await expect(page.locator(".setup-summary")).toContainText("qoder-default-v1 vs qoder-minimal-v1");
  await page.locator(".setup-details > summary").click();
  await expect(page.locator(".checkpoint-facts")).toContainText("Checkpoint");
  await expect(page.locator(".checkpoint-facts")).toContainText("beta-42");
  await expect(page.locator(".request-preview")).toContainText("Compare ACP tool chains across lanes.");
  await expect(page.locator(".variant-row")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Lock and compare" })).toBeEnabled();
  await page.getByRole("button", { name: "Lock and compare" }).click();
  await expect(page.getByRole("heading", { name: "Compare traces" })).toBeVisible();
  await expect(page.locator(".object-card")).toHaveCount(3);
  await expect(page.locator(".object-card").nth(0)).toContainText("Reference");
  await expect(page.locator(".object-card").nth(1)).toContainText("Baseline");
  await expect(page.locator(".object-card").nth(2)).toContainText("Candidate");
  await expect(page.locator(".comparability")).toContainText("Controlled");
  await expect(page.locator(".call-lane")).toHaveCount(2);

  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.locator(".lane-status-finished")).toHaveCount(2);
  await expect(page.locator(".lane-detail")).toHaveCount(0);
  await expect(page.locator(".lane-relation").nth(0)).toContainText("Exact match");
  await expect(page.locator(".lane-relation").nth(1)).toContainText("Same resource");
  await expect(page.locator(".local-chain")).toContainText("Previous → selected → next");
  await expect(page.locator(".local-chain article").nth(0)).toContainText("Read");
  await expect(page.locator(".local-chain article").nth(0)).toContainText("Edit");

  await page.getByLabel("Filter calls").fill("npm test");
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByLabel("Filter calls").fill("");
  await expect(page.getByRole("treeitem")).toHaveCount(6);

  await page.getByText("Diff only", { exact: true }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(4);
  await page.getByText("Diff only", { exact: true }).click();
  const candidateBash = page.locator(".call-lane").nth(1).getByRole("treeitem", { name: /Bash command:npm run test/ });
  await candidateBash.click();
  await expect(page.locator(".call-group button.selected")).toHaveCount(2);
  await page.getByText("Sync", { exact: true }).click();
  await page.locator(".call-lane").nth(1).getByRole("treeitem", { name: /Read README\.md/ }).click();
  await expect(page.locator(".call-group button.selected")).toHaveCount(1);

  await page.getByRole("tab", { name: "Summary" }).click();
  await expect(page.locator(".summary-grid")).toContainText("Outcome");
  await expect(page.locator(".summary-grid")).toContainText("accept");
  await page.getByRole("tab", { name: "Trace" }).click();
  await page.getByRole("button", { name: "Resources" }).click();
  await expect(page.locator(".changes-view")).toContainText("shared resources");
  await page.getByRole("button", { name: "Calls" }).click();
  await page.getByRole("tab", { name: "Evidence" }).click();
  await expect(page.locator(".evidence-view")).toContainText("No global verdict");
  await expect(page.locator(".status-accept")).toContainText("accept");
  await page.locator("button.object-card.role-candidate").click();
  await expect(page.locator("button.object-card.role-baseline")).toContainText("fresh-minimal");
  await page.getByRole("tab", { name: "Trace" }).click();

  await page.screenshot({ path: testInfo.outputPath("experiment-tool-correlation.png") });
  const layout = await page.evaluate(() => {
    const shell = document.querySelector(".experiment-shell");
    const rail = document.querySelector(".experiment-rail");
    const workspaceHeader = document.querySelector(".experiment-workspace-header");
    const surface = document.querySelector(".compare-surface");
    const header = document.querySelector(".call-lane-head");
    const toolList = document.querySelector(".call-lane:first-child .call-tree");
    const rows = [...document.querySelectorAll(".call-lane:first-child .call-group button")];
    const laneRects = [...document.querySelectorAll(".call-lane")].map((element) => element.getBoundingClientRect());
    const rowFontSize = rows[0] ? Number.parseFloat(getComputedStyle(rows[0]).fontSize) : 0;
    return {
      inner: window.innerWidth,
      document: document.documentElement.scrollWidth,
      shellWidth: shell?.getBoundingClientRect().width ?? 0,
      railWidth: rail?.getBoundingClientRect().width ?? 0,
      workspaceHeaderHeight: workspaceHeader?.getBoundingClientRect().height ?? Infinity,
      surfaceTop: surface?.getBoundingClientRect().top ?? Infinity,
      laneHeaderHeight: header?.getBoundingClientRect().height ?? Infinity,
      toolRowHeight: rows[0]?.getBoundingClientRect().height ?? Infinity,
      toolListHeight: toolList?.getBoundingClientRect().height ?? 0,
      firstLaneGap: laneRects.length > 1 ? laneRects[1].left - laneRects[0].right : Infinity,
      rowFontSize,
    };
  });
  expect(layout.document).toBe(layout.inner);
  expect(layout.shellWidth).toBe(layout.inner);
  expect(layout.railWidth).toBeGreaterThanOrEqual(220);
  expect(layout.railWidth).toBeLessThanOrEqual(240);
  expect(layout.workspaceHeaderHeight).toBe(42);
  expect(layout.surfaceTop).toBeLessThanOrEqual(52);
  expect(layout.laneHeaderHeight).toBeLessThanOrEqual(52);
  expect(layout.toolRowHeight).toBeLessThanOrEqual(30);
  expect(layout.rowFontSize).toBeGreaterThanOrEqual(11);
  expect(layout.firstLaneGap).toBeLessThanOrEqual(1);
  expect(layout.toolListHeight / layout.toolRowHeight).toBeGreaterThan(6);
  expect(browserErrors).toEqual([]);
});

test("contains narrow experiment scrolling inside the comparison regions", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto(experimentStudio.url);
  await expect(page.getByRole("button", { name: "Lock and compare" })).toBeEnabled();
  await page.getByRole("button", { name: "Lock and compare" }).click();
  await expect(page.locator(".object-card")).toHaveCount(3);
  await expect(page.locator(".call-lane")).toHaveCount(2);
  await expect(page.locator(".experiment-rail")).toHaveCSS("width", "230px");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".experiment-rail")).toHaveCSS("width", "46px");
  const dimensions = await page.evaluate(() => ({
    inner: window.innerWidth,
    document: document.documentElement.scrollWidth,
    rail: document.querySelector(".experiment-rail")?.getBoundingClientRect().width,
    boardClient: document.querySelector(".experiment-workspace-scroll")?.clientWidth,
    boardScroll: document.querySelector(".experiment-workspace-scroll")?.scrollWidth,
  }));
  expect(dimensions.document).toBe(dimensions.inner);
  expect(dimensions.rail).toBe(46);
  expect(dimensions.boardScroll).toBeGreaterThan(dimensions.boardClient);

  await page.getByRole("button", { name: "Show comparison context" }).click();
  await expect(page.locator(".experiment-rail")).toHaveCSS("width", "230px");
  const expandedWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(expandedWidth).toBe(390);
});

test("renders a keyboard-expandable failed and truncated Tool Call at 390px", async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  await page.goto(studio.url);
  await page.getByPlaceholder("Task prompt for the harness run…").fill("Run the scripted browser fixture");
  await page.getByRole("button", { name: "Run harness" }).click();

  await expect(page.locator(".run-status strong")).toHaveText("finished");
  const card = page.locator("details.tool-card");
  await expect(card.locator(".tool-status")).toHaveText("Failed");

  const summary = card.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("open", "");
  await expect(card.getByRole("heading", { name: "Arguments" })).toBeVisible();
  await expect(card.getByText(/Result truncated from [\d,]+ bytes/)).toBeVisible();
  await expect(card.getByText("run_", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tool-call-390.png"), fullPage: true });

  await page.keyboard.press("Enter");
  await expect(card).not.toHaveAttribute("open", "");
  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions).toEqual({ innerWidth: 390, documentWidth: 390, bodyWidth: 390 });
  expect(browserErrors).toEqual([]);
});
