import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachCommitsToTurns,
  attachCheckpointFactsToSessions,
  attributeSessionToolName,
  boundedGraceMinutes,
  buildSessionViewerReport,
  buildSessionTurns,
  changeBreakdown,
  classifyChangePath,
  collectCommitFacts,
  collectEntireCheckpointFacts,
  correlateCommitSession,
  correlateCommitsWithSessions,
  miniMarkdownToHtml,
  parseNumstatZ,
  parseSessionLinkTrailers,
  parseSessionTrailers,
  redactTranscriptText,
  renderCommitSessionHtml,
  renderSessionViewerHtml,
  summarizeSessionEvents,
} from "../scripts/commit-session-link/index.mjs";

const CLI_PATH = fileURLToPath(new URL("../scripts/commit-session-link/cli.mjs", import.meta.url));

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(cwd, ".gitconfig-isolated"),
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      ...env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stderr}`);
  }
  return result.stdout;
}

function gitInput(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(cwd, ".gitconfig-isolated"),
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed\n${result.stderr}`);
  return result.stdout.trim();
}

function createCheckpointTree(root, checkpointId, sessionId, transcript = null) {
  const summary = JSON.stringify({
    checkpoint_id: checkpointId,
    checkpoints_count: 1,
    files_touched: ["src/app.mjs"],
    sessions: [{ metadata: "/0/metadata.json", transcript: "/0/full.jsonl" }],
  });
  const metadata = JSON.stringify({
    checkpoint_id: checkpointId,
    session_id: sessionId,
    agent: "Claude Code",
    model: "claude-opus-4-8[1m]",
  });
  const summaryBlob = gitInput(root, ["hash-object", "-w", "--stdin"], summary);
  const metadataBlob = gitInput(root, ["hash-object", "-w", "--stdin"], metadata);
  const sessionEntries = [{ path: "metadata.json", line: `100644 blob ${metadataBlob}\tmetadata.json` }];
  if (transcript !== null) {
    const transcriptBlob = gitInput(root, ["hash-object", "-w", "--stdin"], transcript);
    sessionEntries.push({ path: "full.jsonl", line: `100644 blob ${transcriptBlob}\tfull.jsonl` });
  }
  const sessionTree = gitInput(root, ["mktree"], `${sessionEntries.sort((a, b) => a.path.localeCompare(b.path)).map((entry) => entry.line).join("\n")}\n`);
  return gitInput(root, ["mktree"], [
    `040000 tree ${sessionTree}\t0`,
    `100644 blob ${summaryBlob}\tmetadata.json`,
    "",
  ].join("\n"));
}

function createCheckpointRef(root, checkpointId, sessionId, transcript = null) {
  const rootTree = createCheckpointTree(root, checkpointId, sessionId, transcript);
  const checkpointCommit = gitInput(root, ["commit-tree", rootTree, "-m", `Checkpoint: ${checkpointId}`], "");
  git(root, ["update-ref", `refs/entire/checkpoints/${checkpointId.slice(-2)}/${checkpointId}`, checkpointCommit]);
}

function createCheckpointBranch(root, checkpointId, sessionId) {
  const checkpointTree = createCheckpointTree(root, checkpointId, sessionId);
  const shardTree = gitInput(root, ["mktree"], `040000 tree ${checkpointTree}\t${checkpointId.slice(2)}\n`);
  const rootTree = gitInput(root, ["mktree"], `040000 tree ${shardTree}\t${checkpointId.slice(0, 2)}\n`);
  const checkpointCommit = gitInput(root, ["commit-tree", rootTree, "-m", `Checkpoint: ${checkpointId}`], "");
  git(root, ["update-ref", "refs/heads/entire/checkpoints/v1", checkpointCommit]);
}

async function createFixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "commit-session-link-"));
  git(root, ["init", "--initial-branch=main"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.mjs"), "export const app = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "feat: add app module"], {
    GIT_AUTHOR_DATE: "2026-08-01T10:00:00+08:00",
    GIT_COMMITTER_DATE: "2026-08-01T10:00:00+08:00",
  });
  await writeFile(path.join(root, "src", "app.mjs"), "export const app = 2;\nexport const extra = true;\n");
  git(root, ["add", "."]);
  git(root, [
    "commit",
    "-m",
    "fix: bump app value\n\nExplains the change.\n\nHarness-Session: qoder/fixture-session-a",
  ], {
    GIT_AUTHOR_DATE: "2026-08-02T11:30:00+08:00",
    GIT_COMMITTER_DATE: "2026-08-02T11:30:00+08:00",
  });
  return root;
}

