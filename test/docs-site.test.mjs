import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncAssets } from "../docs/scripts/sync-assets.mjs";

function relativeLuminance(hex) {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/gu)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function writeFixture(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

test("docs asset sync publishes the report as a clean directory route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-docs-site-"));
  const repoRoot = path.join(root, "repo");
  const siteRoot = path.join(repoRoot, "docs");

  try {
    for (const [relativePath, content] of [
      ["assets/demo/better-harness-report.html", "report"],
      ["assets/demo/better-harness-findings-report.png", "image"],
      ["assets/demo/twenty-history.png", "history"],
      ["assets/agent-work-loop-en.svg", "loop"],
      ["assets/better-harness-architecture-en.svg", "architecture"],
      ["assets/install/codex-add-marketplace.jpg", "install"],
    ]) {
      await writeFixture(repoRoot, relativePath, content);
    }
    await writeFixture(siteRoot, "static/demo/better-harness-report.html", "stale");
    await writeFixture(siteRoot, "static/demo/twenty-history.gif", "stale animation");

    assert.equal(syncAssets({ repoRoot, siteRoot }), 6);
    assert.equal(
      await readFile(
        path.join(siteRoot, "static/demo/better-harness-report/index.html"),
        "utf8",
      ),
      "report",
    );
    await assert.rejects(
      access(path.join(siteRoot, "static/demo/better-harness-report.html")),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(path.join(siteRoot, "static/demo/twenty-history.png"), "utf8"),
      "history",
    );
    await assert.rejects(
      access(path.join(siteRoot, "static/demo/twenty-history.gif")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checked-in demo report identifies the sample and provides site exits", async () => {
  const html = await readFile(
    path.join(process.cwd(), "assets", "demo", "better-harness-report.html"),
    "utf8",
  );

  assert.match(html, /data-demo-context="sample"/u);
  assert.match(html, /checked-in, evidence-bounded sample/u);
  assert.match(
    html,
    /href="https:\/\/qoderai\.github\.io\/better-harness\/" data-demo-target=""[^>]*>Back to Better Harness</u,
  );
  assert.match(
    html,
    /data-demo-target="docs\/installation"[^>]*>Install and run your report</u,
  );
  assert.match(html, /routeMarker = "\/demo\/better-harness-report"/u);
  assert.match(html, /window\.location\.pathname\.slice\(0, markerIndex\)/u);
});

test("homepage uses accurate host copy, static media, and AA hero colors", async () => {
  const [source, styles, theme, translations] = await Promise.all([
    readFile(path.join(process.cwd(), "docs", "src", "pages", "index.js"), "utf8"),
    readFile(path.join(process.cwd(), "docs", "src", "pages", "index.module.css"), "utf8"),
    readFile(path.join(process.cwd(), "docs", "src", "css", "custom.css"), "utf8"),
    readFile(path.join(process.cwd(), "docs", "i18n", "zh-Hans", "code.json"), "utf8"),
  ]);

  assert.match(
    source,
    /Built into Qoder Desktop; Qoder CLI can reuse it or install separately\./u,
  );
  assert.match(source, /View sample report/u);
  assert.match(source, /to="\/docs\/installation"/u);
  assert.doesNotMatch(
    source,
    /View live demo report|REPORT_PROMPT|CodeBlock|<code>\/better-harness<\/code>/u,
  );
  assert.match(source, /entrypoint documented for your host/u);
  assert.match(source, /\/demo\/twenty-history\.png/u);
  assert.doesNotMatch(source, /\/demo\/twenty-history\.gif/u);

  const imageTags = [...source.matchAll(/<img\b[\s\S]*?\/>/gu)].map(
    (match) => match[0],
  );
  assert.equal(imageTags.length, 3);
  for (const image of imageTags) {
    assert.match(image, /width="\d+"/u);
    assert.match(image, /height="\d+"/u);
    assert.match(image, /loading="lazy"/u);
    assert.match(image, /decoding="async"/u);
    assert.match(image, /alt=\{translate\(/u);
  }

  assert.match(
    styles,
    /--ifm-hero-background-color:\s*var\(--ifm-color-primary-darkest\)/u,
  );
  assert.match(styles, /--ifm-hero-text-color:\s*#ffffff/u);
  assert.doesNotMatch(styles.match(/\.heroLead\s*\{[^}]*\}/u)?.[0] ?? "", /opacity/u);

  const heroBackgrounds = [
    ...theme.matchAll(/--ifm-color-primary-darkest:\s*(#[0-9a-f]{6})/giu),
  ].map((match) => match[1]);
  assert.equal(heroBackgrounds.length, 2);
  for (const background of heroBackgrounds) {
    assert.ok(
      contrastRatio(background, "#ffffff") >= 4.5,
      `${background} does not meet WCAG AA against white`,
    );
  }

  const zh = JSON.parse(translations);
  assert.match(zh["homepage.hosts.qoder.setup"].message, /Qoder CLI.*单独安装/u);
  assert.equal(zh["homepage.hero.viewDemo"].message, "查看示例报告");
  assert.match(zh["homepage.demo.historyCaption"].message, /静态最终帧/u);
});

test("architecture and public matrices explain the seven/six support boundary", async () => {
  const [architecture, matrix, matrixZh] = await Promise.all([
    readFile(
      path.join(process.cwd(), "assets", "better-harness-architecture-en.svg"),
      "utf8",
    ),
    readFile(
      path.join(process.cwd(), "docs", "docs", "hosts", "adapter-matrix.md"),
      "utf8",
    ),
    readFile(
      path.join(
        process.cwd(),
        "docs",
        "i18n",
        "zh-Hans",
        "docusaurus-plugin-content-docs",
        "current",
        "hosts",
        "adapter-matrix.md",
      ),
      "utf8",
    ),
  ]);

  assert.match(architecture, /7 CAPABILITY ADAPTERS/u);
  assert.match(architecture, /6 public Quickstart hosts/u);
  assert.match(architecture, /Pi capability adapter/u);
  assert.match(architecture, /Qoder Canvas · portable HTML/u);
  assert.match(architecture, /Better Harness Skill Workflow/u);
  assert.doesNotMatch(architecture, />\/better-harness<\/text>/u);
  assert.doesNotMatch(architecture, /Claude · Codex · Qoder · Cursor<\/text>/u);

  assert.match(matrix, /seven capability-level host adapters/u);
  assert.match(matrix, /six hosts with public Quickstart paths/u);
  assert.match(matrix, /Pi[\s\S]*remains outside the\npublic Quickstart/u);
  assert.match(matrixZh, /七个能力层宿主适配器/u);
  assert.match(matrixZh, /公开快速开始路径的六个宿主/u);
  assert.match(matrixZh, /Pi[\s\S]*仍不进入公开快速开始/u);
});
