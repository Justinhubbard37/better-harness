import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { HarnessRunEmitter } from "@qoder-ai/harness/exec";
import { buildHarnessInspectorReport, emptyFeatureTree } from "../../../../scripts/harness-inspector/index.mjs";
import { startHarnessStudioServer } from "../../dist/server/server.js";
import { sessionFromRetainedRun } from "../../dist/app/session-debugger-model.js";
import { createPptxFixture } from "../pptx-fixture.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canvasSdkRoot = process.env.CANVAS_SDK_ROOT ?? resolve(packageRoot, "../../../canvas-sdk");
const canvasViewerRoot = join(homedir(), ".qoder", "canvas", "canvases");
let studio;
let emptyStudio;
let selectedWorkspace;
let artifactDirectory;

test.beforeAll(async () => {
  artifactDirectory = await mkdtemp(join(tmpdir(), "studio-artifact-browser-"));
  await writeFile(join(artifactDirectory, "deck.pptx"), createPptxFixture("01"));
  await writeFile(join(artifactDirectory, "component.tsx"), 'document.body.dataset.moduleEvaluated = "yes"; export default () => <p data-preview="current">first render</p>;\n', "utf8");
  await writeFile(join(artifactDirectory, "broken.tsx"), 'export default () => <main>broken;\n', "utf8");
  await writeFile(join(artifactDirectory, "change.patch"), [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
  ].join("\n"), "utf8");
  await writeFile(join(artifactDirectory, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><script>parent.document.body.dataset.svgExecuted="yes"</script><text x="12" y="44">Safe SVG artifact</text></svg>', "utf8");
  await writeFile(join(artifactDirectory, "notes.txt"), "followed the declared content reference\n", "utf8");
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
  const workspaceInspectorReport = buildHarnessInspectorReport({
    repoRoot: selectedWorkspace,
    featureTree: emptyFeatureTree(),
    sessions: workspaceRecords.map((record) => ({
      sessionId: record.id,
      platform: "qoder",
      firstSeen: record.savedAt,
      lastSeen: record.savedAt,
      prompts: [{ text: record.prompt, timestamp: record.savedAt }],
      promptCount: 1,
      assistantMessageCount: 1,
      toolCallCount: record.toolCallCount,
      toolActivity: {
        calls: record.timeline.filter((event) => event.kind === "tool-call").map((event, index) => ({
          id: event.id,
          family: event.name === "Edit" ? "change" : "inspect",
          actionLabel: `${event.name} workspace evidence`,
          toolName: event.name,
          status: "completed",
          startedAt: Date.parse(record.savedAt) + index,
        })),
      },
      dialogue: { turns: [{ prompt: record.prompt, response: `${record.prompt} complete` }] },
    })),
    correlation: { commits: [] },
    providers: [{ platform: "qoder", status: "ok", discovered: 2, included: 2 }],
    filters: { platform: "all", sessionLimit: 100 },
  });
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
          inspectorReport: workspaceInspectorReport,
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
  if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
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
  const explorerTab = page.getByRole("tab", { name: "Explorer" });
  if (await explorerTab.isVisible() && await explorerTab.getAttribute("aria-selected") !== "true") await explorerTab.click();
  // The first viewer discovery can be cold on machines with a provisioned
  // Canvas catalog, so wait for the catalog boundary instead of assuming a
  // five-second filesystem scan.
  await expect(page.getByRole("button", { name: /component\.tsx/ })).toBeVisible({ timeout: 15_000 });
}

test("renders generated TSX in the sandbox and keeps its source reachable", async ({ page }) => {
  const failures = watchFailures(page);
  await openArtifacts(page);
  await page.getByRole("button", { name: /component\.tsx/ }).click();
  const preview = page.frameLocator('iframe[title="Live artifact preview: component.tsx"]');
  await expect(preview.locator('[data-preview="current"]')).toHaveText("first render");
  await expect(preview.locator("body")).toHaveAttribute("data-module-evaluated", "yes");
  await expect(preview.locator("html")).toHaveAttribute("data-artifact-theme", "dark");
  const previewContrast = await preview.locator('[data-preview="current"]').evaluate((element) => {
    const channels = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = (value) => channels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(getComputedStyle(element).color);
    const background = luminance(getComputedStyle(document.body).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(previewContrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByText("Preview rendered from the current build.")).toBeVisible();
  await expect(page.locator('[data-preview="current"]')).toHaveCount(0);
  const frame = page.locator('iframe[title="Live artifact preview: component.tsx"]');
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const direct = await page.context().newPage();
  await direct.goto(`${studio.url}${await frame.getAttribute("src")}`);
  await expect(direct.locator('[data-preview="current"]')).toHaveCount(0);
  await expect(direct.locator("body")).not.toHaveAttribute("data-module-evaluated", "yes");
  await direct.close();
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await expect(page.locator(".artifact-code-preview")).toContainText("data-preview");
  expect(failures).toEqual([]);
});

test("reports code Artifact compile diagnostics without executing a partial build", async ({ page }) => {
  const failures = watchFailures(page);
  await openArtifacts(page);
  await page.getByRole("button", { name: /broken\.tsx/ }).click();
  await expect(page.locator(".artifact-build-diagnostics")).toContainText("Build failed");
  await expect(page.locator(".artifact-build-diagnostics")).toContainText("closing \"main\" tag");
  await expect(page.locator('iframe[title="Live artifact preview: broken.tsx"]')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("commits a changed TSX build without reloading Studio", async ({ page }) => {
  const failures = watchFailures(page);
  await openArtifacts(page);
  await page.getByRole("button", { name: /component\.tsx/ }).click();
  const frame = page.locator('iframe[title="Live artifact preview: component.tsx"]');
  const preview = page.frameLocator('iframe[title="Live artifact preview: component.tsx"]');
  await expect(preview.locator('[data-preview="current"]')).toHaveText("first render");
  const firstBuild = await frame.getAttribute("src");
  try {
    await writeFile(join(artifactDirectory, "component.tsx"), 'document.body.dataset.moduleEvaluated = "yes"; export default () => <p data-preview="current">second render</p>;\n', "utf8");
    await expect(preview.locator('[data-preview="current"]')).toHaveText("second render", { timeout: 10_000 });
    await expect(frame).not.toHaveAttribute("src", firstBuild);
  } finally {
    await writeFile(join(artifactDirectory, "component.tsx"), 'document.body.dataset.moduleEvaluated = "yes"; export default () => <p data-preview="current">first render</p>;\n', "utf8");
  }
  expect(failures).toEqual([]);
});

test("loads artifact bytes from the catalog content reference", async ({ page }) => {
  // Point one descriptor at a different artifact's revision-scoped URL. The
  // client must fetch what the catalog declared rather than rebuilding an
  // address from the id it happens to hold.
  await page.route("**/api/artifacts", async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    const component = catalog.artifacts.find((entry) => entry.label === "component.tsx");
    const other = catalog.artifacts.find((entry) => entry.label === "notes.txt");
    component.revision.content.uri = other.revision.content.uri;
    await route.fulfill({ response, json: catalog });
  });
  await openArtifacts(page);
  await page.getByRole("button", { name: /component\.tsx/ }).click();
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await expect(page.locator(".artifact-code-preview")).toContainText("followed the declared content reference");
  await expect(page.locator(".artifact-code-preview")).not.toContainText("data-preview");
});

test("renders code diff and sandboxes SVG without script capability", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArtifacts(page);
  await page.getByRole("button", { name: /change\.patch/ }).click();
  await expect(page.locator('[data-code-diff="pierre"]')).toBeVisible();
  await page.getByRole("button", { name: /diagram\.svg/ }).click();
  const frame = page.locator('iframe[title="SVG preview: diagram.svg"]');
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("srcdoc", /Content-Security-Policy/u);
  await expect(frame).not.toHaveAttribute("src", /api\/artifacts/u);
  const catalog = await (await page.request.get(`${studio.url}/api/artifacts`)).json();
  const svg = catalog.artifacts.find((entry) => entry.label === "diagram.svg");
  const raw = await page.request.get(`${studio.url}${svg.revision.content.uri}`);
  expect(raw.headers()["content-type"]).toBe("image/svg+xml");
  expect(raw.headers()["content-disposition"]).toMatch(/^attachment;/u);
  expect(raw.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
  await expect(page.locator("body")).not.toHaveAttribute("data-svg-executed", "yes");
});

test("renders a PPTX snapshot through Studio without a provisioned Qoder Canvas runtime", async ({ page }) => {
  const failures = watchFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArtifacts(page);
  await page.getByRole("button", { name: /deck\.pptx/ }).click();
  await expect(page.locator(".pptx-artifact-viewer")).toBeVisible();
  await expect(page.locator(".pptx-slide-shape")).toContainText("01");
  await expect(page.locator(".pptx-slide-image")).toHaveCount(1);
  await expect(page.locator(".pptx-slide-image")).toHaveJSProperty("complete", true);
  await expect(page.locator(".artifact-editor-header")).toContainText("studio.pptx-ooxml");
  await expect(page.locator(".artifact-preview-pane iframe")).toHaveCount(0);

  // The adapter's addressed outline and its diagnostics are both reachable, so
  // neither ships as payload that nothing reads.
  const outlineEntry = page.locator(".pptx-outline-pane button").first();
  await expect(outlineEntry).toBeVisible();
  await outlineEntry.click();
  await expect(page.locator(".pptx-slide-element.selected")).toHaveCount(1);
  await page.locator(".artifact-diagnostics > summary").click();
  await expect(page.locator(".artifact-diagnostics > ul")).toContainText("PPTX_BASELINE_RENDERER");
  expect(failures).toEqual([]);
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
    await page.getByRole("button", { name: /deck\.pptx/ }).click();
    if (layout.width <= 640) await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".pptx-artifact-viewer")).toBeVisible();
    await expect(page.locator(".pptx-slide-shape")).toContainText("01");
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/artifacts-${layout.name}.png`, fullPage: true });
  }
});

test("keeps live Artifact Preview primary at wide, compact, and narrow widths", async ({ page }) => {
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await openArtifacts(page);
    await page.getByRole("button", { name: /component\.tsx/ }).click();
    await expect(page.frameLocator('iframe[title="Live artifact preview: component.tsx"]').locator('[data-preview="current"]')).toHaveText("first render");
    await expect(page.getByText("Preview rendered from the current build.")).toBeVisible();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} live preview overflows horizontally`).toBe(false);
    await page.locator(".artifact-runtime-tabs").getByRole("tab", { name: "Source" }).focus();
    expect(Number.parseFloat(await page.locator(".artifact-runtime-tabs").getByRole("tab", { name: "Source" }).evaluate((element) => getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
    await page.screenshot({ path: `test-results/artifacts-live-${layout.name}.png`, fullPage: true });
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
  const requestedUrls = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
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
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
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

  await expect(gate).toHaveCount(0);
  await expect(page.locator(".studio-control-plane")).not.toHaveAttribute("inert", "");
  await expect(page).toHaveURL(/#\/sessions$/);
  const inspector = page.locator("[data-studio-native-inspector]");
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-react-inspector-workbench", "true");
  await expect(inspector.getByRole("tab", { name: "Date" })).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("button", { name: "Open session" }).first()).toBeVisible();
  expect(requestedUrls.some((url) => url.endsWith("/assets/inspector-workbench.js"))).toBe(false);
  await inspector.getByRole("button", { name: "Open session" }).first().click();
  await expect(inspector.locator(".session-view")).toBeVisible();
  await expect(inspector.getByRole("dialog")).toContainText(/Repair (parser|renderer)/);
  await expect(inspector.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(inspector.locator(".session-view")).toHaveCount(0);
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} Inspector workbench overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/session-inspector-${layout.name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Catalog & Compare" }).click();
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
  expect(config).toMatchObject({ aguiEnabled: true, harnessMode: "workspace-default", workspaceConnected: true, workspaceWorkbenchEnabled: true, sessionCount: 2 });
  const workspace = await page.evaluate(async () => await (await fetch("api/workspace")).json());
  expect(workspace).toMatchObject({ connected: true, label: "fixture-project", providers: [{ provider: "qoder", status: "ok" }] });
  expect(JSON.stringify(workspace)).not.toContain(selectedWorkspace);
  expect(failures).toEqual([]);
});
