import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.join(process.cwd(), "scripts", "better-harness.mjs");

function runBetterHarness(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options,
  });
}

function listedSubcommands(output) {
  const section = output.match(/Subcommands:\n([\s\S]*?)(?:\n\nExamples:|\n\nDiscovery:|\n\nOptions:)/u)?.[1] ?? "";
  return [...section.matchAll(/^  ([a-z][a-z0-9-]+)\s{2,}/gmu)].map((match) => match[1]);
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stderr}`);
  }
}

async function writeFixtureFile(root, filePath, content) {
  const absolute = path.join(root, filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

test("better-harness CLI renders root help without terminal formatting", () => {
  const result = runBetterHarness(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout, "");
  assert.doesNotMatch(result.stdout, /\x1b\[/);
  assert.match(result.stdout, /\n  Workflows\n/u);
  assert.match(result.stdout, /\n    report\s{2,}/u);
  assert.match(result.stdout, /\n    harness\s{2,}/u);
  assert.match(result.stdout, /Quickstart/u);
});

test("better-harness CLI expands help by audience without changing command access", () => {
  const advanced = runBetterHarness(["--help", "--audience", "advanced"]);
  assert.equal(advanced.status, 0, advanced.stderr);
  assert.match(advanced.stdout, /agent-customize/);
  assert.match(advanced.stdout, /session-analysis/);
  assert.match(advanced.stdout, /plugin/);
  assert.doesNotMatch(advanced.stdout, /core-change-watch/);

  const maintainer = runBetterHarness(["--help", "--audience", "maintainer"]);
  assert.equal(maintainer.status, 0, maintainer.stderr);
  assert.match(maintainer.stdout, /core-change-watch/);
});

test("better-harness CLI exposes doctor in workflow help", () => {
  const result = runBetterHarness(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doctor/u);
});

test("delegated session-analysis and checkup help stay privacy-safe with extra options", () => {
  const privateRoot = path.join(os.tmpdir(), "harness-help-must-not-be-scanned");
  const commands = [
    [
      "session-analysis",
      "sources",
      "--platform",
      "qoder",
      "--qoder-home",
      privateRoot,
      "--workspace",
      privateRoot,
      "--help",
    ],
    [
      "session-analysis",
      "--help",
      "--platform",
      "codex",
      "--codex-home",
      privateRoot,
      "--workspace",
      privateRoot,
    ],
    [
      "harness",
      "checkup",
      "--qoder-home",
      privateRoot,
      "--workspace",
      privateRoot,
      "--help",
    ],
  ];

  for (const command of commands) {
    const result = runBetterHarness(command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.notEqual(result.stdout, "");
    assert.doesNotMatch(result.stdout, new RegExp(privateRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }

  const sessionHelp = runBetterHarness(["session-analysis", "--help"]);
  assert.equal(sessionHelp.status, 0, sessionHelp.stderr);
  assert.match(sessionHelp.stdout, /--workbuddy-home <dir>/u);
});

test("better-harness CLI prints version like a standard CLI", () => {
  const result = runBetterHarness(["--version"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^better-harness \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/);
});

test("better-harness CLI supports short version flag", () => {
  const result = runBetterHarness(["-V"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^better-harness \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/);
});

test("better-harness CLI rejects unknown capabilities without shell fallback", () => {
  const result = runBetterHarness(["missing-capability"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command: missing-capability/);
  assert.doesNotMatch(result.stderr, /Commands:/);
  assert.equal(result.stderr.endsWith("\n"), true);
  assert.equal(result.stdout, "");
});

test("retired proactive commands follow the normal unknown-command path", () => {
  const result = runBetterHarness(["proactive", "trigger", "describe"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: proactive/);
});

test("better-harness CLI rejects unknown subcommands with concise diagnostics", () => {
  const result = runBetterHarness(["core-change-watch", "missing-subcommand"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown subcommand for core-change-watch: missing-subcommand/);
  assert.doesNotMatch(result.stderr, /Subcommands:/);
  assert.equal(result.stderr.endsWith("\n"), true);
  assert.equal(result.stdout, "");
});

test("better-harness CLI exposes command inventory as JSON", () => {
  const result = runBetterHarness(["commands", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.format_version, "1.0");
  assert.equal(payload.data.name, "better-harness");
  assert.equal(payload.data.format_version, "1.0");
  assert.equal(payload.data.audience, "all");
  assert.equal(payload.data.commands.length >= 6, true);
  assert.equal(payload.data.commands.some((command) => command.name === "proactive"), false);

  const agentCustomize = payload.data.commands.find((command) => command.name === "agent-customize");
  assert.equal(agentCustomize.kind, "direct");
  assert.equal(agentCustomize.audience, "advanced");
  assert.equal(agentCustomize.hidden, false);
  assert.deepEqual(agentCustomize.aliases, [{ name: "customize", hidden: true }]);
  assert.equal(agentCustomize.script, "scripts/agent-customize/cli.mjs");

  const coreChangeWatch = payload.data.commands.find((command) => command.name === "core-change-watch");
  assert.equal(coreChangeWatch.kind, "group");
  assert.equal(coreChangeWatch.audience, "maintainer");
  assert.equal(coreChangeWatch.hidden, false);
  assert.equal(coreChangeWatch.subcommands.some((subcommand) => subcommand.name === "project-profile"), true);
  assert.equal(
    coreChangeWatch.subcommands.find((subcommand) => subcommand.name === "project-profile").script,
    "scripts/core-change-watch/project-profile.mjs",
  );

  const harness = payload.data.commands.find((command) => command.name === "harness");
  assert.equal(harness.audience, "workflow");
  assert.deepEqual(harness.aliases, []);
  assert.equal(
    harness.subcommands.find((subcommand) => subcommand.name === "preview-canvas").script,
    "scripts/harness-analysis/canvas-preview-server.mjs",
  );
  assert.equal(
    harness.subcommands.find((subcommand) => subcommand.name === "analyze").script,
    "scripts/harness-analysis/report-run.mjs",
  );
  assert.equal(harness.subcommands.find((subcommand) => subcommand.name === "analyze").audience, "workflow");
  assert.equal(harness.subcommands.find((subcommand) => subcommand.name === "evidence-bundle").audience, "workflow");
  assert.equal(
    harness.subcommands.find((subcommand) => subcommand.name === "evidence-bundle").script,
    "scripts/harness-analysis/evidence-bundle/cli.mjs",
  );
  assert.equal(harness.subcommands.find((subcommand) => subcommand.name === "workspace-topology").audience, "advanced");
  assert.equal(
    harness.subcommands.find((subcommand) => subcommand.name === "workspace-topology").script,
    "scripts/workspace-topology/cli.mjs",
  );
  assert.equal(harness.subcommands.find((subcommand) => subcommand.name === "render").audience, "advanced");
  assert.equal(harness.subcommands.find((subcommand) => subcommand.name === "source").audience, "maintainer");
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "prepare"), false);
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "finalize"), false);
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "apply-review"), false);
  assert.equal(
    harness.subcommands.find((subcommand) => subcommand.name === "task-loop-report").script,
    "scripts/harness-analysis/task-loop-report.mjs",
  );
  assert.equal(
    harness.subcommands.find((subcommand) => subcommand.name === "checkup").script,
    "scripts/coding-agent-practices/checkup.mjs",
  );

  const dependencyGovernance = payload.data.commands.find((command) => command.name === "dependency-governance");
  assert.equal(dependencyGovernance.kind, "direct");
  assert.equal(dependencyGovernance.script, "scripts/dependency-governance/cli.mjs");

  const sessionAnalysis = payload.data.commands.find((command) => command.name === "session-analysis");
  assert.equal(sessionAnalysis.audience, "advanced");
  assert.equal(sessionAnalysis.kind, "direct");
  assert.equal(sessionAnalysis.script, "scripts/session-analysis.mjs");
  assert.equal(sessionAnalysis.subcommands.some((subcommand) => subcommand.name === "file-reads"), true);
  assert.equal(sessionAnalysis.subcommands.some((subcommand) => subcommand.name === "facts"), true);
  assert.equal(sessionAnalysis.subcommands.some((subcommand) => subcommand.name === "claude-facets"), true);
  assert.equal(
    sessionAnalysis.subcommands.find((subcommand) => subcommand.name === "usage-summary").script,
    "scripts/session-analysis/usage-summary.mjs",
  );

  const plugin = payload.data.commands.find((command) => command.name === "plugin");
  assert.equal(plugin.kind, "group");
  assert.equal(plugin.audience, "advanced");
  assert.deepEqual(plugin.subcommands.map((subcommand) => subcommand.name), ["status", "plan", "verify"]);
  assert.equal(plugin.subcommands[0].script, "scripts/plugin-lifecycle/status.mjs");

  const doctor = payload.data.commands.find((command) => command.name === "doctor");
  assert.equal(doctor.kind, "direct");
  assert.equal(doctor.audience, "workflow");
  assert.equal(doctor.script, "scripts/harness-doctor/cli.mjs");
});

test("plugin help returns before reading host inventory", () => {
  const privateRoot = path.join(os.tmpdir(), "plugin-help-must-not-be-scanned");
  for (const subcommand of ["status", "plan", "verify"]) {
    const result = runBetterHarness([
      "plugin",
      subcommand,
      "--host",
      "does-not-exist",
      "--host-home",
      privateRoot,
      "--help",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`Better Harness plugin ${subcommand}`, "u"));
    assert.doesNotMatch(result.stdout, new RegExp(privateRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("plugin status emits command-contract JSON and partial exit for missing local evidence", () => {
  const result = runBetterHarness([
    "plugin",
    "status",
    "--host",
    "qwen",
    "--host-home",
    path.join(os.tmpdir(), "better-harness-empty-qwen-home"),
    "--workspace",
    process.cwd(),
    "--json",
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, "1");
  assert.equal(payload.command, "better-harness plugin status");
  assert.equal(payload.status, "partial");
  assert.equal(payload.meta.sideEffects, "read-only");
  assert.equal(payload.data.rows[0].target.hostId, "qwen");
  assert.equal(payload.data.rows[0].installation, "not-installed");
});

test("plugin plan requires an explicit host and preserves JSON mode after usage failure", () => {
  const result = runBetterHarness(["plugin", "plan", "install", "--json"]);
  assert.equal(result.status, 64);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.data, null);
  assert.equal(payload.diagnostics[0].code, "EXPLICIT_HOST_REQUIRED");
});

test("plugin plan rejects ambiguous multi-surface hosts", () => {
  for (const host of ["codex", "pi"]) {
    const result = runBetterHarness([
      "plugin",
      "plan",
      "install",
      "--host",
      host,
      "--host-home",
      path.join(os.tmpdir(), `better-harness-empty-${host}-home`),
      "--json",
    ]);
    assert.equal(result.status, 64, host);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.diagnostics[0].code, "AMBIGUOUS_HOST_SURFACE", host);
  }
});

test("plugin plan emits typed argv without executing it", () => {
  const result = runBetterHarness([
    "plugin",
    "plan",
    "--json",
    "install",
    "--host",
    "qwen",
    "--surface",
    "cli",
    "--scope",
    "project",
    "--host-home",
    path.join(os.tmpdir(), "better-harness-empty-qwen-plan-home"),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "ok");
  assert.equal(payload.data.effects, "none");
  assert.deepEqual(payload.data.steps[0].argv, [
    "qwen", "extensions", "install", "QoderAI/better-harness", "--scope", "project",
  ]);
  assert.equal(payload.data.steps[0].externalImpact, "host-plugin-state");
  assert.equal(payload.data.steps[0].preconditions.length, 2);
});

test("plugin parsers fail closed for duplicate, misplaced, and extra arguments", () => {
  const cases = [
    {
      args: ["plugin", "status", "--json", "--json"],
      code: "DUPLICATE_OPTION",
    },
    {
      args: ["plugin", "status", "--scope", "user", "--json"],
      code: "OPTION_NOT_ALLOWED",
    },
    {
      args: ["plugin", "verify", "extra", "--json"],
      code: "UNEXPECTED_POSITIONAL",
    },
    {
      args: ["plugin", "status", "--unknown", "--json"],
      code: "UNKNOWN_OPTION",
    },
    {
      args: ["plugin", "status", "--host=", "--json"],
      code: "MISSING_OPTION_VALUE",
    },
    {
      args: ["plugin", "plan", "install", "--host", "codex", "--surface", "desktop", "--scope", "project", "--json"],
      code: "UNSUPPORTED_SCOPE",
    },
  ];
  for (const entry of cases) {
    const result = runBetterHarness(entry.args);
    assert.equal(result.status, 64, `${entry.code}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.diagnostics[0].code, entry.code);
    assert.equal(payload.meta.sideEffects, "read-only");
  }
});

