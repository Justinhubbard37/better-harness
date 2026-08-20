import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveCanvasRuntime } from "../../dist/server/artifact-viewer-runtime.js";
import { discoverCanvasViewers, matchCanvasViewer } from "../../dist/server/artifact-viewers.js";
import { startHarnessStudioServer } from "../../dist/server/server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canvasSdkRoot = process.env.CANVAS_SDK_ROOT ?? resolve(packageRoot, "../../../canvas-sdk");
const canvasViewerRoot = join(homedir(), ".qoder", "canvas", "canvases");
const pptxFixture = join(canvasSdkRoot, "packages/viewer-pptx/test/fixtures/officecli-parity/pptx-parity.pptx");
const PPTX_REQUIREMENT = "needs a provisioned Qoder Canvas pptx viewer, the canvas-sdk runtime, and a real deck fixture";

let studio;
let emptyStudio;
let pptxReady = false;

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
  emptyStudio = await startHarnessStudioServer({
    appDir: join(packageRoot, "dist", "app"),
    canvasSdkRoot,
    canvasViewerRoot,
    port: 0,
  });
});

test.afterAll(async () => {
  await studio?.close();
  await emptyStudio?.close();
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

test("opens a session folder in Studio and compares two retained Sessions", async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(emptyStudio.url);
  const openFolder = page.getByRole("button", { name: "Open session folder" }).first();
  await expect(openFolder).toBeEnabled();
  await openFolder.click();
  await expect(page.getByRole("heading", { name: "Open a session folder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose session folder" })).toBeVisible();
  expect(await page.getByTestId("workspace-folder-input").evaluate((input) => input.hasAttribute("webkitdirectory"))).toBe(true);

  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} workspace intake overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/session-workspace-intake-${layout.name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
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
  const sessionDirectory = await mkdtemp(join(tmpdir(), "studio-session-workspace-"));
  await writeFile(join(sessionDirectory, "run_left.json"), JSON.stringify(retainedRun("run_left", "2026-08-20T10:00:00.000Z", "Repair parser", ["Read", "Edit", "Bash"])), "utf8");
  await writeFile(join(sessionDirectory, "run_right.json"), JSON.stringify(retainedRun("run_right", "2026-08-20T11:00:00.000Z", "Repair renderer", ["Read", "Bash"])), "utf8");
  await page.getByTestId("workspace-folder-input").setInputFiles(sessionDirectory);

  await expect(page.getByRole("button", { name: /Repair renderer/ })).toBeVisible();
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
  const config = await page.evaluate(async () => await (await fetch("api/config")).json());
  expect(config).toMatchObject({ workspaceConnected: true, sessionCount: 2 });
  expect(failures).toEqual([]);
  await rm(sessionDirectory, { recursive: true, force: true });
});
