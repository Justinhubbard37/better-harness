import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { HarnessRunEmitter } from "@qoder-ai/harness/exec";
import { resolveCanvasRuntime } from "../../dist/server/artifact-viewer-runtime.js";
import { discoverCanvasViewers, matchCanvasViewer } from "../../dist/server/artifact-viewers.js";
import { startHarnessStudioServer } from "../../dist/server/server.js";
import { sessionFromRetainedRun } from "../../dist/app/session-debugger-model.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canvasSdkRoot = process.env.CANVAS_SDK_ROOT ?? resolve(packageRoot, "../../../canvas-sdk");
const canvasViewerRoot = join(homedir(), ".qoder", "canvas", "canvases");
const pptxFixture = join(canvasSdkRoot, "packages/viewer-pptx/test/fixtures/officecli-parity/pptx-parity.pptx");
const PPTX_REQUIREMENT = "needs a provisioned Qoder Canvas pptx viewer, the canvas-sdk runtime, and a real deck fixture";

let studio;
let emptyStudio;
let pptxReady = false;
let selectedWorkspace;

// The PPTX scenarios exercise a real provisioned Canvas viewer, the canvas-sdk
// checkout hosting it, and a real deck. A clean machine has none of the three,
// so probe them once and let those scenarios report as skipped instead of
// failing every artifact test on a missing external file.
async function detectProvisionedPptx() {
  const fixtureAvailable = await stat(pptxFixture).then((value) => value.isFile()).catch(() => false);
  if (!fixtureAvailable) return false;
  if (resolveCanvasRuntime({ sdkRoot: canvasSdkRoot }) === undefined) return false;
  const viewers = await discoverCanvasViewers(canvasViewerRoot);
  return matchCanvasViewer({ label: "deck.pptx", kind: "binary" }, viewers) !== undefined;
}