test("plugin plans fail closed for unbound isolated and stale native contracts", () => {
  const qoder = runBetterHarness([
    "plugin", "plan", "install",
    "--host", "qoder", "--surface", "cli", "--scope", "user",
    "--host-home", path.join(os.tmpdir(), "better-harness-empty-qoder-plan-home"),
    "--json",
  ]);
  assert.equal(qoder.status, 1, qoder.stderr);
  const qoderPayload = JSON.parse(qoder.stdout);
  assert.equal(qoderPayload.data.state, "blocked");
  assert.equal(qoderPayload.data.blockers[0].code, "ISOLATED_HOST_HOME_UNREPRESENTABLE");
  assert.deepEqual(qoderPayload.data.steps, []);

  const cursor = runBetterHarness([
    "plugin", "plan", "install",
    "--host", "cursor", "--surface", "agent", "--scope", "session",
    "--host-home", path.join(os.tmpdir(), "better-harness-empty-cursor-plan-home"),
    "--json",
  ]);
  assert.equal(cursor.status, 1, cursor.stderr);
  const cursorPayload = JSON.parse(cursor.stdout);
  assert.equal(cursorPayload.data.state, "blocked");
  assert.equal(cursorPayload.data.blockers[0].code, "HOST_CONTRACT_STALE");
  assert.deepEqual(cursorPayload.data.steps, []);
});

