import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startHarnessStudioServer } from "../../dist/server/server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDirectory = join(packageRoot, "test", "fixtures", "artifacts");

let studio;

test.beforeAll(async () => {
  studio = await startHarnessStudioServer({
    appDir: join(packageRoot, "dist", "app"),
    artifactDirectory,
    port: 0,
  });
});

test.afterAll(async () => {
  await studio?.close();
});

function hostUrl(id) {
  return `${studio.url}/artifact-host.html?module=api/artifacts/${id}/module.js`;
}

/** Collect console errors and page errors for the assertions below. */
function watchFailures(page) {
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("pageerror", (error) => failures.push(error.message));
  return failures;
}

test("compiles and renders a TSX artifact inside the sandboxed host", async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(hostUrl("tool-mix"));

  await expect(page.getByTestId("artifact-tool-mix")).toBeVisible();
  // Proves the module executed rather than merely loading: 12 + 5 + 3 is
  // computed at runtime, not present in the source text.
  await expect(page.getByTestId("artifact-total")).toHaveText("20");
  await expect(page.getByRole("heading", { name: "Tool mix" })).toBeVisible();

  expect(failures).toEqual([]);
});

test("serves the artifact module with the CORS header an opaque origin needs", async ({ request }) => {
  const response = await request.get(`${studio.url}/api/artifacts/tool-mix/module.js`);
  expect(response.status()).toBe(200);
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await response.text()).toContain("React.createElement");
});

test("carries CORS on the compile-failure response so the diagnostic is readable", async ({ request }) => {
  const response = await request.get(`${studio.url}/api/artifacts/broken/module.js`);
  expect(response.status()).toBe(422);
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect((await response.json()).error).toMatch(/\(\d+:\d+\)/);
});

test("renders inside a sandboxed iframe that cannot reach the embedding page", async ({ page }) => {
  await page.setContent(
    `<main><iframe id="frame" title="Artifact" sandbox="allow-scripts"
       style="width:100%;height:400px;border:0"
       src="${hostUrl("tool-mix")}"></iframe></main>`,
  );

  const frame = page.frameLocator("#frame");
  await expect(frame.getByTestId("artifact-total")).toHaveText("20");

  // The sandbox withholds allow-same-origin, so the frame has an opaque origin
  // and the embedder cannot script into it.
  const reachable = await page.evaluate(() => {
    const frame = document.getElementById("frame");
    try {
      return frame.contentDocument !== null;
    } catch {
      return false;
    }
  });
  expect(reachable).toBe(false);
});

test("surfaces a compile failure as a readable host error", async ({ page }) => {
  await page.goto(hostUrl("broken"));

  const failure = page.locator(".artifact-failure");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("could not be compiled or loaded");
  // The reader must get the compiler's own diagnostic, not the browser's generic
  // "failed to fetch dynamically imported module".
  await expect(failure).toContainText("JSX");
  await expect(failure).toContainText(/\(\d+:\d+\)/);
  await expect(failure).not.toContainText("dynamically imported module");
});

test("keeps the compile diagnostic readable from inside a sandboxed frame", async ({ page }) => {
  await page.setContent(
    `<main><iframe id="frame" title="Artifact" sandbox="allow-scripts"
       style="width:100%;height:400px;border:0"
       src="${hostUrl("broken")}"></iframe></main>`,
  );

  // Exercises the opaque-origin path: recovering the diagnostic needs CORS on
  // the failure response, not just on the success response.
  const failure = page.frameLocator("#frame").locator(".artifact-failure");
  await expect(failure).toContainText("JSX");
});

test("refuses a module path outside the artifact route", async ({ page }) => {
  await page.goto(`${studio.url}/artifact-host.html?module=https://example.com/evil.js`);

  const failure = page.locator(".artifact-failure");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Refusing to load an artifact module");
});

test("rejects a traversal id without reaching the filesystem", async ({ request }) => {
  const response = await request.get(`${studio.url}/api/artifacts/..%2F..%2Fpackage.json/module.js`);
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toMatch(/Artifact id must match/);
});

test("lists artifacts without exposing filesystem paths", async ({ request }) => {
  const response = await request.get(`${studio.url}/api/artifacts`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  const toolMix = body.artifacts.find((entry) => entry.id === "tool-mix");
  expect(toolMix).toMatchObject({ id: "tool-mix", kind: "module", label: "tool-mix.tsx" });
  expect(JSON.stringify(body)).not.toContain(artifactDirectory);
});

test("reaches artifacts from the Studio shell navigation and previews a selection", async ({ page }) => {
  const failures = watchFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${studio.url}/`);

  const artifactsNav = page.getByRole("button", { name: /Artifacts/ });
  await expect(artifactsNav).toBeVisible();
  await artifactsNav.click();

  await expect(page.getByRole("button", { name: /tool-mix\.tsx/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /broken\.tsx/ })).toBeVisible();
  // Nothing is previewed until the reader chooses, so opening the pane compiles
  // no artifact.
  await expect(page.locator(".artifact-preview-pane")).toContainText("Select an artifact");
  await expect(page.locator("iframe")).toHaveCount(0);

  await page.getByRole("button", { name: /tool-mix\.tsx/ }).click();
  const preview = page.frameLocator('iframe[title="Artifact preview: tool-mix.tsx"]');
  await expect(preview.getByTestId("artifact-total")).toHaveText("20");

  // The healthy path must be completely quiet. Asserted before the deliberate
  // failure below, which legitimately logs a 422 resource load.
  expect(failures).toEqual([]);

  await page.getByRole("button", { name: /broken\.tsx/ }).click();
  await expect(
    page.frameLocator('iframe[title="Artifact preview: broken.tsx"]').locator(".artifact-failure"),
  ).toContainText("JSX");
});

test("keeps the artifacts shell usable at wide, compact, and narrow widths", async ({ page }) => {
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.goto(`${studio.url}/#/artifacts`);
    await expect(page.getByRole("button", { name: /tool-mix\.tsx/ })).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, `${layout.name} overflows horizontally`).toBe(false);

    await page.screenshot({ path: `test-results/artifacts-shell-${layout.name}.png`, fullPage: true });
  }
});

test("gives the artifact rows a visible keyboard focus ring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${studio.url}/#/artifacts`);

  const row = page.getByRole("button", { name: /tool-mix\.tsx/ });
  await row.focus();
  const outlineWidth = await row.evaluate((element) => getComputedStyle(element).outlineWidth);
  expect(Number.parseFloat(outlineWidth)).toBeGreaterThan(0);
});

test("keeps the artifact readable at wide, compact, and narrow widths", async ({ page }) => {
  const failures = watchFailures(page);
  for (const layout of [
    { name: "wide", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
    { name: "narrow", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.goto(hostUrl("tool-mix"));
    await expect(page.getByTestId("artifact-total")).toHaveText("20");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, `${layout.name} overflows horizontally`).toBe(false);

    await page.screenshot({ path: `test-results/artifact-host-${layout.name}.png`, fullPage: true });
  }
  expect(failures).toEqual([]);
});