function fixtureSession(overrides = {}) {
  return {
    sessionId: "fixture-session-a",
    platform: "qoder",
    firstSeen: "2026-08-02T10:00:00+08:00",
    lastSeen: "2026-08-02T11:20:00+08:00",
    cwdWithinRepo: true,
    files: ["src/app.mjs"],
    prompts: [{ text: "bump the app value", timestamp: "2026-08-02T10:00:00+08:00" }],
    promptCount: 1,
    toolCallCount: 3,
    models: ["fixture-model"],
    tokenUsage: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 0 },
    durationMs: 80 * 60_000,
    ...overrides,
  };
}

test("collectCommitFacts parses numstat, subject, and session trailers (AC-1, AC-2)", async (t) => {
  const root = await createFixtureRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { repoRoot, commits } = collectCommitFacts({ workspace: root, limit: 10 });
  assert.equal(commits.length, 2);
  const [latest, initial] = commits;
  assert.equal(latest.subject, "fix: bump app value");
  assert.deepEqual(latest.sessionTrailers, ["qoder/fixture-session-a"]);
  assert.deepEqual(latest.files, [{ path: "src/app.mjs", added: 2, removed: 1 }]);
  assert.equal(initial.subject, "feat: add app module");
  assert.deepEqual(initial.sessionTrailers, []);
  assert.equal(path.basename(repoRoot), path.basename(root));

  const single = collectCommitFacts({ workspace: root, commit: "HEAD" });
  assert.equal(single.commits.length, 1);
  assert.equal(single.commits[0].hash, latest.hash);
});

test("collectCommitFacts rejects unknown commits", async (t) => {
  const root = await createFixtureRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => collectCommitFacts({ workspace: root, commit: "0000000000000000000000000000000000000000" }),
    (error) => error.code === "GIT_FAILED" || error.code === "COMMIT_NOT_FOUND",
  );
});

test("parseSessionTrailers accepts Harness-Session and Entire-Checkpoint trailers", () => {
  const body = "Body text\n\nHarness-Session: qoder/abc\nEntire-Checkpoint: 01KXDSREBG8S07KQ15HHD21NHF\n";
  assert.deepEqual(parseSessionTrailers(body), ["qoder/abc", "01KXDSREBG8S07KQ15HHD21NHF"]);
  assert.deepEqual(parseSessionTrailers("no trailers here"), []);
});

test("typed trailers keep Entire checkpoints distinct from Harness sessions (AC-2, AC-9)", () => {
  assert.deepEqual(
    parseSessionLinkTrailers("Harness-Session: claude/session-a\nEntire-Checkpoint: 01KXDM08H2V0SZREV3NDG2R38M\n"),
    [
      { type: "harness-session", value: "claude/session-a" },
      { type: "entire-checkpoint", value: "01KXDM08H2V0SZREV3NDG2R38M" },
    ],
  );
});

test("NUL numstat parsing preserves tabs, newlines, and rename destinations (AC-10)", () => {
  assert.deepEqual(parseNumstatZ([
    "1\t0\tsrc/tab\tname.mjs",
    "2\t1\tsrc/line\nname.mjs",
    "0\t0\t",
    "src/old.mjs",
    "src/new.mjs",
    "",
  ].join("\0")), [
    { path: "src/tab\tname.mjs", added: 1, removed: 0 },
    { path: "src/line\nname.mjs", added: 2, removed: 1 },
    { path: "src/new.mjs", added: 0, removed: 0 },
  ]);
});

test("collectCommitFacts preserves adversarial Git paths through --numstat -z (AC-10)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commit-session-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  const paths = ["src/tab\tname.mjs", "src/line\nname.mjs"];
  await Promise.all(paths.map((filePath) => writeFile(path.join(root, filePath), "export default true;\n")));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "test: add unusual paths"]);
  const { commits } = collectCommitFacts({ workspace: root, commit: "HEAD" });
  assert.deepEqual(commits[0].files.map((file) => file.path).sort(), [...paths].sort());
});

