import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHarnessInspectorReport,
  featureTreeDescendantIds,
  FeatureTreeParseError,
  parseFeatureTreeMarkdown,
  renderHarnessInspectorHtml,
} from "../scripts/harness-inspector/index.mjs";
import { summarizeSessionEvents } from "../scripts/commit-session-link/index.mjs";

const CLI_PATH = fileURLToPath(new URL("../scripts/harness-inspector/cli.mjs", import.meta.url));
const INSPECTOR_UI_ROOT = new URL("../scripts/harness-inspector/ui/", import.meta.url);
const FEATURE_TREE = `# Feature: Harness Inspector {#harness-inspector}
- status: active
- evidence: candidate

## Story: Inspect by feature {#inspect-by-feature}
- stage: implementation
- spec: docs/specs/2026-08-12-harness-inspector.md
- issue: QoderAI/better-harness#77
- prompt: Trace one declared delivery story.
- session: codex/session-a

## Story: Inspect by date {#inspect-by-date}
- stage: validation
- date: 2026-08-12
- commit: bbbbbbb
`;

const CHECKLIST_TREE = `- [ ] Better Harness
  - [x] Analyze and Improve
    - [x] Generate a readiness report
  - [ ] Inspector {#inspector}
    - [ ] Browse feature delivery
    - [ ] Correlate sessions and commits
`;

function fixtureSession(overrides = {}) {
  return {
    sessionId: "session-a",
    platform: "codex",
    firstSeen: "2026-08-12T08:00:00.000Z",
    lastSeen: "2026-08-12T09:30:00.000Z",
    durationMs: 90 * 60_000,
    files: ["scripts/harness-inspector/render-html.mjs"],
    prompts: [{ text: "Build the Harness Inspector date picker", timestamp: "2026-08-12T08:00:00.000Z" }],
    promptCount: 1,
    toolCallCount: 2,
    fileEditCount: 1,
    promptObservationCount: 2,
    userTurnCount: 1,
    retainedUserTurnCount: 1,
    assistantMessageCount: 2,
    models: ["gpt-5.6"],
    dialogue: {
      truncated: false,
      turns: [{
        index: 1,
        anchorId: "turn-1",
        prompt: { text: "Build the Harness Inspector date picker", timestamp: "2026-08-12T08:00:00.000Z" },
        steps: [
          { kind: "tool", callStep: 1, toolName: "Read" },
          { kind: "note", text: "I found the existing renderer boundary." },
          { kind: "tool", callStep: 2, toolName: "Bash" },
        ],
        toolCallCount: 2,
        messageCount: 4,
        response: "Implemented the date picker and verified the focused tests.",
        durationMs: 90 * 60_000,
        startMs: Date.parse("2026-08-12T08:00:00.000Z"),
        endMs: Date.parse("2026-08-12T09:30:00.000Z"),
      }],
    },
    toolTrace: {
      schemaVersion: 2,
      totalCalls: 2,
      shownCalls: 2,
      truncated: false,
      calls: [
        { id: "T1", step: 1, toolName: "Read", status: "observed", durationStatus: "observed", durationMs: 120, timingSource: "transcript-pair" },
        { id: "T2", step: 2, toolName: "Bash", status: "failed", durationStatus: "unobserved" },
      ],
    },
    toolActivity: {
      kind: "NormalizedToolActivityV1",
      schemaVersion: 1,
      totalCalls: 2,
      failedCalls: 1,
      familyCounts: { inspect: 1, change: 0, execute: 0, verify: 1, coordinate: 0, deliver: 0, other: 0 },
      segments: [],
      files: [{ path: "scripts/harness-inspector/render-html.mjs", callCount: 1, callIds: ["A1"], families: ["inspect"] }],
      calls: [
        { id: "A1", step: 1, toolName: "Read", operation: "read-files", actionLabel: "Read files", family: "inspect", status: "observed", durationStatus: "observed", durationMs: 120, filePath: "scripts/harness-inspector/render-html.mjs", detail: "scripts/harness-inspector/render-html.mjs", detailKind: "redacted-input-summary" },
        { id: "A2", step: 2, toolName: "Bash", operation: "run-tests", actionLabel: "Run tests", family: "verify", status: "failed", durationStatus: "unobserved", detail: "node --test test/harness-inspector.test.mjs", detailKind: "redacted-input-summary" },
      ],
    },
    ...overrides,
  };
}

