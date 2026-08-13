import { readFileSync } from "node:fs";

const UI_ASSET_ROOT = new URL("./ui/", import.meta.url);
const HTML_TEMPLATE = readFileSync(new URL("workbench.html", UI_ASSET_ROOT), "utf8");
const STYLES = readFileSync(new URL("workbench.css", UI_ASSET_ROOT), "utf8");
const SCRIPT = readFileSync(new URL("workbench.js", UI_ASSET_ROOT), "utf8");
const TEMPLATE_TOKEN_PATTERN = /\{\{BH_[A-Z_]+\}\}/gu;

function fillHtmlTemplate(replacements) {
  const used = new Set();
  const html = HTML_TEMPLATE.replace(TEMPLATE_TOKEN_PATTERN, (token) => {
    const tokenName = token.slice("{{BH_".length, -2);
    if (!Object.hasOwn(replacements, tokenName)) {
      throw new Error(`Harness Inspector HTML template has unresolved token ${token}`);
    }
    used.add(tokenName);
    return String(replacements[tokenName]);
  });
  for (const tokenName of Object.keys(replacements)) {
    if (!used.has(tokenName)) {
      throw new Error(`Harness Inspector HTML template is missing {{BH_${tokenName}}}`);
    }
  }
  return html;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function featurePicker(tree) {
  if (tree.nodes.length === 0) return '<p class="picker-empty">No Feature Tree yet. Date mode still exposes observed repository activity.</p>';
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const renderNode = (node) => {
    const hasChildren = node.children.length > 0;
    const meta = hasChildren
      ? `${node.children.length} item${node.children.length === 1 ? "" : "s"}`
      : (node.stage ?? "capability");
    const status = node.status === "complete" ? "complete" : node.status === "todo" ? "todo" : "neutral";
    const statusLabel = status === "complete" ? "Complete" : status === "todo" ? "Todo" : "Status not declared";
    const toggle = hasChildren
      ? `<button class="tree-branch-toggle" type="button" data-tree-toggle aria-expanded="true" aria-label="Collapse ${escapeHtml(node.title)}"><span aria-hidden="true">⌄</span></button>`
      : '<span class="tree-branch-spacer" aria-hidden="true"></span>';
    const children = node.children.map((id) => byId.get(id)).filter(Boolean);
    const group = children.length > 0
      ? `<ul class="tree-children" role="group">${children.map(renderNode).join("")}</ul>`
      : "";
    const badge = node.evidence === "declared" ? "" : `<span class="evidence ${escapeHtml(node.evidence)}">${escapeHtml(node.evidence)}</span>`;
    const selection = node.type === "story"
      ? ` data-selectable data-selection-type="story" data-story-id="${escapeHtml(node.id)}"`
      : "";
    return `<li class="tree-item ${node.type}" role="treeitem" data-tree-item data-tree-node-id="${escapeHtml(node.id)}"${hasChildren ? ' aria-expanded="true"' : ""}><div class="tree-line">${toggle}<button class="tree-row ${node.type}" type="button" data-feature-id="${escapeHtml(node.id)}"${selection}><span class="tree-check ${status}" role="img" aria-label="${statusLabel}"><span aria-hidden="true">${status === "complete" ? "✓" : ""}</span></span><span class="tree-copy"><strong>${escapeHtml(node.title)}</strong><small>${escapeHtml(meta)}</small></span>${badge}</button></div>${group}</li>`;
  };
  const roots = tree.roots.map((id) => byId.get(id)).filter(Boolean);
  return `<ul class="capability-tree" role="tree" aria-label="Delivery capability tree">${roots.map(renderNode).join("")}</ul>`;
}

function datePicker(days) {
  if (days.length === 0) return '<p class="picker-empty">No timestamped sessions or commits in this window.</p>';
  return [...days].reverse().map((day) => {
    const date = new Date(`${day.date}T00:00:00.000Z`);
    const weekday = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(date);
    return `<button class="date-cell" data-date="${day.date}"><span><small>${weekday}</small><strong>${date.getUTCDate()}</strong></span><em>${day.sessionIds.length} sessions</em><em>${day.commitHashes.length} commits</em></button>`;
  }).join("");
}

// Badge names the providers that contributed sessions; the requested filter
// text is only a fallback when no provider produced evidence.
function platformBadge(report) {
  const contributing = (report.providers ?? []).filter((provider) => provider.sessionCount > 0);
  if (contributing.length === 0) return report.filters.platform;
  if (contributing.length <= 3) return contributing.map((provider) => provider.platform).join(" · ");
  return `${contributing.length} providers`;
}

export function renderHarnessInspectorHtml(report) {
  if (report?.kind !== "HarnessInspectorReportV1") throw new Error("renderHarnessInspectorHtml requires HarnessInspectorReportV1");
  const hasFeatureEvidence = report.stories.some((story) => story.sessionLinks.length > 0 || story.commitHashes.length > 0);
  const initialMode = report.featureTree.nodes.length > 0 && hasFeatureEvidence ? "feature" : "date";
  const workspaceName = escapeHtml(report.workspace.name);
  return fillHtmlTemplate({
    PAGE_TITLE: `Harness Inspector · ${workspaceName}`,
    STYLES,
    WORKSPACE_NAME: workspaceName,
    FEATURE_TAB_CLASS: initialMode === "feature" ? "active" : "",
    FEATURE_TAB_SELECTED: initialMode === "feature" ? "true" : "false",
    DATE_TAB_CLASS: initialMode === "date" ? "active" : "",
    DATE_TAB_SELECTED: initialMode === "date" ? "true" : "false",
    FEATURE_PANEL_CLASS: initialMode === "feature" ? "active" : "",
    FEATURE_NODE_COUNT: report.featureTree.nodes.length,
    FEATURE_PICKER: featurePicker(report.featureTree),
    DATE_PANEL_CLASS: initialMode === "date" ? "active" : "",
    DAY_COUNT: report.days.length,
    DATE_PICKER: datePicker(report.days),
    PLATFORM: escapeHtml(platformBadge(report)),
    SESSION_COUNT: report.sessions.length,
    REPORT_JSON: safeJson(report),
    SCRIPT,
  });
}
