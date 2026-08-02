/**
 * Grok CLI configured-asset inventory.
 * Native home: GROK_HOME or ~/.grok. Project: <workspace>/.grok and .agents.
 */
import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";

import { expandHome, normalizeWorkspace, pathExists } from "../../session-analysis/index.mjs";
import { MANAGE_TABS } from "../constants.mjs";
import {
  agentsMarkdownRuleSource,
  buildManageCollections,
  collectHookItems,
  collectMarkdownItems,
  collectMcpItems,
  collectRuleSources,
  collectSkillFiles,
  collectWorkspaceRootPrimitives,
  designMarkdownRuleSource,
  evidence,
  listDirectories,
  normalizePluginDisplayName,
  readJson,
  readText,
  sortByName,
  titleCase,
  workspaceSourceLabel,
} from "../core/items.mjs";

export function defaultGrokHome() {
  return process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");
}

function emptyPrimitives() {
  return { skills: [], subagents: [], rules: [], commands: [], hooks: [], mcps: [] };
}

/**
 * Minimal TOML table scanner for [mcp_servers.name] / [mcp_servers."name"] blocks.
 * Does not evaluate full TOML; only extracts server identity and enabled flags.
 */
export function parseGrokMcpServersFromToml(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const servers = [];
  const lines = text.split(/\r?\n/u);
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const header = line.match(/^\[mcp_servers\.("?)([^"\]]+)\1\]$/u);
    if (header) {
      if (current) servers.push(current);
      current = {
        name: header[2],
        enabled: true,
        hasCommand: false,
        hasUrl: false,
      };
      continue;
    }
    if (!current) continue;
    if (/^\[/u.test(line)) {
      servers.push(current);
      current = null;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/u);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (key === "enabled") {
      current.enabled = !/^(false|0|no|off)$/iu.test(value);
    } else if (key === "command") {
      current.hasCommand = true;
    } else if (key === "url") {
      current.hasUrl = true;
    }
  }
  if (current) servers.push(current);
  return servers;
}

async function readTomlText(filePath) {
  try {
    return await readText(filePath, 256_000);
  } catch {
    return null;
  }
}

async function collectGrokMcpFromConfig(configPath, scope, sourceLabel, rootForEvidence) {
  const text = await readTomlText(configPath);
  if (!text) return [];
  const servers = parseGrokMcpServersFromToml(text);
  return servers.map((server) => ({
    id: `grok/${scope}/mcp/${server.name}`,
    name: server.name,
    scope,
    sourceLabel,
    enabled: server.enabled !== false,
    transport: server.hasUrl ? "http" : (server.hasCommand ? "stdio" : "unknown"),
    evidence: evidence(configPath, rootForEvidence),
    // Secrets in env= never serialized.
    unsupported: ["mcp env secret values"],
  })).sort(sortByName);
}

async function collectInstalledPlugins(pluginsRoot) {
  if (!(await pathExists(pluginsRoot))) return [];
  const plugins = [];
  for (const pluginRoot of await listDirectories(pluginsRoot)) {
    const name = path.basename(pluginRoot);
    const manifestCandidates = [
      path.join(pluginRoot, "plugin.json"),
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      path.join(pluginRoot, ".grok-plugin", "plugin.json"),
    ];
    let manifest = null;
    let manifestPath = null;
    for (const candidate of manifestCandidates) {
      manifest = await readJson(candidate);
      if (manifest) {
        manifestPath = candidate;
        break;
      }
    }
    const displayName = normalizePluginDisplayName(
      manifest?.displayName || manifest?.name || titleCase(name),
      name,
    );
    const plugin = {
      id: `grok/installed/${name}`,
      rootPath: pluginRoot,
      scope: "plugin",
      sourceLabel: displayName,
      name: manifest?.name || name,
      displayName,
      description: manifest?.description || "",
      installSources: ["installed-plugins"],
      installSource: "installed-plugins",
      installMatch: "grok-installed-plugins-dir",
      installType: "local",
      enabled: true,
      evidence: evidence(manifestPath ?? pluginRoot, path.dirname(pluginRoot)),
    };
    plugin.skills = (await collectSkillFiles(pluginRoot, "plugin", displayName, pluginRoot)).sort(sortByName);
    plugin.commands = await collectMarkdownItems(
      path.join(pluginRoot, "commands"),
      "command",
      "plugin",
      displayName,
      pluginRoot,
    );
    plugin.rules = [];
    plugin.subagents = [];
    plugin.hooks = await collectHookItems(pluginRoot, "plugin", displayName, pluginRoot);
    plugin.mcpServers = await collectMcpItems(pluginRoot, "plugin", displayName, pluginRoot);
    plugins.push(plugin);
  }
  return plugins.sort(sortByName);
}

