import os from "node:os";
import path from "node:path";

import { pathExists } from "../../session-analysis/fs.mjs";
import { expandHome, normalizeWorkspace } from "../../session-analysis/paths.mjs";
import { MANAGE_TABS } from "../constants.mjs";
import {
  agentsMarkdownRuleSource,
  buildManageCollections,
  collectHookItems,
  collectMarkdownItems,
  collectMcpFromConfig,
  collectMcpItems,
  collectRuleSources,
  collectSkillFiles,
  collectWorkspaceRootPrimitives,
  designMarkdownRuleSource,
  directoryRuleSource,
  evidence,
  listDirectories,
  normalizePluginDisplayName,
  pluginMetadataEvidencePath,
  readJson,
  readText,
  sortByName,
  titleCase,
  workspaceSourceLabel,
} from "../core/items.mjs";

const QWEN_PLUGIN_MANIFEST = [".qwen-plugin", "plugin.json"];
const QWEN_EXTENSION_INSTALL_FILE = ".qwen-extension-install.json";
const QWEN_EXTENSION_ENABLEMENT_FILE = "extension-enablement.json";

function defaultQwenHome() {
  return path.join(os.homedir(), ".qwen");
}

function qwenMarkdownRuleSource(workspace, sourceLabel, precedence = "after-provider-rules") {
  return {
    type: "file",
    filePath: path.join(workspace, "QWEN.md"),
    scope: "project",
    sourceLabel,
    rootForEvidence: workspace,
    name: "QWEN.md",
    sourceKind: "qwen-md-context",
    precedence,
    useHeading: true,
  };
}

function normalizeProvidedQwenRecord(record) {
  const id = String(record?.id ?? record?.name ?? "").trim();
  const installPath = record?.installPath ?? record?.source;
  if (!id || !installPath) {
    return undefined;
  }
  return {
    id,
    name: record.name ?? id,
    marketplaceName: record.marketplaceName ?? "qwen",
    installPath: path.resolve(expandHome(installPath)),
    installMarkerPath: record.installMarkerPath,
    version: record.version,
    sources: Array.isArray(record.sources) ? record.sources : [record.source ?? "user"],
    source: record.source ?? "user",
    installMatch: record.installMatch ?? "provided",
    type: record.type ?? "link",
    enablement: record.enablement ?? null,
  };
}

async function readQwenInstalledPluginState(options = {}) {
  if (Array.isArray(options.qwenInstalledPluginRecords) || Array.isArray(options.installedPluginRecords)) {
    const records = (options.qwenInstalledPluginRecords ?? options.installedPluginRecords)
      .map(normalizeProvidedQwenRecord)
      .filter(Boolean);
    return { records, source: "provided", installRecordFiles: [] };
  }

  const qwenHome = path.resolve(expandHome(options.qwenHome ?? options["qwen-home"] ?? defaultQwenHome()));
  const extensionsRoot = path.join(qwenHome, "extensions");
  const enablementPath = path.join(extensionsRoot, QWEN_EXTENSION_ENABLEMENT_FILE);
  const enablement = (await readJson(enablementPath)) ?? {};
  const records = [];
  const installRecordFiles = [];
  for (const extensionDir of await listDirectories(extensionsRoot)) {
    const name = path.basename(extensionDir);
    const installMarkerPath = path.join(extensionDir, QWEN_EXTENSION_INSTALL_FILE);
    if (!(await pathExists(installMarkerPath))) {
      continue;
    }
    installRecordFiles.push(installMarkerPath);
    const installMarker = (await readJson(installMarkerPath)) ?? {};
    records.push({
      id: `qwen/${name}`,
      name,
      marketplaceName: "qwen",
      installPath: installMarker.source ?? extensionDir,
      installMarkerPath,
      version: installMarker.version,
      sources: ["user"],
      source: installMarker.originSource ?? "user",
      installMatch: "qwen-extension-install",
      type: installMarker.type ?? "link",
      enablement: enablement[name] ?? null,
    });
  }
  return {
    records,
    source: records.length > 0 ? "qwen-extensions" : "missing",
    installRecordFiles,
  };
}

async function collectQwenPluginMcpItems(pluginRoot, sourceLabel) {
  for (const candidate of [path.join(pluginRoot, ".mcp.json"), path.join(pluginRoot, "mcp.json")]) {
    if (await pathExists(candidate)) {
      return collectMcpFromConfig(candidate, "plugin", sourceLabel, pluginRoot);
    }
  }
  return [];
}