test("reference-shape checkpoint refs resolve three ULIDs to a distinct session UUID (AC-9, AC-13)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commit-session-checkpoints-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.mjs"), "export const value = 0;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "chore: initialize fixture"]);

  const sessionId = "0708a5fa-06bd-4274-b1fe-513c7202217e";
  const checkpointIds = [
    "01KXDKNGABW47M7NK1W0RF1VMR",
    "01KXDM08H2V0SZREV3NDG2R38M",
    "01KXDSREBG8S07KQ15HHD21NHF",
  ];
  for (const [index, checkpointId] of checkpointIds.entries()) {
    await writeFile(path.join(root, "src", "app.mjs"), `export const value = ${index + 1};\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", `fix: checkpoint ${index + 1}\n\nEntire-Checkpoint: ${checkpointId}`]);
    createCheckpointRef(root, checkpointId, sessionId);
  }

  const { repoRoot, commits } = collectCommitFacts({ workspace: root, limit: 10 });
  const checkpointResolution = collectEntireCheckpointFacts({ repoRoot, commits });
  assert.deepEqual(checkpointResolution.unresolved, []);
  assert.deepEqual(checkpointResolution.checkpoints.map((fact) => fact.checkpointId), checkpointIds.slice().reverse());
  assert.ok(checkpointResolution.checkpoints.every((fact) => fact.sessions[0].transcriptPath === "0/full.jsonl"));
  const [session] = attachCheckpointFactsToSessions([fixtureSession({ sessionId })], checkpointResolution.checkpoints);
  assert.deepEqual(new Set(session.checkpointIds), new Set(checkpointIds));
  const linked = commits
    .filter((commit) => commit.sessionLinks.some((link) => link.type === "entire-checkpoint"))
    .map((commit) => correlateCommitSession(commit, session));
  assert.equal(linked.length, 3);
  assert.ok(linked.every((match) => match?.confidence === "explicit"));
  assert.deepEqual(new Set(linked.map((match) => match.evidence.checkpointId)), new Set(checkpointIds));
});

test("legacy entire/checkpoints/v1 metadata resolves without checking out the branch (AC-9)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commit-session-checkpoint-branch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  const checkpointId = "a3b2c4d5e6f7";
  const sessionId = "legacy-session-id";
  createCheckpointBranch(root, checkpointId, sessionId);
  const resolution = collectEntireCheckpointFacts({
    repoRoot: root,
    commits: [{ sessionLinks: [{ type: "entire-checkpoint", value: checkpointId }] }],
  });
  assert.deepEqual(resolution.unresolved, []);
  assert.equal(resolution.checkpoints[0].backend, "git-branch");
  assert.deepEqual(resolution.checkpoints[0].sessionIds, [sessionId]);
});

test("render-session prefers the newest self-contained transcript when one Entire session has several checkpoints (AC-9, AC-12)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commit-session-entire-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.mjs"), "export const value = 1;\n");
  git(root, ["add", "."]);
  const olderCheckpointId = "01KXDKNGZZVP4MG9BXY97ZA1MR";
  const checkpointId = "01KXDM08H2V0SZREV3NDG2R38M";
  const newestCheckpointId = "01KXDSREBG8S07KQ15HHD21NHF";
  const sessionId = "0708a5fa-06bd-4274-b1fe-513c7202217e";
  git(root, ["commit", "-m", `fix: older checkpoint\n\nEntire-Checkpoint: ${olderCheckpointId}`]);
  await writeFile(path.join(root, "src", "app.mjs"), "export const value = 2;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", `fix: checkpoint-backed session\n\nEntire-Checkpoint: ${checkpointId}`]);
  await writeFile(path.join(root, "src", "app.mjs"), "export const value = 3;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", `fix: newest metadata-only checkpoint\n\nEntire-Checkpoint: ${newestCheckpointId}`]);
  const transcript = [
    JSON.stringify({
      type: "user",
      sessionId,
      cwd: root,
      timestamp: "2026-08-02T10:00:00Z",
      message: { content: "Fix the compilation issue" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      cwd: root,
      timestamp: "2026-08-02T10:02:00Z",
      message: {
        model: "claude-opus-4-8[1m]",
        content: [{ type: "text", text: "## Done\n\nCompilation is fixed." }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }),
    "",
  ].join("\n");
  const olderTranscript = transcript.replaceAll("Fix the compilation issue", "STALE CHECKPOINT TRANSCRIPT");
  createCheckpointRef(root, olderCheckpointId, sessionId, olderTranscript);
  createCheckpointRef(root, checkpointId, sessionId, transcript);
  createCheckpointRef(root, newestCheckpointId, sessionId);
  const result = spawnSync(process.execPath, [
    CLI_PATH,
    "render-session",
    "--workspace",
    root,
    "--platform",
    "claude",
    "--session-id",
    sessionId,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { outputPath } = JSON.parse(result.stdout);
  assert.match(path.basename(outputPath), /^session-viewer-.+\.html$/u);
  const html = await readFile(outputPath, "utf8");
  assert.match(html, /Fix the compilation issue/u);
  assert.doesNotMatch(html, /STALE CHECKPOINT TRANSCRIPT/u);
  assert.match(html, /Compilation is fixed/u);
  assert.match(html, /explicit link/u);
  assert.match(html, /id="commit-[0-9a-f]{40}"/u);
  assert.doesNotMatch(html, /id="checkpoint-/u);
});

test("correlation ranks explicit > high > medium > low and drops non-overlapping sessions (AC-1, AC-2)", () => {
  const commit = {
    hash: "a".repeat(40),
    shortHash: "aaaaaaa",
    subject: "fix: bump app value",
    authorName: "Fixture Author",
    authoredAt: "2026-08-02T11:30:00+08:00",
    files: [{ path: "src/app.mjs", added: 2, removed: 1 }],
    sessionTrailers: ["qoder/explicit-session"],
  };
  const sessions = [
    fixtureSession({ sessionId: "explicit-session", files: [], cwdWithinRepo: false, firstSeen: null, lastSeen: null }),
    fixtureSession({ sessionId: "high-session" }),
    fixtureSession({ sessionId: "medium-session", files: [] }),
    fixtureSession({ sessionId: "low-session", files: [], cwdWithinRepo: false }),
    fixtureSession({
      sessionId: "outside-window",
      firstSeen: "2026-08-02T06:00:00+08:00",
      lastSeen: "2026-08-02T07:00:00+08:00",
    }),
  ];

  const report = correlateCommitsWithSessions([commit], sessions, { graceMinutes: 45 });
  const matches = report.commits[0].matches;
  assert.deepEqual(
    matches.map((match) => [match.sessionId, match.confidence]),
    [
      ["explicit-session", "explicit"],
      ["high-session", "high"],
      ["medium-session", "medium"],
      ["low-session", "low"],
    ],
  );
  assert.equal(matches[0].evidence.trailer, "qoder/explicit-session");
  assert.deepEqual(matches[1].evidence.overlappingFiles, ["src/app.mjs"]);
});

test("grace window boundary controls time overlap (AC-2)", () => {
  const commit = {
    hash: "b".repeat(40),
    shortHash: "bbbbbbb",
    subject: "chore: tail commit",
    authoredAt: "2026-08-02T12:05:00+08:00",
    files: [],
    sessionTrailers: [],
  };
  const session = fixtureSession({ sessionId: "tail-session", files: [] });
  assert.equal(
    correlateCommitSession(commit, session, { graceMs: 45 * 60_000 })?.confidence,
    "medium",
  );
  assert.equal(correlateCommitSession(commit, session, { graceMs: 30 * 60_000 }), null);
});

test("heuristic correlation uses committer time rather than preserved author time (AC-10)", () => {
  const match = correlateCommitSession({
    hash: "b".repeat(40),
    authoredAt: "2020-01-01T00:00:00Z",
    committedAt: "2026-08-02T11:30:00+08:00",
    files: [{ path: "src/app.mjs", added: 1, removed: 0 }],
    sessionLinks: [],
    sessionTrailers: [],
  }, fixtureSession());
  assert.equal(match?.confidence, "high");
  assert.equal(match?.evidence.commitTimeBasis, "committedAt");
});

test("boundedGraceMinutes clamps invalid and oversized values", () => {
  assert.equal(boundedGraceMinutes(undefined), 45);
  assert.equal(boundedGraceMinutes("-3"), 45);
  assert.equal(boundedGraceMinutes("10"), 10);
  assert.equal(boundedGraceMinutes(100_000), 24 * 60);
});

test("summarizeSessionEvents extracts repo-relative files, prompts, tools, and tokens (AC-4)", () => {
  const repoRoot = path.resolve("/tmp/fixture-repo");
  const events = [
    {
      type: "user",
      userPrompt: true,
      userText: "please fix the bug in the parser",
      timestamp: "2026-08-02T10:00:00+08:00",
      cwd: repoRoot,
    },
    {
      type: "tool.requested",
      category: "tool",
      lifecyclePhase: "request",
      filePath: path.join(repoRoot, "src", "parser.mjs"),
      timestamp: "2026-08-02T10:05:00+08:00",
    },
    {
      type: "tool.call",
      category: "tool",
      lifecyclePhase: "request",
      filePath: path.join(repoRoot, "..", "outside", "secret.txt"),
      timestamp: "2026-08-02T10:06:00+08:00",
    },
    {
      type: "model.response.completed",
      modelUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10 },
      model: "fixture-model",
      timestamp: "2026-08-02T10:07:00+08:00",
    },
  ];
  const summary = summarizeSessionEvents(
    { sessionId: "s-1", firstSeen: null, lastSeen: null },
    events,
    { repoRoot, platform: "qoder", includeToolTrace: true },
  );
  assert.deepEqual(summary.files, ["src/parser.mjs"]);
  assert.equal(summary.cwdWithinRepo, true);
  assert.equal(summary.toolCallCount, 2);
  assert.equal(summary.promptCount, 1);
  assert.equal(summary.prompts.length, 1);
  assert.deepEqual(summary.tokenUsage, { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10 });
  assert.equal(summary.firstSeen, new Date("2026-08-02T10:00:00+08:00").toISOString());
  assert.equal(summary.toolTrace.totalCalls, 2);
});

test("Codex exec attribution exposes the nested local capability (AC-16)", () => {
  assert.equal(attributeSessionToolName({
    toolName: "exec",
    commandText: "const result = await tools.exec_command({ cmd: 'git status' }); text(result.output);",
  }), "exec_command");
  assert.equal(attributeSessionToolName({
    toolName: "exec",
    commandText: "const result = await tools.mcp__node_repl__js({ code: `await localSessionTab.playwright.domSnapshot()` }); text(result);",
  }), "browser");
  assert.equal(attributeSessionToolName({
    toolName: "exec",
    commandText: "const matches = ALL_TOOLS.filter((tool) => tool.name.includes('browser')); text(matches);",
  }), "tool_search");
  assert.equal(attributeSessionToolName({ toolName: "Bash", commandText: "git status" }), "Bash");
});

test("classifyChangePath and changeBreakdown split code, tests, and docs", () => {
  assert.equal(classifyChangePath("scripts/foo/cli.mjs"), "code");
  assert.equal(classifyChangePath("test/foo.test.mjs"), "tests");
  assert.equal(classifyChangePath("docs/specs/example.md"), "docs");
  const breakdown = changeBreakdown([
    { path: "scripts/foo/cli.mjs", added: 10, removed: 2 },
    { path: "test/foo.test.mjs", added: 20, removed: 0 },
    { path: "README.md", added: 3, removed: 1 },
  ]);
  assert.equal(breakdown.code.added, 10);
  assert.equal(breakdown.tests.files, 1);
  assert.equal(breakdown.docs.removed, 1);
});

test("renderCommitSessionHtml emits a self-contained, escaped, privacy-safe page (AC-3, AC-4)", () => {
  const session = fixtureSession({
    prompts: [{ text: "add <script>alert(1)</script> handling", timestamp: null }],
  });
  const commit = {
    hash: "c".repeat(40),
    shortHash: "ccccccc",
    subject: "feat: add <script> guard ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    authorName: "Fixture Author ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    authoredAt: "2026-08-02T11:30:00+08:00",
    files: [{ path: "src/app.mjs", added: 2, removed: 1 }],
    matches: [
      {
        sessionId: session.sessionId,
        platform: "qoder",
        confidence: "high",
        evidence: {
          trailer: null,
          timeOverlap: true,
          commitToLastSeenMs: 600_000,
          overlappingFileCount: 1,
          overlappingFiles: ["src/app.mjs"],
          cwdWithinRepo: true,
        },
      },
    ],
  };
  const html = renderCommitSessionHtml({ commit, sessions: [session], graceMinutes: 45 });
  assert.match(html, /^<!DOCTYPE html>/u);
  assert.match(html, /feat: add &lt;script&gt; guard/u);
  assert.doesNotMatch(html, /ghp_0123456789abcdefghijklmnopqrstuvwxyz/u);
  assert.match(html, /add &lt;script&gt;alert\(1\)&lt;\/script&gt; handling/u);
  assert.doesNotMatch(html, /<script/u);
  assert.match(html, /High · files \+ time/u);
  assert.match(html, /src\/app\.mjs/u);
  assert.match(html, /1\.2K/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("renderCommitSessionHtml shows an empty state when nothing matches (AC-3)", () => {
  const html = renderCommitSessionHtml({
    commit: {
      hash: "d".repeat(40),
      shortHash: "ddddddd",
      subject: "chore: lonely commit",
      authorName: null,
      authoredAt: "2026-08-02T11:30:00+08:00",
      files: [],
      matches: [],
    },
    sessions: [],
    graceMinutes: 45,
  });
  assert.match(html, /No sessions correlated with this commit/u);
});

test("cli --help prints help with empty stderr and exit 0, even after unknown args (AC-5)", () => {
  for (const argv of [["--help"], ["-h"], [], ["correlate", "--bogus", "value", "--help"]]) {
    const result = spawnSync(process.execPath, [CLI_PATH, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Commit Session Link v1/u);
  }
});

test("cli rejects unknown commands and options without echoing values (AC-5)", () => {
  const unknown = spawnSync(process.execPath, [CLI_PATH, "bogus"], { encoding: "utf8" });
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /Unknown command/u);

  const privateValue = "/tmp/very-private-location";
  const badOption = spawnSync(
    process.execPath,
    [CLI_PATH, "correlate", "--private-flag", privateValue],
    { encoding: "utf8" },
  );
  assert.equal(badOption.status, 64);
  assert.doesNotMatch(badOption.stderr, new RegExp(privateValue.replaceAll("/", "\\/"), "u"));
});

test("buildSessionTurns folds prompts, steps, and responses into turns (AC-7)", () => {
  const events = [
    { type: "user", userPrompt: true, userText: "fix the bug", timestamp: "2026-08-02T10:00:00Z" },
    {
      type: "tool.requested",
      category: "tool",
      lifecyclePhase: "request",
      toolName: "Bash",
      commandText: "npm test",
      toolInvocationId: "call-1",
      timestamp: "2026-08-02T10:01:00Z",
    },
    // Duplicate lane record for the same invocation must not double-count.
    {
      type: "tool.requested",
      category: "tool",
      lifecyclePhase: "request",
      toolName: "Bash",
      commandText: "npm test",
      toolInvocationId: "call-1",
      timestamp: "2026-08-02T10:01:00Z",
    },
    { type: "assistant", content: "Let me look first.", timestamp: "2026-08-02T10:02:00Z" },
    { type: "assistant", content: "## Done\n\nFixed the `parser` bug.", timestamp: "2026-08-02T10:03:00Z" },
    { type: "user", userPrompt: true, userText: "thanks, commit it", timestamp: "2026-08-02T10:10:00Z" },
    { type: "assistant", content: "Committed.", timestamp: "2026-08-02T10:11:00Z" },
  ];
  const { turns, truncated } = buildSessionTurns(events);
  assert.equal(truncated, false);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt.text, "fix the bug");
  assert.equal(turns[0].toolCallCount, 1);
  assert.deepEqual(turns[0].steps[0], { kind: "tool", toolName: "Bash", detail: "npm test" });
  assert.equal(turns[0].steps[1].kind, "note");
  assert.match(turns[0].response, /## Done/u);
  assert.equal(turns[0].durationMs, 3 * 60_000);
  assert.equal(turns[1].response, "Committed.");
});

test("buildSessionTurns skips meta and injected-only prompts and unwraps JSON payloads (AC-7)", () => {
  const events = [
    {
      type: "user",
      userPrompt: true,
      userInputMeta: true,
      userText: "<local-command-caveat>ignore me</local-command-caveat>",
      timestamp: "2026-08-02T09:59:00Z",
    },
    {
      type: "user",
      userPrompt: true,
      userText: "<recommended_plugins>injected</recommended_plugins>\n# AGENTS.md instructions for /tmp/repo\n<INSTRUCTIONS>injected rules</INSTRUCTIONS>\n<environment_context>injected environment</environment_context>",
      timestamp: "2026-08-02T09:59:30Z",
    },
    {
      type: "user",
      userPrompt: true,
      userText: "<command-message>run it</command-message><command-name>/better-harness</command-name>",
      timestamp: "2026-08-02T10:00:00Z",
    },
    {
      type: "assistant",
      content: JSON.stringify({ content: [{ type: "text", text: "All checks green." }] }),
      timestamp: "2026-08-02T10:05:00Z",
    },
    {
      type: "user",
      userPrompt: true,
      userText: "<command-message>run it</command-message><command-name>/better-harness</command-name>",
      timestamp: "2026-08-02T10:00:00Z",
    },
  ];
  const { turns } = buildSessionTurns(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt.text, "/better-harness");
  assert.equal(turns[0].response, "All checks green.");
});

test("buildSessionTurns removes Codex transport metadata from assistant prose (AC-7, AC-11)", () => {
  const { turns } = buildSessionTurns([
    { type: "user", userPrompt: true, userText: "review it", timestamp: "2026-08-02T10:00:00Z" },
    {
      type: "assistant",
      content: "Done.\n\n::code-comment{title=\"P1\" body=\"hidden transport\" file=\"/tmp/x\"}\n<oai-mem-citation><citation_entries>private</citation_entries></oai-mem-citation>",
      timestamp: "2026-08-02T10:01:00Z",
    },
  ]);
  assert.equal(turns[0].response, "Done.");
});

test("attachCommitsToTurns places commits inside the producing turn window (AC-8)", () => {
  const { turns } = buildSessionTurns([
    { type: "user", userPrompt: true, userText: "first", timestamp: "2026-08-02T10:00:00Z" },
    { type: "assistant", content: "done one", timestamp: "2026-08-02T10:05:00Z" },
    { type: "user", userPrompt: true, userText: "second", timestamp: "2026-08-02T11:00:00Z" },
    { type: "assistant", content: "done two", timestamp: "2026-08-02T11:05:00Z" },
  ]);
  attachCommitsToTurns(turns, [
    { shortHash: "aaaaaaa", subject: "first commit", authoredAt: "2026-08-02T10:30:00Z", sessionTrailers: [] },
    { shortHash: "bbbbbbb", subject: "late commit", authoredAt: "2026-08-02T11:20:00Z", sessionTrailers: ["qoder/x"] },
  ], { graceMs: 45 * 60_000 });
  assert.deepEqual(turns[0].commits.map((commit) => commit.shortHash), ["aaaaaaa"]);
  assert.deepEqual(turns[1].commits.map((commit) => commit.shortHash), ["bbbbbbb"]);
});

test("redactTranscriptText keeps structure and paths but redacts credentials (AC-4)", () => {
  const input = "Run `npm test` in /Users/dev/repo\n\n```js\nconst x = 1;\n```\ntoken=ghp_abcdefghijklmnop123456";
  const output = redactTranscriptText(input, { limit: 500 });
  assert.match(output, /\n/u);
  assert.match(output, /\/Users\/dev\/repo/u);
  assert.match(output, /<secret>/u);
  assert.doesNotMatch(output, /ghp_/u);
  assert.equal(redactTranscriptText("x".repeat(40), { limit: 24 }), `${"x".repeat(24)}…`);
});

test("rendered tool and commit lanes do not retain credential-shaped text (AC-11)", () => {
  const syntheticSecret = "ghp_abcdefghijklmnop123456";
  const { turns } = buildSessionTurns([
    { type: "user", userPrompt: true, userText: "run the release", timestamp: "2026-08-02T10:00:00Z" },
    {
      type: "tool.requested",
      category: "tool",
      lifecyclePhase: "request",
      toolName: "Bash",
      commandText: `curl -H 'Authorization: Bearer ${syntheticSecret}' https://example.invalid`,
      timestamp: "2026-08-02T10:01:00Z",
    },
    { type: "assistant", content: `done without ${syntheticSecret}`, timestamp: "2026-08-02T10:02:00Z" },
  ]);
  attachCommitsToTurns(turns, [{
    hash: "e".repeat(40),
    shortHash: "eeeeeee",
    subject: `fix: remove ${syntheticSecret}`,
    body: `Credential was ${syntheticSecret}`,
    authorName: "Fixture Author",
    authoredAt: "2026-08-02T10:01:30Z",
    committedAt: "2026-08-02T10:01:30Z",
    files: [{ path: "src/app.mjs", added: 1, removed: 0 }],
    sessionLinks: [],
    sessionTrailers: [syntheticSecret],
  }]);
  const html = renderSessionViewerHtml({ session: fixtureSession(), turns, commitCount: 1 });
  assert.doesNotMatch(html, new RegExp(syntheticSecret, "u"));
  assert.match(html, /&lt;secret&gt;|&lt;redacted&gt;/u);
});