async function collectGrokUserPrimitives(grokHome) {
  const configPath = path.join(grokHome, "config.toml");
  const [skills, bundledSkills, commands, hooks, mcps] = await Promise.all([
    collectSkillFiles(path.join(grokHome, "skills"), "user", "User", grokHome),
    collectSkillFiles(path.join(grokHome, "bundled", "skills"), "user", "User bundled", grokHome),
    collectMarkdownItems(path.join(grokHome, "commands"), "command", "user", "User", grokHome),
    collectHookItems(grokHome, "user", "User", grokHome),
    collectGrokMcpFromConfig(configPath, "user", "User", grokHome),
  ]);
  return {
    skills: [...skills, ...bundledSkills].sort(sortByName),
    subagents: [],
    rules: [],
    commands,
    hooks,
    mcps,
  };
}

async function collectGrokWorkspacePrimitives(workspace) {
  const sourceLabel = await workspaceSourceLabel(workspace);
  const projectRoot = path.join(workspace, ".grok");
  const project = await collectWorkspaceRootPrimitives(projectRoot, sourceLabel, workspace);
  const agentsSkills = await collectSkillFiles(
    path.join(workspace, ".agents", "skills"),
    "project",
    sourceLabel,
    workspace,
  );
  const projectMcps = await collectMcpItems(workspace, "project", sourceLabel, workspace);
  return {
    ...project,
    skills: [...project.skills, ...agentsSkills].sort(sortByName),
    mcps: [...project.mcps, ...projectMcps].sort(sortByName),
    rules: [
      ...project.rules,
      ...(await collectRuleSources([
        agentsMarkdownRuleSource(workspace, sourceLabel),
        designMarkdownRuleSource(workspace, sourceLabel),
      ])),
    ],
  };
}

export async function collectGrokCustomizeInventory(options = {}) {
  const grokHome = path.resolve(expandHome(
    options.grokHome ?? options["grok-home"] ?? defaultGrokHome(),
  ));
  const workspace = normalizeWorkspace(options.workspace ?? process.cwd());
  const includeUserHome = options.includeUserHome !== false;
  const [plugins, user, project] = await Promise.all([
    includeUserHome ? collectInstalledPlugins(path.join(grokHome, "installed-plugins")) : [],
    includeUserHome ? collectGrokUserPrimitives(grokHome) : emptyPrimitives(),
    collectGrokWorkspacePrimitives(workspace),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    provider: "grok",
    grokHome,
    workspace,
    tabs: MANAGE_TABS,
    plugins,
    manage: buildManageCollections(plugins, user, project),
    diagnostics: {
      installedPluginState: plugins.length > 0 ? "grok-installed-plugins-dir" : "missing",
      installedPluginRecordCount: plugins.length,
      installedPluginRecordFiles: includeUserHome && (await pathExists(path.join(grokHome, "installed-plugins")))
        ? [path.join(grokHome, "installed-plugins")]
        : [],
      remotePluginInstallMarkersRequired: false,
      configPath: path.join(grokHome, "config.toml"),
    },
    unsupported: [
      "auth.json credentials (never inventoried as values)",
      "MCP env secret values from config.toml",
      "marketplace-cache catalog entries without install",
      "runtime plugin trust state beyond enabled inventory",
    ],
  };
}
