import os from "node:os";
import path from "node:path";

import { pathExists } from "../../session-analysis/fs.mjs";
import { expandHome, normalizeWorkspace } from "../../session-analysis/paths.mjs";
import { MANAGE_TABS } from "../constants.mjs";
import {
  agentsMarkdownRuleSource,
  buildManageCollections,
  collectMarkdownItems,
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

function defaultPiHome() {
  // Pi resolves its agent dir from PI_CODING_AGENT_DIR (default ~/.pi/agent).
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function packageSourceString(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return null;
}

// Pi settings package entries are either a source string or an object form
// carrying autoload and per-resource filters. Keep the whole effective-state
// contract: autoload and filters decide what Pi actually loads.
function normalizePiPackageEntry(entry) {
  const source = packageSourceString(entry);
  if (!source) return null;
  if (typeof entry === "string") {
    return { source, autoload: true, filters: {} };
  }
  return {
    source,
    autoload: entry.autoload !== false,
    filters: {
      skills: Array.isArray(entry.skills) ? entry.skills : undefined,
      prompts: Array.isArray(entry.prompts) ? entry.prompts : undefined,
    },
  };
}

function toPosixPath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function piGlobToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "u");
}

function piItemCandidates(item, packageRoot) {
  const rel = toPosixPath(path.relative(packageRoot, item.filePath));
  const parent = path.posix.dirname(rel);
  return [rel, path.posix.basename(rel), parent, path.posix.basename(parent)].filter(Boolean);
}

function matchesPiPattern(pattern, candidates) {
  const normalized = toPosixPath(pattern);
  const regex = piGlobToRegExp(normalized);
  return candidates.some((candidate) => regex.test(candidate));
}

// Apply Pi's documented filter layering: omitted key loads all, [] loads
// none, positive patterns narrow, !pattern excludes, +path force-includes an
// exact path, and -path force-excludes an exact path.
function applyPiResourceFilter(items, packageRoot, filter) {
  if (filter === undefined) return items;
  if (filter.length === 0) return [];
  const positives = filter.filter((p) => typeof p === "string" && !/^[!+-]/u.test(p));
  const excludes = filter.filter((p) => typeof p === "string" && p.startsWith("!")).map((p) => p.slice(1));
  const forceIncludes = filter.filter((p) => typeof p === "string" && p.startsWith("+")).map((p) => toPosixPath(p.slice(1)));
  const forceExcludes = filter.filter((p) => typeof p === "string" && p.startsWith("-")).map((p) => toPosixPath(p.slice(1)));
  return items.filter((item) => {
    const candidates = piItemCandidates(item, packageRoot);
    if (forceExcludes.some((exact) => candidates.includes(exact))) return false;
    if (forceIncludes.some((exact) => candidates.includes(exact))) return true;
    if (positives.length > 0 && !positives.some((pattern) => matchesPiPattern(pattern, candidates))) return false;
    if (excludes.some((pattern) => matchesPiPattern(pattern, candidates))) return false;
    return true;
  });
}

// Manifest arrays are resource sources; plain directory entries are walked
// and `!` exclusions are honored as a filter layer. Glob source expansion
// beyond declared directories stays unexpanded (fail closed) rather than
// over-reporting resources Pi may not load.
function manifestExclusions(manifest, key) {
  const declared = Array.isArray(manifest?.[key]) ? manifest[key] : [];
  return declared.filter((entry) => typeof entry === "string" && entry.startsWith("!")).map((entry) => entry.slice(1));
}