function fixtureCorrelation() {
  return {
    schemaVersion: 1,
    commits: [
      {
        hash: "a".repeat(40),
        shortHash: "aaaaaaa",
        subject: "feat(inspector): add feature picker",
        authorName: "Fixture Author",
        authoredAt: "2026-08-12T08:45:00.000Z",
        committedAt: "2026-08-12T08:45:00.000Z",
        fileCount: 2,
        files: [
          { path: "scripts/harness-inspector/render-html.mjs", added: 75, removed: 4 },
          { path: "test/harness-inspector.test.mjs", added: 5, removed: 0 },
        ],
        linesAdded: 80,
        linesRemoved: 4,
        matches: [{
          sessionId: "session-a",
          platform: "codex",
          confidence: "explicit",
          evidence: { linkType: "harness-session", timeOverlap: true, overlappingFileCount: 1, cwdWithinRepo: true },
        }],
      },
      {
        hash: "b".repeat(40),
        shortHash: "bbbbbbb",
        subject: "test(inspector): validate date scope",
        authorName: "Fixture Author",
        authoredAt: "2026-08-12T09:20:00.000Z",
        committedAt: "2026-08-12T09:20:00.000Z",
        fileCount: 1,
        files: [{ path: "test/harness-inspector.test.mjs", added: 24, removed: 0 }],
        linesAdded: 24,
        linesRemoved: 0,
        matches: [{
          sessionId: "session-a",
          platform: "codex",
          confidence: "high",
          evidence: { linkType: null, timeOverlap: true, overlappingFileCount: 1, cwdWithinRepo: true },
        }],
      },
      {
        hash: "c".repeat(40),
        shortHash: "ccccccc",
        subject: "docs(inspector): describe renderer evidence",
        authorName: "Fixture Author",
        authoredAt: "2026-08-11T08:00:00.000Z",
        committedAt: "2026-08-11T08:00:00.000Z",
        fileCount: 1,
        files: [{ path: "scripts/harness-inspector/render-html.mjs", added: 8, removed: 1 }],
        linesAdded: 8,
        linesRemoved: 1,
        matches: [],
      },
    ],
  };
}

test("feature-tree parser builds typed hierarchy and refs (AC-1)", () => {
  const tree = parseFeatureTreeMarkdown(FEATURE_TREE, { source: "fixture.md" });
  assert.equal(tree.kind, "FeatureTreeV1");
  assert.deepEqual(tree.roots, ["harness-inspector"]);
  assert.equal(tree.nodes[0].evidence, "candidate");
  assert.equal(tree.nodes[1].evidence, "declared");
  assert.equal(tree.nodes.length, 3);
  assert.deepEqual(tree.nodes[0].children, ["inspect-by-feature", "inspect-by-date"]);
  assert.equal(tree.nodes[1].parentId, "harness-inspector");
  assert.equal(tree.nodes[1].stage, "implementation");
  assert.deepEqual(tree.nodes[1].refs.sessions, ["codex/session-a"]);
  assert.deepEqual(featureTreeDescendantIds(tree, "harness-inspector"), [
    "harness-inspector",
    "inspect-by-feature",
    "inspect-by-date",
  ]);
});

test("feature-tree parser builds hierarchy and todo state from a Markdown checklist (AC-1)", () => {
  const tree = parseFeatureTreeMarkdown(CHECKLIST_TREE, { source: "checklist.md" });
  assert.deepEqual(tree.roots, ["better-harness"]);
  assert.equal(tree.nodes.length, 6);
  assert.equal(tree.nodes[0].type, "feature");
  assert.equal(tree.nodes[0].status, "todo");
  assert.deepEqual(tree.nodes[0].children, ["analyze-and-improve", "inspector"]);
  assert.equal(tree.nodes[1].status, "complete");
  assert.equal(tree.nodes[2].type, "story");
  assert.equal(tree.nodes[2].parentId, "analyze-and-improve");
  assert.deepEqual(featureTreeDescendantIds(tree, "inspector"), [
    "inspector",
    "browse-feature-delivery",
    "correlate-sessions-and-commits",
  ]);
});

test("feature-tree checklist rejects malformed indentation and duplicate generated ids (AC-1)", () => {
  const invalid = `- [ ] Root
   - [ ] Bad indent
- [ ] Root
`;
  assert.throws(
    () => parseFeatureTreeMarkdown(invalid, { source: "invalid-checklist.md" }),
    (error) => {
      assert.ok(error instanceof FeatureTreeParseError);
      assert.match(error.diagnostics.map((item) => item.message).join("\n"), /two spaces|duplicate id/u);
      return true;
    },
  );
});

