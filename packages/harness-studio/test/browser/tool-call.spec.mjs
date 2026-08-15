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
});

test.afterAll(async () => {
  await studio?.close();
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
