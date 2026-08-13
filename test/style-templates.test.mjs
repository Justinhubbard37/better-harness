import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const STYLE_FILES = [
  "analyst.md",
  "audit-scorecard.md",
  "consulting-deck.md",
  "editorial-insight.md",
  "engineering-diagnosis.md",
  "executive-dashboard.md",
  "transformation-playbook.md",
];

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function tableRows(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  return lines.slice(start + 1)
    .filter((line) => line.startsWith("| ") && !/^\|\s*-+/u.test(line))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

test("style files are a complete declarative set", () => {
  const styleFiles = readdirSync(path.join(ROOT, "templates/style"))
    .filter((file) => file.endsWith(".md") && file !== "routing.md")
    .sort();
  assert.deepEqual(styleFiles, STYLE_FILES);

  const forbiddenTerms = [
    "Qoder Canvas",
    "qoder/canvas",
    "canvas-sdk",
    "```tsx",
    "```jsx",
    "```html",
  ];
  for (const file of styleFiles) {
    const content = read(`templates/style/${file}`);
    assert.equal(content.split("\n").includes("## Visualization Style"), true, file);
    for (const term of forbiddenTerms) {
      assert.equal(content.includes(term), false, `${file} must not own ${term}`);
    }
  }
});

test("report routing has one structural row per output mode", () => {
  const routing = read("templates/reporting/routing.md");
  const rows = tableRows(routing, "## Output Route");
  assert.deepEqual(rows.map((row) => row[0]), [
    "Route",
    "Qoder Canvas report",
    "Cursor Canvas report",
    "Portable HTML report",
    "Markdown only",
    "Inline only",
  ]);
  assert.deepEqual(rows.slice(1).map((row) => row[3]), [
    "`qoder-canvas.md`",
    "`cursor-canvas.md`",
    "`html-visual.md`",
    "none",
    "none",
  ]);
  assert.equal(rows.find((row) => row[0] === "Inline only")[2], "none; inline analysis writes nothing");
});

test("report templates keep compact structure and runtime boundaries", () => {
  const reportStructure = read("templates/reporting/report-structure.md");
  const qoderCanvas = read("templates/reporting/qoder-canvas.md");
  const htmlVisual = read("templates/reporting/html-visual.md");

  assert.ok(reportStructure.split("\n").length <= 80);
  assert.deepEqual(
    reportStructure.split("\n").filter((line) => line.startsWith("#")),
    ["# Report Structure", "## Markdown Body Skeleton"],
  );
  assert.ok(qoderCanvas.split("\n").length <= 90);
  assert.ok(htmlVisual.split("\n").length <= 105);
  assert.doesNotMatch(qoderCanvas, /\p{Script=Han}/u);
  assert.doesNotMatch(htmlVisual, /\p{Script=Han}/u);
  for (const term of ["Qoder", "Canvas", "qoder/canvas", "report.canvas.tsx"]) {
    assert.equal(htmlVisual.includes(term), false, `portable HTML must not expose ${term}`);
  }
});

test("style routing indexes every declared style exactly once", () => {
  const rows = tableRows(read("templates/style/routing.md"), "## Internal Style Labels");
  assert.deepEqual(
    rows.slice(1).map((row) => row[0].replaceAll("`", "")).sort(),
    STYLE_FILES,
  );
});