test("feature-tree parser rejects orphan, duplicate, invalid date, and unknown metadata (AC-1)", () => {
  const invalid = `## Story: Orphan {#same}
- date: 2026-02-31
- invented: value
# Feature: Duplicate {#same}
`;
  assert.throws(
    () => parseFeatureTreeMarkdown(invalid, { source: "invalid.md" }),
    (error) => {
      assert.ok(error instanceof FeatureTreeParseError);
      assert.deepEqual(error.diagnostics.map((item) => item.line), [1, 2, 3, 4]);
      assert.match(error.diagnostics.map((item) => item.message).join("\n"), /orphan story|real YYYY-MM-DD|unsupported metadata|duplicate id/u);
      return true;
    },
  );
});

test("report model keeps declared, candidate, exact-file, and date evidence distinct (AC-3, AC-4)", () => {
  const tree = parseFeatureTreeMarkdown(FEATURE_TREE, { source: "/workspace/repo/feature-tree.md" });
  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: tree,
    sessions: [fixtureSession()],
    correlation: fixtureCorrelation(),
    filters: { platform: "codex", stage: "implementation", commitLimit: 20, sessionLimit: 20 },
  });
  assert.equal(report.kind, "HarnessInspectorReportV1");
  assert.equal(report.featureTree.source, "feature-tree.md");
  assert.equal(report.days.length, 2);
  assert.deepEqual(report.days[1].sessionIds, ["session-a"]);
  assert.deepEqual(report.days[1].commitHashes, ["a".repeat(40), "b".repeat(40)]);
  assert.deepEqual(report.stories[0].sessionLinks, [{ sessionId: "session-a", evidenceKind: "declared", confidence: "explicit" }]);
  assert.deepEqual(report.stories[1].sessionLinks, [{ sessionId: "session-a", evidenceKind: "candidate", confidence: "high" }]);
  assert.equal(report.sessions[0].commitLinks[0].confidence, "explicit");
  assert.deepEqual(report.sessions[0].commitLinks[0].overlappingFiles, ["scripts/harness-inspector/render-html.mjs"]);
  assert.equal(report.sessions[0].commitLinks[1].confidence, "high");
  assert.equal(report.sessions[0].toolActivity.kind, "NormalizedToolActivityV1");
  assert.equal(report.sessions[0].promptObservationCount, 2);
  assert.equal(report.sessions[0].commitLinks.some((link) => link.evidenceKind === "file-context"), true);
});