test("SessionViewerReportV1 is one projection for timeline, activity, and tool trace (AC-12, AC-16)", () => {
  const report = buildSessionViewerReport({
    session: {
      ...fixtureSession(),
      assistantMessageCount: 5,
      fileEditCount: 1,
      toolTrace: { schemaVersion: 2, totalCalls: 3, shownCalls: 1, truncated: true, calls: [{ id: "T2", step: 2, toolName: "Bash", status: "observed", durationStatus: "unobserved" }] },
      checkpointIds: ["01KXDM08H2V0SZREV3NDG2R38M"],
      checkpointFacts: [{ checkpointId: "01KXDM08H2V0SZREV3NDG2R38M", backend: "git-refs" }],
    },
    turns: [
      { response: "done", commits: [{ shortHash: "abc1234", hash: "a".repeat(40), linesAdded: 3, linesRemoved: 1, evidence: { checkpointId: "01KXDM08H2V0SZREV3NDG2R38M" } }] },
      { response: "done again", commits: [] },
    ],
  });
  assert.equal(report.kind, "SessionViewerReportV1");
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.counts, {
    prompts: 2,
    responses: 5,
    intermediateSteps: 3,
    commits: 1,
    toolCalls: 3,
    fileEdits: 1,
    filesTouched: 1,
    linesAdded: 3,
    linesRemoved: 1,
  });
  assert.equal(report.session.toolTrace.totalCalls, 3);
  assert.equal("checkpoints" in report, false);
});