async function collectQwenPlugin(record) {
  const pluginRoot = path.resolve(expandHome(record.installPath));
  if (!(await pathExists(pluginRoot))) {
    return null;
  }
  const metadataEvidencePath = await pluginMetadataEvidencePath(pluginRoot, [QWEN_PLUGIN_MANIFEST, ["package.json"]]);
  const manifest = (await readJson(path.join(pluginRoot, ...QWEN_PLUGIN_MANIFEST))) ?? {};
  const packageJson = (await readJson(path.join(pluginRoot, "package.json"))) ?? {};
  const readme = await readText(path.join(pluginRoot, "README.md"), 6000);
  const heading = readme.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const rawDisplayName =
    manifest.interface?.displayName ||
    manifest.displayName ||
    packageJson.displayName ||
    heading ||
    titleCase(manifest.name || packageJson.name || record.name);
  const displayName = normalizePluginDisplayName(rawDisplayName, record.name);
  const plugin = {
    id: record.id,
    qwenExtensionId: record.name,
    marketplaceName: record.marketplaceName,
    rootPath: pluginRoot,
    scope: "plugin",
    sourceLabel: displayName,
    name: manifest.name || packageJson.name || record.name,
    displayName,
    description:
      manifest.interface?.shortDescription ||
      manifest.description ||
      packageJson.description ||
      "",
    publisher: { displayName: manifest.author?.name || manifest.interface?.developerName || titleCase(record.marketplaceName) },
    version: record.version || manifest.version || packageJson.version,
    installSources: record.sources,
    installSource: record.source,
    installMatch: record.installMatch,
    installType: record.type,
    installRecordPath: record.installMarkerPath,
    enabled: record.enablement ? record.enablement.disabled !== true : true,
    evidence: evidence(metadataEvidencePath, path.dirname(path.dirname(pluginRoot))),
  };
  plugin.skills = await collectSkillFiles(path.join(pluginRoot, "skills"), "plugin", displayName, pluginRoot);
  plugin.mcpServers = await collectQwenPluginMcpItems(pluginRoot, displayName);
  plugin.rules = await collectRuleSources([
    directoryRuleSource(path.join(pluginRoot, "rules"), "plugin", displayName, pluginRoot),
  ]);
  plugin.commands = await collectMarkdownItems(path.join(pluginRoot, "commands"), "command", "plugin", displayName, pluginRoot);
  plugin.subagents = [
    ...(await collectMarkdownItems(path.join(pluginRoot, "agents"), "subagent", "plugin", displayName, pluginRoot)),
    ...(await collectMarkdownItems(path.join(pluginRoot, "subagents"), "subagent", "plugin", displayName, pluginRoot)),
  ].sort(sortByName);
  plugin.hooks = await collectHookItems(pluginRoot, "plugin", displayName, pluginRoot);
  return plugin;
}

async function collectQwenPlugins(records) {
  const plugins = [];
  for (const record of records) {
    const plugin = await collectQwenPlugin(record);
    if (plugin) {
      plugins.push(plugin);
    }
  }
  const byId = new Map();
  for (const plugin of plugins.sort(sortByName)) {
    if (!byId.has(plugin.id)) {
      byId.set(plugin.id, plugin);
    }
  }
  return [...byId.values()].sort(sortByName);
}

async function collectQwenUserPrimitives(qwenHome) {
  const mcpPath = path.join(path.dirname(qwenHome), ".mcp.json");
  const mcps = await pathExists(mcpPath)
    ? (await collectMcpFromConfig(mcpPath, "user", "User", qwenHome)) ?? []
    : (await collectMcpItems(qwenHome, "user", "User", qwenHome)) ?? [];
  return {
    skills: await collectSkillFiles(path.join(qwenHome, "skills"), "user", "User", qwenHome),
    subagents: await collectMarkdownItems(path.join(qwenHome, "agents"), "subagent", "user", "User", qwenHome),
    rules: await collectRuleSources([directoryRuleSource(path.join(qwenHome, "rules"), "user", "User", qwenHome)]),
    commands: await collectMarkdownItems(path.join(qwenHome, "commands"), "command", "user", "User", qwenHome),
    hooks: await collectHookItems(qwenHome, "user", "User", qwenHome),
    mcps,
  };
}

async function collectQwenWorkspacePrimitives(workspace) {
  const sourceLabel = await workspaceSourceLabel(workspace);
  const project = await collectWorkspaceRootPrimitives(path.join(workspace, ".qwen"), sourceLabel, workspace);
  return {
    ...project,
    rules: [
      ...project.rules,
      ...(await collectRuleSources([
        qwenMarkdownRuleSource(workspace, sourceLabel),
        agentsMarkdownRuleSource(workspace, sourceLabel),
        designMarkdownRuleSource(workspace, sourceLabel),
      ])),
    ],
  };
}

function emptyPrimitives() {
  return { skills: [], subagents: [], rules: [], commands: [], hooks: [], mcps: [] };
}

export async function collectQwenCustomizeInventory(options = {}) {
  const qwenHome = path.resolve(expandHome(options.qwenHome ?? options["qwen-home"] ?? defaultQwenHome()));
  const workspace = normalizeWorkspace(options.workspace ?? process.cwd());
  const includeUserHome = options.includeUserHome !== false;
  const installState = includeUserHome
    ? await readQwenInstalledPluginState({ ...options, qwenHome })
    : { records: [], source: "not-authorized", installRecordFiles: [] };
  const [plugins, user, project] = await Promise.all([
    includeUserHome ? collectQwenPlugins(installState.records ?? []) : [],
    includeUserHome ? collectQwenUserPrimitives(qwenHome) : emptyPrimitives(),
    collectQwenWorkspacePrimitives(workspace),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    provider: "qwen",
    qwenHome,
    workspace,
    tabs: MANAGE_TABS,
    plugins,
    manage: buildManageCollections(plugins, user, project),
    diagnostics: {
      installedPluginState: installState.source,
      installedPluginRecordCount: plugins.length,
      installedPluginRecordFiles: installState.installRecordFiles ?? [],
      remotePluginInstallMarkersRequired: true,
    },
    unsupported: [
      "remote marketplace browse ordering",
      "remote marketplace display metadata",
      "team usage counts",
      "cloud MCP authentication state",
      "dashboard-only policy state",
    ],
  };
}