test("Inspector HTML emits both picker modes, three-lane workbench, expanded calls, and continuation boundary (AC-3, AC-5, AC-6)", () => {
  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: parseFeatureTreeMarkdown(FEATURE_TREE),
    sessions: [fixtureSession()],
    correlation: fixtureCorrelation(),
    filters: { platform: "codex", stage: "implementation" },
  });
  const html = renderHarnessInspectorHtml(report);
  assert.match(html, /^<!DOCTYPE html>/u);
  assert.match(html, /<link rel="icon" href="data:,">/u);
  assert.match(html, /data-harness-inspector/u);
  assert.match(html, /data-mode="feature"/u);
  assert.match(html, /data-mode="date"/u);
  assert.match(html, /data-feature-id="harness-inspector"/u);
  assert.match(html, /class="capability-tree" role="tree"/u);
  assert.match(html, /role="treeitem"/u);
  assert.match(html, /data-tree-toggle/u);
  assert.match(html, /class="tree-children" role="group"/u);
  assert.match(html, /data-date="2026-08-12"/u);
  assert.match(html, /id="workbench-list"/u);
  assert.match(html, /class="workspace-breadcrumb"/u);
  assert.match(html, /id="workspace-scope-crumb"/u);
  assert.match(html, /class="scope-metrics"/u);
  assert.match(html, /data-metric="stories"/u);
  assert.doesNotMatch(html, /Selected scope/u);
  assert.doesNotMatch(html, /class="scope-summary"/u);
  assert.doesNotMatch(html, /class="legend"/u);
  assert.match(html, /class="lane prompt-lane/u);
  assert.match(html, /Expand.*normalized actions/u);
  assert.match(html, /data-toggle-delivery/u);
  assert.match(html, /delivery-collapsed/u);
  assert.match(html, /focus view/u);
  assert.match(html, /data-toggle-picker/u);
  assert.match(html, /data-resize-lane="prompt"/u);
  assert.match(html, /data-resize-lane="delivery"/u);
  assert.match(html, /role="separator"/u);
  assert.match(html, /Open session/u);
  assert.match(html, /class="session-view"/u);
  assert.match(html, /data-session-kind-filter="prompts"/u);
  assert.match(html, /data-session-kind-filter="intermediate"/u);
  assert.match(html, /session-turn/u);
  assert.match(html, /<details class="session-event tools"/u);
  assert.match(html, /class="session-note-label">Intermediate response/u);
  assert.doesNotMatch(html, /<article class="session-event tools"/u);
  assert.match(html, /Implemented the date picker/u);
  assert.match(html, /Continuation packet/u);
  assert.match(html, /does not restore code/u);
  assert.match(html, /<svg class="swimlane-bubble-chart"/u);
  assert.match(html, /NormalizedToolActivityV1/u);
  assert.match(html, /data-action-lane="Read files"/u);
  assert.match(html, /data-swimlane-inspector/u);
  assert.match(html, /data-swimlane-responsive/u);
  assert.match(html, /ResizeObserver/u);
  assert.match(html, /data-action="Run tests"/u);
  assert.match(html, /data-tool="Bash"/u);
  assert.doesNotMatch(html, /class="call-list"/u);
  assert.match(html, /timing unavailable/u);
  assert.doesNotMatch(html, /--depth:NaN/u);
  assert.equal((html.match(/class="swimlane-bubble(?: failed)?(?: timed| unobserved)"/gu) ?? []).length, 2);
  assert.match(html, /observed same-path/u);
  assert.match(html, /same-file history/u);
  assert.match(html, /same path/u);
  assert.match(html, /candidate/u);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test("Inspector assembles one self-contained report from extracted UI assets (AC-2, AC-7)", () => {
  const template = readFileSync(new URL("workbench.html", INSPECTOR_UI_ROOT), "utf8");
  const styles = readFileSync(new URL("workbench.css", INSPECTOR_UI_ROOT), "utf8");
  const script = readFileSync(new URL("workbench.js", INSPECTOR_UI_ROOT), "utf8");
  assert.match(template, /^<!DOCTYPE html>/u);
  assert.match(template, /\{\{BH_STYLES\}\}/u);
  assert.match(template, /\{\{BH_REPORT_JSON\}\}/u);
  assert.match(template, /\{\{BH_SCRIPT\}\}/u);
  assert.match(styles, /\.workbench-grid/u);
  assert.match(script, /function renderScope/u);

  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: parseFeatureTreeMarkdown(FEATURE_TREE),
    sessions: [fixtureSession()],
    correlation: fixtureCorrelation(),
    filters: { platform: "codex" },
  });
  const html = renderHarnessInspectorHtml(report);
  assert.doesNotMatch(html, /\{\{BH_[A-Z_]+\}\}/u);
  assert.match(html, /<style>[\s\S]*\.workbench-grid/u);
  assert.match(html, /<script>[\s\S]*function renderScope/u);
});

test("Inspector template assembly does not reinterpret token-like session evidence", () => {
  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: parseFeatureTreeMarkdown(FEATURE_TREE),
    sessions: [fixtureSession({
      toolActivity: {
        ...fixtureSession().toolActivity,
        calls: fixtureSession().toolActivity.calls.map((call, index) => index === 0
          ? { ...call, detail: "inspect literal {{BH_TRACE_TEMPLATES}} in source" }
          : call),
      },
    })],
    correlation: fixtureCorrelation(),
    filters: { platform: "codex" },
  });
  const html = renderHarnessInspectorHtml(report);
  assert.match(html, /inspect literal \{\{BH_TRACE_TEMPLATES\}\} in source/u);
  assert.match(html, /<template data-trace-session="session-a">/u);
});

test("Inspector tree renders checklist todo state and nested branches (AC-3)", () => {
  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: parseFeatureTreeMarkdown(CHECKLIST_TREE),
    sessions: [],
    correlation: { schemaVersion: 1, commits: [] },
    filters: {},
  });
  const html = renderHarnessInspectorHtml(report);
  assert.match(html, /class="tree-check complete" role="img" aria-label="Complete"/u);
  assert.match(html, /class="tree-check todo" role="img" aria-label="Todo"/u);
  assert.match(html, /data-tree-node-id="inspector" aria-expanded="true"/u);
  assert.match(html, /setTreeItemExpanded/u);
  assert.match(html, /initializeTree/u);
});

