import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { HarnessRunEmitter, MAX_RETAINED_TOOL_RESULT_BYTES } from "@qoder-ai/harness/exec";
import { startHarnessStudioServer } from "../../dist/server/server.js";

const SOURCE = `
  skill require-tests {
    description "Do not report the task complete until tests prove it."
  }
  workflow single-pass {
    stop when coder.done
  }
  harness browser-fixture {
    workflow single-pass
    agent coder {
      use skill require-tests
    }
  }
  target qoder
`;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let studio;
let experimentStudio;

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
  experimentStudio = await startHarnessStudioServer({
    appDir: resolve(packageRoot, "dist/app"),
    experimentManifestPath: resolve(packageRoot, "../harness/examples/checkpoint-experiment/experiment.json"),
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
});

test("correlates live ACP tool chains across three lanes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 576 });
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  await page.goto(experimentStudio.url);
  await expect(page.locator(".experiment-workbench-head")).toContainText("Live ACP tool paths");
  await expect(page.locator(".lane-column")).toHaveCount(3);
  await expect(page.locator(".lane-column").first().getByRole("button", { name: /Read README\.md/ })).toBeVisible();

  await page.getByRole("button", { name: "Run fresh lanes" }).click();
  await expect(page.locator(".lane-status-finished")).toHaveCount(2);
  await expect(page.locator(".lane-detail")).toHaveCount(0);
  await expect(page.locator(".lane-relation").nth(1)).toContainText("Exact match");
  await expect(page.locator(".lane-relation").nth(2)).toContainText("Same resource");
  await expect(page.locator(".selection-inspector")).toContainText("Previous → selected → next");
  await expect(page.locator(".chain-lane").nth(1)).toContainText("Read");
  await expect(page.locator(".chain-lane").nth(1)).toContainText("Edit");
  await expect(page.locator(".status-accept")).toContainText("accept");

  await page.screenshot({ path: testInfo.outputPath("experiment-tool-correlation.png") });
  const layout = await page.evaluate(() => {
    const shell = document.querySelector(".experiment-shell");
    const rail = document.querySelector(".experiment-rail");
    const workspaceHeader = document.querySelector(".experiment-workspace-header");
    const workbench = document.querySelector(".experiment-workbench");
    const header = document.querySelector(".lane-column > header");
    const toolList = document.querySelector(".lane-column:first-child .tool-trace");
    const rows = [...document.querySelectorAll(".lane-column:first-child .tool-trace button")];
    const laneRects = [...document.querySelectorAll(".lane-column")].map((element) => element.getBoundingClientRect());
    return {
      inner: window.innerWidth,
      document: document.documentElement.scrollWidth,
      shellWidth: shell?.getBoundingClientRect().width ?? 0,
      railWidth: rail?.getBoundingClientRect().width ?? 0,
      workspaceHeaderHeight: workspaceHeader?.getBoundingClientRect().height ?? Infinity,
      workbenchTop: workbench?.getBoundingClientRect().top ?? Infinity,
      laneHeaderHeight: header?.getBoundingClientRect().height ?? Infinity,
      toolRowHeight: rows[0]?.getBoundingClientRect().height ?? Infinity,
      toolListHeight: toolList?.getBoundingClientRect().height ?? 0,
      firstLaneGap: laneRects.length > 1 ? laneRects[1].left - laneRects[0].right : Infinity,
    };
  });
  expect(layout.document).toBe(layout.inner);
  expect(layout.shellWidth).toBe(layout.inner);
  expect(layout.railWidth).toBeGreaterThanOrEqual(220);
  expect(layout.railWidth).toBeLessThanOrEqual(240);
  expect(layout.workspaceHeaderHeight).toBe(42);
  expect(layout.workbenchTop).toBeLessThanOrEqual(52);
  expect(layout.laneHeaderHeight).toBeLessThanOrEqual(40);
  expect(layout.toolRowHeight).toBeLessThanOrEqual(30);
  expect(layout.firstLaneGap).toBeLessThanOrEqual(1);
  expect(layout.toolListHeight / layout.toolRowHeight).toBeGreaterThan(6);
  expect(browserErrors).toEqual([]);
});

test("contains narrow experiment scrolling inside the comparison regions", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto(experimentStudio.url);
  await expect(page.locator(".lane-column")).toHaveCount(3);
  await expect(page.locator(".experiment-rail")).toHaveCSS("width", "230px");
  await page.setViewportSize({ width: 390, height: 844 });
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

  await page.getByRole("button", { name: "Show experiment context" }).click();
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