test("plugin apply is not registered", () => {
  const result = runBetterHarness(["plugin", "apply", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "UNKNOWN_SUBCOMMAND");
});

test("better-harness CLI filters machine inventory by audience", () => {
  const workflow = runBetterHarness(["commands", "--json", "--audience", "workflow"]);
  assert.equal(workflow.status, 0, workflow.stderr);
  const workflowPayload = JSON.parse(workflow.stdout);
  assert.equal(workflowPayload.data.audience, "workflow");
  assert.deepEqual(workflowPayload.data.commands.map((command) => command.name), ["doctor", "harness", "report"]);
  assert.deepEqual(
    workflowPayload.data.commands.find((command) => command.name === "harness").subcommands.map((entry) => entry.name),
    ["evidence-bundle", "analyze", "checkup", "record-fix-output"],
  );

  const advanced = runBetterHarness(["commands", "--json", "--audience=advanced"]);
  assert.equal(advanced.status, 0, advanced.stderr);
  const advancedCommands = JSON.parse(advanced.stdout).data.commands;
  assert.equal(advancedCommands.some((command) => command.name === "agent-customize"), true);
  assert.equal(advancedCommands.some((command) => command.name === "plugin"), true);
  assert.equal(advancedCommands.some((command) => command.name === "core-change-watch"), false);
  const harness = advancedCommands.find((command) => command.name === "harness");
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "render"), true);
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "workspace-topology"), true);
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "source"), false);
});

