import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
  createStudioDevReloadPlugin,
  injectStudioDevReload,
  packageRoot,
  reconcileStudioDevReloadRevision,
} from "../scripts/app-build.mjs";
import { studioServerArgv } from "../scripts/dev.mjs";

test("development HTML gets a reload client without changing the source HTML", () => {
  const source = "<!doctype html><html><body><main>Studio</main></body></html>\n";
  const rendered = injectStudioDevReload(source);

  assert.match(rendered, /__harnessStudioDevReload/u);
  assert.match(rendered, /studio-dev-reload\.txt/u);
  assert.match(rendered, /window\.location\.reload\(\)/u);
  assert.doesNotMatch(source, /__harnessStudioDevReload/u);
});

test("development reload state initializes, stays stable, and requests reload on change", () => {
  assert.deepEqual(reconcileStudioDevReloadRevision(null, "7"), { revision: "7", reload: false });
  assert.deepEqual(reconcileStudioDevReloadRevision("7", "7"), { revision: "7", reload: false });
  assert.deepEqual(reconcileStudioDevReloadRevision("7", "8"), { revision: "8", reload: true });
});

test("development reload revisions advance only after successful publication", async () => {
  const published = [];
  const observed = [];
  let onEnd;
  const plugin = createStudioDevReloadPlugin({
    async publishRevision(revision) {
      published.push(revision);
    },
    onPublished(revision) {
      observed.push(revision);
    },
  });
  plugin.setup({ onEnd(callback) { onEnd = callback; } });

  await onEnd({ errors: [{ text: "temporary failure" }] });
  await onEnd({ errors: [] });
  await onEnd({ errors: [] });

  assert.deepEqual(published, [1, 2]);
  assert.deepEqual(observed, [1, 2]);
});

test("development command forwards workspace launcher arguments as an argv array", () => {
  assert.deepEqual(studioServerArgv(["--port", "4311", "--intent-analysis"]), [
    join(packageRoot, "scripts", "start-inspector-workspace.mjs"),
    "--port",
    "4311",
    "--intent-analysis",
  ]);
});