test("Inspector final HTML redacts credentials and omits absolute roots (AC-7)", () => {
  const secret = "sk-fixtureSecret123456789";
  const tree = parseFeatureTreeMarkdown(FEATURE_TREE.replace("Trace one declared delivery story.", `Trace secret=${secret}.`), {
    source: "/Users/private/workspace/feature-tree.md",
  });
  const report = buildHarnessInspectorReport({
    repoRoot: "/Users/private/workspace",
    featureTree: tree,
    sessions: [fixtureSession({
      prompts: [{ text: `Authorization: Bearer ${secret} /Users/private/secret.txt`, timestamp: "2026-08-12T08:00:00.000Z" }],
      dialogue: {
        truncated: false,
        turns: [{
          index: 1,
          prompt: { text: `Authorization: Bearer ${secret} /Users/private/prompt.txt`, timestamp: "2026-08-12T08:00:00.000Z" },
          steps: [{ kind: "note", text: `Read /Users/private/note.txt with token=${secret}` }],
          response: `Done in /Users/private/response.txt with secret=${secret}`,
          toolCallCount: 0,
          messageCount: 2,
        }],
      },
      tokenUsage: { inputTokens: 5, outputTokens: 3, secret },
    })],
    correlation: {
      ...fixtureCorrelation(),
      commits: fixtureCorrelation().commits.map((commit) => ({
        ...commit,
        subject: `${commit.subject} /Users/private/commit.txt`,
        authorName: "C:\\Users\\private\\author",
      })),
    },
    filters: { platform: "codex" },
  });
  const html = renderHarnessInspectorHtml(report);
  assert.doesNotMatch(html, new RegExp(secret, "u"));
  assert.doesNotMatch(html, /\/Users\/private/u);
  assert.doesNotMatch(html, /C:\\\\Users\\\\private/u);
  assert.match(html, /&lt;redacted&gt;|\\u003credacted>/u);
  assert.match(html, /absolute-path/u);
});

test("declared refs keep platform identity and reject ambiguous commit prefixes", () => {
  const tree = parseFeatureTreeMarkdown(`# Feature: Refs {#refs}\n## Story: Strict refs {#strict-refs}\n- session: qoder/session-a\n- commit: aaaaaaa\n`);
  const correlation = fixtureCorrelation();
  correlation.commits.push({ ...correlation.commits[0], hash: `aaaaaaa${"f".repeat(33)}`, shortHash: "aaaaaaa" });
  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: tree,
    sessions: [fixtureSession()],
    correlation,
  });
  assert.deepEqual(report.stories[0].sessionLinks, []);
  assert.deepEqual(report.stories[0].commitHashes, []);
  assert.equal(report.diagnostics.some((item) => item.includes("ambiguous")), true);
});

test("date index includes every UTC day spanned by a session", () => {
  const report = buildHarnessInspectorReport({
    repoRoot: "/workspace/repo",
    featureTree: parseFeatureTreeMarkdown(FEATURE_TREE),
    sessions: [fixtureSession({
      firstSeen: "2026-08-11T23:30:00.000Z",
      lastSeen: "2026-08-12T01:00:00.000Z",
      prompts: [{ text: "Continue after midnight", timestamp: "2026-08-12T00:10:00.000Z" }],
    })],
    correlation: { commits: [] },
  });
  assert.deepEqual(report.days.map((day) => day.date), ["2026-08-11", "2026-08-12"]);
  assert.deepEqual(report.days.map((day) => day.sessionIds), [["session-a"], ["session-a"]]);
  assert.deepEqual(report.days.map((day) => day.promptCount), [0, 1]);
});

test("session summary retains more than one thousand tool calls unless a caller chooses a limit (AC-5)", () => {
  const events = Array.from({ length: 1_005 }, (_, index) => ({
    type: "tool.requested",
    category: "tool",
    lifecyclePhase: "request",
    toolName: index % 2 ? "Read" : "Bash",
    toolInvocationId: `call-${index}`,
    timestamp: new Date(Date.UTC(2026, 7, 12, 8, 0, index)).toISOString(),
  }));
  const summary = summarizeSessionEvents({ sessionId: "large-session" }, events, {
    repoRoot: "/workspace/repo",
    platform: "codex",
    includeToolTrace: true,
  });
  assert.equal(summary.toolCallCount, 1_005);
  assert.equal(summary.toolTrace.totalCalls, 1_005);
  assert.equal(summary.toolTrace.shownCalls, 1_005);
  assert.equal(summary.toolTrace.truncated, false);
});

test("Harness Inspector help is workspace-independent and sanitizes bad argv (AC-2, AC-8)", () => {
  const help = spawnSync(process.execPath, [CLI_PATH, "--help"], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Harness Inspector v1/u);
  assert.match(help.stdout, /Feature Tree and Date scope pickers/u);
  assert.equal(help.stderr, "");

  const privateValue = path.join(os.tmpdir(), "private-feature-tree");
  const invalid = spawnSync(process.execPath, [CLI_PATH, "render", "--unknown", privateValue], { encoding: "utf8" });
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stderr.includes(privateValue), false);
});