test("miniMarkdownToHtml renders the bounded subset and escapes HTML (AC-7)", () => {
  const html = miniMarkdownToHtml([
    "## Summary",
    "",
    "Fixed `AdvertiseRefs` with **three** helpers:",
    "",
    "| Evidence | Result |",
    "| --- | --- |",
    "| [Checkpoint](https://example.invalid/checkpoint) | explicit |",
    "- client_test.go",
    "1. step one",
    "",
    "```go",
    "func A() error { return <nil> }",
    "```",
  ].join("\n"));
  assert.match(html, /<h3>Summary<\/h3>/u);
  assert.match(html, /<code>AdvertiseRefs<\/code>/u);
  assert.match(html, /<strong>three<\/strong>/u);
  assert.match(html, /<table>/u);
  assert.match(html, /href="https:\/\/example\.invalid\/checkpoint"/u);
  assert.match(html, /<ul>\n<li>client_test\.go<\/li>\n<\/ul>/u);
  assert.match(html, /<ol>\n<li>step one<\/li>\n<\/ol>/u);
  assert.match(html, /<pre><code>func A\(\) error \{ return &lt;nil&gt; \}<\/code><\/pre>/u);
});

test("renderSessionViewerHtml emits the named viewer, timeline, commit chip, and anchors (AC-7, AC-8)", () => {
  const { turns } = buildSessionTurns([
    { type: "user", userPrompt: true, userText: "fix the linting issues", timestamp: "2026-08-02T10:00:00Z" },
    {
      type: "tool.call",
      category: "tool",
      lifecyclePhase: "request",
      toolName: "Bash",
      commandText: "gofmt -w client_test.go",
      toolInvocationId: "c1",
      timestamp: "2026-08-02T10:01:00Z",
    },
    { type: "assistant", content: "intermediate step", timestamp: "2026-08-02T10:01:30Z" },
    { type: "assistant", content: "Fixed. `gofmt -l` is clean.", timestamp: "2026-08-02T10:02:00Z" },
  ]);
  attachCommitsToTurns(turns, [
    {
      shortHash: "5da218a",
      subject: "gofmt: fix import ordering",
      authoredAt: "2026-08-02T10:03:00Z",
      sessionTrailers: ["Entire-Checkpoint-like/xyz"],
    },
  ], { graceMs: 45 * 60_000 });
  const html = renderSessionViewerHtml({
    session: {
      sessionId: "session-fixture",
      platform: "qoder",
      firstSeen: "2026-08-02T10:00:00Z",
      durationMs: 2 * 60_000,
      models: ["fixture-model"],
      files: ["client_test.go"],
      toolCallCount: 2,
      toolCounts: { Bash: 1, Read: 1 },
      toolTrace: {
        schemaVersion: 2,
        totalCalls: 2,
        shownCalls: 2,
        truncated: false,
        calls: [
          { id: "T1", step: 1, toolName: "Read", status: "observed", durationStatus: "unobserved" },
          { id: "T2", step: 2, toolName: "Bash", status: "failed", durationStatus: "observed", durationMs: 1250, timingSource: "lifecycle-pair" },
        ],
      },
      tokenUsage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0 },
    },
    turns,
    commitCount: 1,
  });
  assert.match(html, /^<!DOCTYPE html>/u);
  assert.match(html, /<title>Session Viewer · session-fixture<\/title>/u);
  assert.match(html, /<p class="viewer-name">Session Viewer<\/p>/u);
  assert.match(html, /<h1>fix the linting issues<\/h1>/u);
  assert.match(html, /2 messages, 1 tool call<\/summary>/u);
  assert.match(html, /class="chip-name">Bash<\/span>/u);
  assert.match(html, /gofmt -w client_test\.go/u);
  assert.match(html, /id="turn-1"/u);
  assert.match(html, /<code>5da218a<\/code> gofmt: fix import ordering/u);
  assert.match(html, /1\.2K tokens/u);
  assert.match(html, /aria-label="Session activity"/u);
  assert.match(html, /<strong>1<\/strong><span>Prompts<\/span>/u);
  assert.match(html, /<strong>2<\/strong><span>Tool calls<\/span>/u);
  assert.match(html, /<h2>Tool mix<\/h2>/u);
  assert.match(html, /<svg class="tool-trace-svg"/u);
  assert.match(html, /class="tool-trace-point failed"/u);
  assert.match(html, /2 calls · 1 timed/u);
  assert.doesNotMatch(html, />Checkpoints</u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("cli correlate runs end-to-end against a fixture repo (AC-1)", async (t) => {
  const root = await createFixtureRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, "correlate", "--workspace", root, "--platform", "qoder", "--commits", "5"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.commits.length, 2);
  assert.deepEqual(payload.commits[0].sessionTrailers, ["qoder/fixture-session-a"]);
});
