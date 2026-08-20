import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startHarnessStudioServer } from "../../dist/server/server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canvasSdkRoot = resolve(packageRoot, "../../../canvas-sdk");
const canvasViewerRoot = join(homedir(), ".qoder", "canvas", "canvases");
const pptxFixture = join(canvasSdkRoot, "packages/viewer-pptx/test/fixtures/officecli-parity/pptx-parity.pptx");

let studio;
let emptyStudio;

test.beforeAll(async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "studio-artifact-browser-"));
  await copyFile(pptxFixture, join(artifactDirectory, "deck.pptx"));
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
  await expect(page.getByRole("button", { name: /deck\.pptx/ })).toBeVisible();
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
  const row = page.getByRole("button", { name: /deck\.pptx/ });
  await row.focus();
  expect(Number.parseFloat(await row.evaluate((element) => getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
});

test("closes the empty-start flow in Studio by analyzing selected files", async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(emptyStudio.url);
  const analyze = page.getByRole("button", { name: "Analyze artifacts" });
  await expect(analyze).toBeEnabled();
  await analyze.click();
  await expect(page.getByRole("heading", { name: "Analyze generated artifacts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose folder" })).toBeVisible();
  expect(await page.getByTestId("artifact-folder-input").evaluate((input) => input.hasAttribute("webkitdirectory"))).toBe(true);

  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    if (layout.width <= 1080) await expect(page.locator(".studio-primary-nav")).not.toBeInViewport();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, `${layout.name} empty intake overflows horizontally`).toBe(false);
    await page.screenshot({ path: `test-results/artifact-intake-${layout.name}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("artifact-files-input").setInputFiles([
    {
      name: "component.tsx",
      mimeType: "text/plain",
      buffer: Buffer.from('export default () => <p data-imported="yes">imported source</p>;\n'),
    },
    {
      name: "change.diff",
      mimeType: "text/plain",
      buffer: Buffer.from("--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    },
    {
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><text x="8" y="40">Imported SVG</text></svg>'),
    },
    {
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: await readFile(pptxFixture),
    },
  ]);

  await expect(page.getByRole("button", { name: /component\.tsx/ })).toBeVisible();
  await expect(page.locator('[data-code-diff="pierre"]')).toBeVisible();
  await page.getByRole("button", { name: /component\.tsx/ }).click();
  await expect(page.locator(".artifact-code-preview")).toContainText("data-imported");
  await page.getByRole("button", { name: /deck\.pptx/ }).click();
  const importedDeck = page.frameLocator('iframe[title="Artifact preview: deck.pptx"]');
  await expect(importedDeck.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
  await expect(page.locator(".studio-nav-group button", { hasText: "Artifacts" })).toContainText("Run outputs");
  const config = await page.evaluate(async () => await (await fetch("api/config")).json());
  expect(config.artifactsEnabled).toBe(true);
  expect(failures).toEqual([]);
});
