import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function readUtf8(...segments) {
  return readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

function tabValues(mdx) {
  return [...mdx.matchAll(/<TabItem\s+value="([^"]+)"/gu)].map((match) => match[1]);
}

function formIds(yaml) {
  return yaml.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("id: "))
    .map((line) => line.slice("id: ".length));
}

function loadDocsRuntime() {
  const configUrl = pathToFileURL(path.join(process.cwd(), "docs", "docusaurus.config.js")).href;
  const sidebarsUrl = pathToFileURL(path.join(process.cwd(), "docs", "sidebars.js")).href;
  const program = [
    `import config from ${JSON.stringify(configUrl)};`,
    `import sidebars from ${JSON.stringify(sidebarsUrl)};`,
    "process.stdout.write(JSON.stringify({ config, sidebars }));",
  ].join("\n");
  const result = spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--input-type=module",
    "--eval",
    program,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const { config, sidebars } = loadDocsRuntime();

test("Docusaurus configuration executes to the supported search and locale contract", () => {
  assert.deepEqual(config.i18n.locales, ["en", "zh-Hans"]);
  const [searchTheme, searchOptions] = config.themes[0];
  assert.equal(searchTheme, "@easyops-cn/docusaurus-search-local");
  assert.deepEqual(searchOptions, {
    indexDocs: true,
    indexBlog: true,
    indexPages: false,
    language: ["en", "zh"],
    hashed: "filename",
    docsDir: ["docs", "i18n/zh-Hans/docusaurus-plugin-content-docs/current"],
    searchBarPosition: "right",
    searchBarShortcutKeymap: "mod+k",
  });
  assert.equal(
    config.themeConfig.navbar.items.some((item) => item.href?.endsWith("/issues/new/choose")),
    true,
  );
});

test("installation pages expose the same host tabs and runtime prerequisites", () => {
  const installation = readUtf8("docs", "docs", "installation.mdx");
  const installationZh = readUtf8(
    "docs",
    "i18n",
    "zh-Hans",
    "docusaurus-plugin-content-docs",
    "current",
    "installation.mdx",
  );
  const expectedHosts = ["claude-code", "codex", "qoder", "cursor", "qwen-code", "github-copilot"];
  assert.deepEqual(tabValues(installation), expectedHosts);
  assert.deepEqual(tabValues(installationZh), expectedHosts);

  const packageJson = JSON.parse(readUtf8("package.json"));
  for (const content of [installation, installationZh]) {
    assert.equal(content.includes(`Node.js \`${packageJson.engines.node}\``), true);
    assert.equal(content.includes(`npm \`${packageJson.engines.npm}\``), true);
  }
  assert.equal(installation.split("\n").filter((line) => line === "### Verify installation").length, 6);
  assert.equal(installationZh.split("\n").filter((line) => line === "### 验证安装").length, 6);
});

test("Getting Started routes to troubleshooting without destructive recovery commands", () => {
  const gettingStarted = sidebars.docs.find((entry) => entry.label === "Getting Started");
  assert.deepEqual(gettingStarted.items, [
    "introduction",
    "installation",
    "your-first-report",
    "troubleshooting",
  ]);
  for (const content of [
    readUtf8("docs", "docs", "troubleshooting.md"),
    readUtf8("docs", "i18n", "zh-Hans", "docusaurus-plugin-content-docs", "current", "troubleshooting.md"),
  ]) assert.doesNotMatch(content, /rm\s+-rf|Remove-Item|del\s+\/s/iu);
});

test("GitHub issue forms retain a small structured intake", () => {
  const bug = readUtf8(".github", "ISSUE_TEMPLATE", "bug_report.yml");
  const feature = readUtf8(".github", "ISSUE_TEMPLATE", "feature_request.yml");
  assert.deepEqual(formIds(bug), [
    "preflight",
    "summary",
    "host",
    "environment",
    "reproduction",
    "result",
    "logs",
    "additional-context",
  ]);
  assert.deepEqual(formIds(feature), ["preflight", "problem", "outcome", "scope", "examples", "notes"]);
  assert.equal(bug.split("\n").filter((line) => line.trim() === "required: true").length, 6);
  assert.equal(feature.split("\n").filter((line) => line.trim() === "required: true").length, 4);
});