test("better-harness CLI rejects unsupported audiences in human and machine modes", () => {
  const human = runBetterHarness(["--help", "--audience", "expert"]);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /Unsupported audience: expert/);

  const machine = runBetterHarness(["commands", "--json", "--audience", "expert"]);
  assert.equal(machine.status, 1);
  assert.equal(machine.stderr, "");
  assert.equal(JSON.parse(machine.stdout).error.code, "UNSUPPORTED_AUDIENCE");

  const inheritedName = runBetterHarness(["commands", "--json", "--audience", "toString"]);
  assert.equal(inheritedName.status, 1);
  assert.equal(JSON.parse(inheritedName.stdout).error.code, "UNSUPPORTED_AUDIENCE");
});

test("better-harness CLI describes one command as JSON without dispatching it", () => {
  const result = runBetterHarness(["command", "describe", "core-change-watch", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.format_version, "1.0");
  assert.equal(payload.data.command.name, "core-change-watch");
  assert.equal(payload.data.command.kind, "group");
  assert.equal(payload.data.command.subcommands.some((subcommand) => subcommand.name === "diff-impact"), true);
});

test("better-harness CLI describes an exact group leaf as JSON without dispatching it", () => {
  const result = runBetterHarness(["command", "describe", "harness", "render", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.format_version, "1.0");
  assert.deepEqual(payload.data.command.path, ["harness", "render"]);
  assert.equal(payload.data.command.name, "render");
  assert.equal(payload.data.command.audience, "advanced");
  assert.equal(payload.data.command.script, "scripts/harness-analysis/render-report.mjs");
  assert.equal(payload.data.command.subcommands, undefined);
});

test("better-harness CLI describes a registered direct-command leaf", () => {
  const result = runBetterHarness(["command", "describe", "session-analysis", "facts", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const command = JSON.parse(result.stdout).data.command;
  assert.deepEqual(command.path, ["session-analysis", "facts"]);
  assert.equal(command.name, "facts");
  assert.equal(command.audience, "advanced");
  assert.equal(command.script, "scripts/session-analysis.mjs");
});

test("better-harness CLI renders the canonical leaf path in human descriptions", () => {
  const result = runBetterHarness(["command", "describe", "harness", "render"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Command: harness render$/mu);
  assert.match(result.stdout, /^Audience: advanced$/mu);
  assert.match(result.stdout, /^Summary: Render reviewed findings data into report artifacts\.$/mu);
  assert.match(result.stdout, /^Script: scripts\/harness-analysis\/render-report\.mjs$/mu);
  assert.doesNotMatch(result.stdout, /^Subcommands:$/mu);

  const sparse = runBetterHarness(["command", "describe", "core-change-watch", "project-profile"]);
  assert.equal(sparse.status, 0, sparse.stderr);
  assert.match(sparse.stdout, /^Command: core-change-watch project-profile$/mu);
  assert.match(sparse.stdout, /^Script: scripts\/core-change-watch\/project-profile\.mjs$/mu);
  assert.doesNotMatch(sparse.stdout, /undefined/u);
});

test("better-harness CLI rejects unknown describe leaves in human and JSON modes", () => {
  const human = runBetterHarness(["command", "describe", "harness", "missing"]);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /^Unknown subcommand for harness: missing$/mu);

  const machine = runBetterHarness(["command", "describe", "harness", "missing", "--json"]);
  assert.equal(machine.status, 1);
  assert.equal(machine.stderr, "");
  const payload = JSON.parse(machine.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "UNKNOWN_SUBCOMMAND");
  assert.equal(payload.error.message, "Unknown subcommand for harness: missing");
});

test("better-harness CLI rejects extra describe path segments in human and JSON modes", () => {
  const human = runBetterHarness(["command", "describe", "harness", "render", "extra"]);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /^Invalid command path: harness render extra$/mu);

  const machine = runBetterHarness(["command", "describe", "harness", "render", "extra", "--json"]);
  assert.equal(machine.status, 1);
  assert.equal(machine.stderr, "");
  const payload = JSON.parse(machine.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "INVALID_COMMAND_PATH");
  assert.equal(payload.error.message, "Invalid command path: harness render extra");

  const unknownParent = runBetterHarness(["command", "describe", "missing", "leaf", "extra", "--json"]);
  assert.equal(unknownParent.status, 1);
  assert.equal(unknownParent.stderr, "");
  assert.equal(JSON.parse(unknownParent.stdout).error.code, "INVALID_COMMAND_PATH");
});

test("better-harness CLI describes command aliases as their canonical command", () => {
  const result = runBetterHarness(["command", "describe", "customize", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.command.name, "agent-customize");
  assert.deepEqual(payload.data.command.aliases, [{ name: "customize", hidden: true }]);
});

test("better-harness CLI group help projects workflow commands", () => {
  const result = runBetterHarness(["harness", "--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const commands = listedSubcommands(result.stdout);
  assert.equal(commands.includes("evidence-bundle"), true);
  assert.equal(commands.includes("analyze"), true);
  assert.equal(commands.includes("checkup"), true);
  assert.equal(commands.includes("record-fix-output"), true);
  assert.equal(commands.includes("source"), false);
  assert.equal(commands.includes("render"), false);
});

test("better-harness CLI group help expands advanced and maintainer subcommands", () => {
  const advanced = runBetterHarness(["harness", "--help", "--audience", "advanced"]);
  assert.equal(advanced.status, 0, advanced.stderr);
  const advancedCommands = listedSubcommands(advanced.stdout);
  assert.equal(advancedCommands.includes("workspace-topology"), true);
  assert.equal(advancedCommands.includes("render"), true);
  assert.equal(advancedCommands.includes("preview-canvas"), true);
  assert.equal(advancedCommands.includes("validate-canvas"), true);
  assert.equal(advancedCommands.includes("source"), false);

  const maintainer = runBetterHarness(["harness", "--help", "--audience", "maintainer"]);
  assert.equal(maintainer.status, 0, maintainer.stderr);
  const maintainerCommands = listedSubcommands(maintainer.stdout);
  assert.equal(maintainerCommands.includes("source"), true);
  assert.equal(maintainerCommands.includes("repair-findings"), true);
});

test("better-harness CLI exposes Canvas preview help without starting a server", () => {
  const result = runBetterHarness(["harness", "preview-canvas", "--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout, "");
});

test("better-harness CLI dispatches workspace topology JSON with spaced paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness topology cli-"));
  try {
    await writeFixtureFile(root, "README.md", "# Standalone workspace\n");
    const result = runBetterHarness([
      "harness",
      "workspace-topology",
      "--workspace",
      root,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.topology.target.kind, "standalone");
    assert.equal(payload.topology.requestedWorkspace, await realpath(root));
    assert.deepEqual(payload.analysisScope, { kind: "repo", route: ".", pathspecs: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("better-harness Canvas preview resolves relative reports from the caller workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-preview-cwd-"));
  try {
    const result = runBetterHarness(["harness", "preview-canvas", "missing.canvas.tsx"], { cwd: root });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(path.join(root, "missing.canvas.tsx")), true);
    assert.equal(result.stderr.includes(path.join(process.cwd(), "missing.canvas.tsx")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("better-harness CLI emits a machine-readable schema", () => {
  const result = runBetterHarness(["schema", "--format", "opencli"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.format_version, "1.0");
  assert.equal(payload.data.schema, "opencli");
  assert.equal(payload.data.name, "better-harness");
  assert.equal(payload.data.audience, "all");
  assert.equal(payload.data.commands.some((command) => command.name === "cloc"), true);
  assert.equal(payload.data.commands.some((command) => command.name === "harness"), true);
  assert.equal(payload.data.commands.some((command) => command.name === "harness-analysis"), false);
  const harness = payload.data.commands.find((command) => command.name === "harness");
  assert.equal(harness.audience, "workflow");
  assert.equal(harness.subcommands.find((subcommand) => subcommand.name === "render").audience, "advanced");
  assert.equal(harness.subcommands.some((subcommand) => subcommand.name === "apply-review"), false);
});

test("registered harness commands remain executable through the Node facade", () => {
  for (const subcommand of ["evidence-bundle", "analyze", "selection-profile", "source", "task-loop-report", "render", "record-fix-output"]) {
    const result = runBetterHarness(["harness", subcommand, "--help"]);
    assert.equal(result.status, 0, `${subcommand}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/, subcommand);
  }

  for (const retired of ["prepare", "finalize", "apply-review"]) {
    const result = runBetterHarness(["harness", retired, "--help"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unknown subcommand for harness: ${retired}`));
  }
});

test("harness analyze rejects undocumented source injection", () => {
  const analyze = runBetterHarness([
    "harness", "analyze", "--workspace", process.cwd(), "--source-input", "hand-authored.json",
  ]);
  assert.equal(analyze.status, 1);
  assert.equal(analyze.stdout, "");
  assert.match(analyze.stderr, /unknown analyze argument: --source-input/u);
});

test("better-harness CLI schema errors default to human-readable diagnostics", () => {
  const result = runBetterHarness(["schema", "--format", "unknown"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unsupported schema format: unknown/);
});

test("better-harness CLI schema errors support JSON envelopes", () => {
  const result = runBetterHarness(["schema", "--format", "unknown", "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.format_version, "1.0");
  assert.equal(payload.error.code, "UNSUPPORTED_SCHEMA_FORMAT");
  assert.equal(payload.error.message, "Unsupported schema format: unknown");
});

test("better-harness CLI emits JSON root errors in machine mode", () => {
  const result = runBetterHarness(["missing-capability", "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.format_version, "1.0");
  assert.equal(payload.error.code, "UNKNOWN_COMMAND");
  assert.equal(payload.error.message, "Unknown command: missing-capability");
  assert.match(payload.error.hint, /better-harness commands --json/);
  assert.doesNotMatch(payload.error.hint, /Usage:/);
});

test("better-harness CLI runs through a package-bin symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-cli-bin-"));
  const linkPath = path.join(root, "better-harness");

  try {
    await symlink(cliPath, linkPath);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }

  try {
    const result = spawnSync(process.execPath, [linkPath, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /Audience: workflow/);
    assert.match(result.stdout, /better-harness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("better-harness CLI preserves delegated cloc JSON output and spaced paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness cli fixture-"));

  try {
    await writeFixtureFile(root, "src/app.mjs", "export const value = 1;\n");
    const args = [
      "--cwd",
      root,
      "--json",
      "--workers",
      "1",
      "--no-git",
    ];
    const result = runBetterHarness(["cloc", ...args]);
    const direct = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "cloc", "cli.mjs"), ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(direct.status, 0, direct.stderr);
    const report = JSON.parse(result.stdout);
    const directReport = JSON.parse(direct.stdout);
    assert.equal(report.kind, "cloc");
    assert.equal(report.totals.files, 1);
  assert.deepEqual(report.totals, directReport.totals);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloc CLI runs from a spaced symlink installation path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness cloc install-"));
  const linkedClocDir = path.join(root, "linked cloc");
  const workspace = path.join(root, "workspace with spaces");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixtureFile(workspace, "src/app.mjs", "export const value = 1;\n");
  try {
    await symlink(
      path.join(process.cwd(), "scripts", "cloc"),
      linkedClocDir,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }

  const result = spawnSync(process.execPath, [
    path.join(linkedClocDir, "cli.mjs"),
    "--cwd",
    workspace,
    "--json",
    "--workers",
    "1",
    "--no-git",
  ], {
    cwd: workspace,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), "", "cloc CLI must not silently skip direct execution");
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, "cloc");
  assert.equal(report.totals.files, 1);
});

test("better-harness CLI preserves deterministic delegated stdout byte-for-byte", () => {
  const input = `${JSON.stringify({
    verdict: "consistent",
    score: 95,
    confidence: "high",
    mismatches: [],
    strengths: ["stable"],
  })}\n`;
  const args = ["core-change-watch", "qoder-consistency-schema"];
  const directArgs = [path.join(process.cwd(), "scripts", "core-change-watch", "qoder-consistency-schema.mjs")];
  const result = runBetterHarness(args, { input });
  const direct = spawnSync(process.execPath, directArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(result.stderr, direct.stderr);
  assert.equal(result.stdout, direct.stdout);
});

test("better-harness CLI dispatches core-change-watch subcommands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-cli-core-"));

  try {
    await writeFixtureFile(root, "package.json", JSON.stringify({ name: "fixture" }, null, 2));
    await writeFixtureFile(root, "src/app.mjs", "export function app() { return true; }\n");
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    const result = runBetterHarness([
      "core-change-watch",
      "project-profile",
      "--cwd",
      root,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const profile = JSON.parse(result.stdout);
    assert.equal(profile.kind, "project-profile");
    assert.equal(profile.projectInfo.name, "fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