test.beforeAll(async () => {
  pptxReady = await detectProvisionedPptx();
  const artifactDirectory = await mkdtemp(join(tmpdir(), "studio-artifact-browser-"));
  if (pptxReady) await copyFile(pptxFixture, join(artifactDirectory, "deck.pptx"));
  await writeFile(join(artifactDirectory, "component.tsx"), 'export default () => <p data-danger="not-executed">artifact source</p>;\n', "utf8");
  await writeFile(join(artifactDirectory, "change.patch"), [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
  ].join("\n"), "utf8");
  await writeFile(join(artifactDirectory, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><script>parent.document.body.dataset.svgExecuted="yes"</script><text x="12" y="44">Safe SVG artifact</text></svg>', "utf8");
  studio = await startHarnessStudioServer({
    appDir: join(packageRoot, "dist", "app"),
    artifactDirectory,
    canvasSdkRoot,
    canvasViewerRoot,
    port: 0,
  });
  selectedWorkspace = await mkdtemp(join(tmpdir(), "studio-project-workspace-"));
  const retainedRun = (id, savedAt, prompt, tools) => ({
    id,
    savedAt,
    prompt,
    status: "finished",
    toolCallCount: tools.length,
    warnings: [],
    timeline: [
      ...tools.map((name, index) => ({ kind: "tool-call", id: `tool_${index}`, name, argsText: "{}", status: "completed", resultText: "ok" })),
      { kind: "message", id: "message_1", text: `${prompt} complete`, complete: true },
    ],
  });
  const workspaceRecords = [
    retainedRun("run_left", "2026-08-20T10:00:00.000Z", "Repair parser", ["Read", "Edit", "Bash"]),
    retainedRun("run_right", "2026-08-20T11:00:00.000Z", "Repair renderer", ["Read", "Bash"]),
  ];
  emptyStudio = await startHarnessStudioServer({
    appDir: join(packageRoot, "dist", "app"),
    canvasSdkRoot,
    canvasViewerRoot,
    port: 0,
    workspaceDirectoryPicker: async () => selectedWorkspace,
    workspaceSessionProvider: {
      discover: async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
        return {
          label: "fixture-project",
          providers: [{ provider: "qoder", status: "ok", discovered: 2, included: 2 }],
          sessions: workspaceRecords.map((record) => ({
            summary: { id: `qoder:${record.id}`, savedAt: record.savedAt, prompt: record.prompt, status: "observed", toolCallCount: record.toolCallCount, provider: "qoder", messageCount: 1, warningCount: 0 },
            debugger: { ...sessionFromRetainedRun(record), id: `qoder:${record.id}`, agent: "qoder", protocol: "Inspector normalized local evidence", connection: "observed" },
          })),
        };
      },
    },
    executorFactory: (context) => ({
      host: "qoder",
      async execute(revision, _bundle, task) {
        const emitter = new HarnessRunEmitter(context.onRunEvent);
        emitter.start({ revisionId: revision.revisionId, host: "qoder" });
        emitter.text(`default harness: ${task.prompt}`);
        emitter.finish(0);
        return {
          host: "qoder",
          revisionId: revision.revisionId,
          exitCode: 0,
          output: `default harness: ${task.prompt}`,
          errorOutput: "",
          warnings: [],
        };
      },
    }),
  });
});

test.afterAll(async () => {
  await studio?.close();
  await emptyStudio?.close();
  if (selectedWorkspace) await rm(selectedWorkspace, { recursive: true, force: true });
});

function watchFailures(page) {
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("pageerror", (error) => failures.push(error.message));
  return failures;
}

async function openArtifacts(page) {
  await page.goto(`${studio.url}/#/artifacts`);
  // The first viewer discovery can be cold on machines with a provisioned
  // Canvas catalog, so wait for the catalog boundary instead of assuming a
  // five-second filesystem scan.
  await expect(page.getByRole("button", { name: /component\.tsx/ })).toBeVisible({ timeout: 15_000 });
}

test("keeps generated TSX inert and renders its source", async ({ page }) => {
  const failures = watchFailures(page);
  await openArtifacts(page);
  await page.getByRole("button", { name: /component\.tsx/ }).click();
  await expect(page.locator(".artifact-code-preview")).toContainText("data-danger");
  await expect(page.locator('[data-danger="not-executed"]')).toHaveCount(0);
  await expect(page.locator(".artifact-preview-pane iframe")).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("renders code diff and sandboxes SVG without script capability", async ({ page }) => {
  await openArtifacts(page);
  await page.getByRole("button", { name: /change\.patch/ }).click();
  await expect(page.locator('[data-code-diff="pierre"]')).toBeVisible();
  await page.getByRole("button", { name: /diagram\.svg/ }).click();
  const frame = page.locator('iframe[title="SVG preview: diagram.svg"]');
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(page.locator("body")).not.toHaveAttribute("data-svg-executed", "yes");
});

test("loads deck.pptx through the provisioned Qoder Canvas viewer", async ({ page }) => {
  test.skip(!pptxReady, PPTX_REQUIREMENT);
  const failures = watchFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArtifacts(page);
  await page.getByRole("button", { name: /deck\.pptx/ }).click();
  const iframe = page.locator('iframe[title="Artifact preview: deck.pptx"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const viewer = page.frameLocator('iframe[title="Artifact preview: deck.pptx"]');
  await page.waitForTimeout(2_000);
  expect(failures).toEqual([]);
  await expect(viewer.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
  await expect(viewer.locator("body")).not.toContainText(/No target|error diagnostic|could not/i);
});

test("keeps the artifact workbench usable at wide, compact, and narrow widths", async ({ page }) => {
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await openArtifacts(page);
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
    await page.getByRole("button", { name: /component\.tsx/ }).click();
    await expect(page.locator(".artifact-code-preview")).toBeVisible();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/artifacts-${layout.name}.png`, fullPage: true });
  }
});

test("gives artifact rows a visible keyboard focus ring", async ({ page }) => {
  await openArtifacts(page);
  const row = page.getByRole("button", { name: /component\.tsx/ });
  await row.focus();
  expect(Number.parseFloat(await row.evaluate((element) => getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
});

test("persists the explicit Studio theme and keeps core contrast accessible", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(studio.url);
  const contrast = async () => page.evaluate(() => {
    const parse = (value) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (value) => parse(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (foreground, background) => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + 0.05) / (dark + 0.05);
    };
    const body = getComputedStyle(document.body);
    const primary = getComputedStyle(document.querySelector("button.primary"));
    return {
      body: ratio(body.color, body.backgroundColor),
      primary: ratio(primary.color, primary.backgroundColor),
    };
  });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkContrast = await contrast();
  expect(darkContrast.body).toBeGreaterThanOrEqual(4.5);
  expect(darkContrast.primary).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: /Dark theme active/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightContrast = await contrast();
  expect(lightContrast.body).toBeGreaterThanOrEqual(4.5);
  expect(lightContrast.primary).toBeGreaterThanOrEqual(4.5);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /Light theme active/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});

test("opens a project workspace and compares Inspector-discovered Sessions", async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(emptyStudio.url);
  const gate = page.getByRole("dialog", { name: "Open a workspace to start" });
  await expect(gate).toBeVisible();
  await expect(page.locator(".studio-control-plane")).toHaveAttribute("inert", "");
  await expect(page.locator(".studio-control-plane")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Choose workspace" })).toBeVisible();

  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} workspace gate overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/session-workspace-gate-${layout.name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await expect(page.getByRole("button", { name: "Opening…" })).toBeDisabled();
  await expect(page.locator(".workspace-open-progress")).toContainText("Finding matching Sessions across local providers");
  await expect(page.locator(".workspace-open-progress > i")).toHaveCSS("animation-name", "workspace-progress-spin");
  await page.screenshot({ path: "test-results/session-workspace-loading-wide.png", fullPage: true });

  await expect(page.getByRole("button", { name: /Repair renderer/ })).toBeVisible();
  await expect(gate).toHaveCount(0);
  await expect(page.locator(".studio-control-plane")).not.toHaveAttribute("inert", "");
  await expect(page).toHaveURL(/#\/sessions$/);
  await expect(page.getByRole("heading", { name: "Repair renderer" })).toBeVisible();
  await expect(page.locator(".session-event-rows")).toContainText("Bash");
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} session browser overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/session-browser-${layout.name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const compareChecks = page.locator(".session-catalog-rows input[type=checkbox]");
  await compareChecks.nth(0).check();
  await compareChecks.nth(1).check();
  await page.getByRole("button", { name: "Compare 2/2" }).click();
  await expect(page.getByRole("heading", { name: "Compare Sessions" })).toBeVisible();
  await expect(page.locator(".session-compare-boundary")).toContainText("No winner inferred");
  await expect(page.locator(".session-compare-workspace")).toContainText("Repair parser");
  await expect(page.locator(".session-compare-workspace")).toContainText("Repair renderer");
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} session comparison overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/session-compare-${layout.name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("navigation", { name: "Harness control plane" }).getByRole("button", { name: /^Debugger/ }).click();
  await expect(page.getByText("Workspace default · Qoder", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New live run" }).click();
  await expect(page.getByRole("dialog", { name: "Start a live harness session" })).toContainText("selected workspace");
  await page.getByPlaceholder("Task prompt for the harness run…").fill("verify the default workspace harness");
  await page.getByRole("button", { name: "Run harness" }).click();
  await expect(page.locator(".session-notebook")).toContainText("default harness: verify the default workspace harness");
  await page.screenshot({ path: "test-results/default-workspace-debugger-wide.png", fullPage: true });

  const config = await page.evaluate(async () => await (await fetch("api/config")).json());
  expect(config).toMatchObject({ aguiEnabled: true, harnessMode: "workspace-default", workspaceConnected: true, sessionCount: 2 });
  const workspace = await page.evaluate(async () => await (await fetch("api/workspace")).json());
  expect(workspace).toMatchObject({ connected: true, label: "fixture-project", providers: [{ provider: "qoder", status: "ok" }] });
  expect(JSON.stringify(workspace)).not.toContain(selectedWorkspace);
  expect(failures).toEqual([]);
});