function normalizeGitClonePath(source) {
  let value = source;
  if (value.startsWith("git:")) value = value.slice("git:".length);
  value = value.replace(/^(?:https?|ssh|git):\/\//u, "");
  value = value.replace(/^git@([^:]+):/u, "$1/");
  const at = value.lastIndexOf("@");
  if (at > value.lastIndexOf("/")) value = value.slice(0, at);
  value = value.replace(/\.git$/u, "");
  return value.split("/").filter(Boolean).join(path.sep);
}

export function resolvePiPackageRecord(source, { scopeRoot, settingsDir, scope }) {
  if (source.startsWith("npm:")) {
    let spec = source.slice("npm:".length);
    const versionAt = spec.lastIndexOf("@");
    if (versionAt > 0) spec = spec.slice(0, versionAt);
    return {
      id: `pi/${scope}/${source}`,
      name: spec,
      source,
      sourceKind: "npm",
      installPath: path.join(scopeRoot, "npm", "node_modules", ...spec.split("/")),
    };
  }
  if (source.startsWith("git:") || /^(?:https?|ssh|git):\/\//u.test(source)) {
    const clonePath = normalizeGitClonePath(source);
    return {
      id: `pi/${scope}/${source}`,
      name: path.basename(clonePath),
      source,
      sourceKind: "git",
      installPath: path.join(scopeRoot, "git", clonePath),
    };
  }
  const localPath = path.isAbsolute(expandHome(source))
    ? path.resolve(expandHome(source))
    : path.resolve(settingsDir, source);
  return {
    id: `pi/${scope}/${source}`,
    name: path.basename(localPath),
    source,
    sourceKind: "local",
    installPath: localPath,
  };
}

async function manifestResourceDirs(manifest, packageRoot, key, conventional) {
  const declared = Array.isArray(manifest?.[key]) ? manifest[key] : null;
  if (!declared) {
    return [path.join(packageRoot, conventional)];
  }
  const dirs = [];
  for (const entry of declared) {
    if (typeof entry !== "string" || entry.includes("*") || /^[!+-]/u.test(entry)) continue;
    dirs.push(path.resolve(packageRoot, entry));
  }
  return dirs;
}

async function collectPiPackagePlugin(record, scope, entryConfig = { autoload: true, filters: {} }) {
  const packageRoot = record.installPath;
  if (!(await pathExists(packageRoot))) {
    return null;
  }
  const packageJson = (await readJson(path.join(packageRoot, "package.json"))) ?? {};
  const manifest = packageJson.pi && typeof packageJson.pi === "object" ? packageJson.pi : null;
  const readme = await readText(path.join(packageRoot, "README.md"), 6000);
  const heading = readme.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const rawDisplayName = packageJson.displayName || heading || titleCase(packageJson.name || record.name);
  const displayName = normalizePluginDisplayName(rawDisplayName, record.name);
  const metadataPath = (await pathExists(path.join(packageRoot, "package.json")))
    ? path.join(packageRoot, "package.json")
    : packageRoot;
  const plugin = {
    id: record.id,
    piPackageSource: record.source,
    rootPath: packageRoot,
    scope: "plugin",
    sourceLabel: displayName,
    name: packageJson.name || record.name,
    displayName,
    description: packageJson.description || "",
    publisher: { displayName: "Pi Package" },
    version: packageJson.version,
    installSources: [scope],
    installSource: scope,
    installMatch: `pi-settings-${record.sourceKind}`,
    installType: record.sourceKind,
    enabled: entryConfig.autoload !== false,
    evidence: evidence(metadataPath, path.dirname(packageRoot)),
  };
  if (entryConfig.autoload === false) {
    // Pi does not auto-load this package's resources; publishing them as
    // enabled configured assets would overstate the effective state.
    plugin.skills = [];
    plugin.commands = [];
    plugin.rules = [];
    plugin.subagents = [];
    plugin.hooks = [];
    plugin.mcpServers = [];
    plugin.resourceState = "not-autoloaded";
    return plugin;
  }
  const skillDirs = await manifestResourceDirs(manifest, packageRoot, "skills", "skills");
  const promptDirs = await manifestResourceDirs(manifest, packageRoot, "prompts", "prompts");
  const collectedSkills = (await Promise.all(
    skillDirs.map((dir) => collectSkillFiles(dir, "plugin", displayName, packageRoot)),
  )).flat();
  const collectedPrompts = (await Promise.all(
    promptDirs.map((dir) => collectMarkdownItems(dir, "command", "plugin", displayName, packageRoot)),
  )).flat();
  const manifestSkillExclusions = manifestExclusions(manifest, "skills");
  const manifestPromptExclusions = manifestExclusions(manifest, "prompts");
  plugin.skills = applyPiResourceFilter(
    collectedSkills.filter((item) => !manifestSkillExclusions.some((pattern) => matchesPiPattern(pattern, piItemCandidates(item, packageRoot)))),
    packageRoot,
    entryConfig.filters.skills,
  ).sort(sortByName);
  plugin.commands = applyPiResourceFilter(
    collectedPrompts.filter((item) => !manifestPromptExclusions.some((pattern) => matchesPiPattern(pattern, piItemCandidates(item, packageRoot)))),
    packageRoot,
    entryConfig.filters.prompts,
  ).sort(sortByName);
  plugin.rules = [];
  plugin.subagents = [];
  plugin.hooks = [];
  plugin.mcpServers = [];
  return plugin;
}

async function collectPiExtensionPlugins(piHome) {
  const extensionsRoot = path.join(piHome, "extensions");
  const plugins = [];
  for (const extensionDir of await listDirectories(extensionsRoot)) {
    const name = path.basename(extensionDir);
    const record = {
      id: `pi/user/extensions/${name}`,
      name,
      source: extensionDir,
      sourceKind: "extension-dir",
      installPath: extensionDir,
    };
    const plugin = await collectPiPackagePlugin(record, "user");
    if (plugin) {
      plugin.installMatch = "pi-extensions-dir";
      plugin.installType = "extension-dir";
      plugins.push(plugin);
    }
  }
  return plugins;
}

async function collectPiPackagePlugins(settings, settingsPath, scopeRoot, scope) {
  const entries = Array.isArray(settings?.packages) ? settings.packages : [];
  const plugins = [];
  for (const entry of entries) {
    const entryConfig = normalizePiPackageEntry(entry);
    if (!entryConfig) continue;
    const record = resolvePiPackageRecord(entryConfig.source, {
      scopeRoot,
      settingsDir: path.dirname(settingsPath),
      scope,
    });
    const plugin = await collectPiPackagePlugin(record, scope, entryConfig);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

async function agentsSkillsDir(base) {
  return path.join(base, ".agents", "skills");
}

async function collectPiUserPrimitives(piHome, userHome) {
  const globalRules = await collectRuleSources([
    {
      type: "file",
      filePath: path.join(piHome, "AGENTS.md"),
      scope: "user",
      sourceLabel: "User",
      rootForEvidence: piHome,
      name: "AGENTS.md",
      sourceKind: "pi-global-context",
      precedence: "before-project-rules",
      useHeading: true,
    },
  ]);
  return {
    skills: [
      ...(await collectSkillFiles(path.join(piHome, "skills"), "user", "User", piHome)),
      // Pi discovers the Agent Skills standard directory from the real user
      // home even when PI_CODING_AGENT_DIR relocates the agent dir; model the
      // two roots independently instead of deriving one from the other.
      ...(await collectSkillFiles(await agentsSkillsDir(userHome), "user", "User", userHome)),
    ].sort(sortByName),
    subagents: [],
    rules: globalRules,
    commands: await collectMarkdownItems(path.join(piHome, "prompts"), "command", "user", "User", piHome),
    hooks: [],
    mcps: [],
  };
}

async function collectPiWorkspacePrimitives(workspace) {
  const sourceLabel = await workspaceSourceLabel(workspace);
  const project = await collectWorkspaceRootPrimitives(path.join(workspace, ".pi"), sourceLabel, workspace);
  // Pi prompt templates register as slash commands from .pi/prompts.
  const promptCommands = await collectMarkdownItems(
    path.join(workspace, ".pi", "prompts"), "command", "project", sourceLabel, workspace,
  );
  for (const command of promptCommands) {
    if (!project.commands.some((item) => item.filePath === command.filePath)) {
      project.commands.push(command);
    }
  }
  project.commands.sort(sortByName);
  const agentsStandardSkills = await collectSkillFiles(
    await agentsSkillsDir(workspace), "project", sourceLabel, workspace,
  );
  project.skills = [...project.skills, ...agentsStandardSkills].sort(sortByName);
  return {
    ...project,
    rules: [
      ...project.rules,
      ...(await collectRuleSources([
        agentsMarkdownRuleSource(workspace, sourceLabel),
        designMarkdownRuleSource(workspace, sourceLabel),
      ])),
    ],
  };
}

function emptyPrimitives() {
  return { skills: [], subagents: [], rules: [], commands: [], hooks: [], mcps: [] };
}

export async function collectPiCustomizeInventory(options = {}) {
  const piHome = path.resolve(expandHome(options.piHome ?? options["pi-home"] ?? defaultPiHome()));
  const userHome = path.resolve(expandHome(options.piUserHome ?? options["pi-user-home"] ?? os.homedir()));
  const workspace = normalizeWorkspace(options.workspace ?? process.cwd());
  const includeUserHome = options.includeUserHome !== false;
  const userSettingsPath = path.join(piHome, "settings.json");
  const projectSettingsPath = path.join(workspace, ".pi", "settings.json");
  const userSettings = includeUserHome ? (await readJson(userSettingsPath)) ?? {} : {};
  const projectSettings = (await readJson(projectSettingsPath)) ?? {};
  const [userPackagePlugins, extensionPlugins, projectPackagePlugins, user, project] = await Promise.all([
    includeUserHome ? collectPiPackagePlugins(userSettings, userSettingsPath, piHome, "user") : [],
    includeUserHome ? collectPiExtensionPlugins(piHome) : [],
    collectPiPackagePlugins(projectSettings, projectSettingsPath, path.join(workspace, ".pi"), "project"),
    includeUserHome ? collectPiUserPrimitives(piHome, userHome) : emptyPrimitives(),
    collectPiWorkspacePrimitives(workspace),
  ]);
  // Pi resolves the same source declared in both scopes to the project entry.
  const bySource = new Map();
  for (const plugin of [...projectPackagePlugins, ...userPackagePlugins, ...extensionPlugins]) {
    const key = plugin.piPackageSource ?? plugin.id;
    if (!bySource.has(key)) bySource.set(key, plugin);
  }
  const plugins = [...bySource.values()].sort(sortByName);
  return {
    generatedAt: new Date().toISOString(),
    provider: "pi",
    piHome,
    workspace,
    tabs: MANAGE_TABS,
    plugins,
    manage: buildManageCollections(plugins, user, project),
    diagnostics: {
      installedPluginState: plugins.length > 0 ? "pi-settings-packages" : "missing",
      installedPluginRecordCount: plugins.length,
      installedPluginRecordFiles: [
        ...(includeUserHome && Array.isArray(userSettings.packages) && userSettings.packages.length > 0
          ? [userSettingsPath]
          : []),
        ...(Array.isArray(projectSettings.packages) && projectSettings.packages.length > 0
          ? [projectSettingsPath]
          : []),
      ],
      remotePluginInstallMarkersRequired: false,
    },
    unsupported: [
      "pi manifest glob source expansion outside declared resource directories",
      "pi config per-resource enable state beyond settings package entries",
      "native MCP inventory (Pi loads MCP through extensions)",
      "extension runtime registration state",
      "theme inventory",
    ],
  };
}
