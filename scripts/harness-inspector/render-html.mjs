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
    return `<li class="tree-item ${node.type}" role="treeitem" data-tree-item data-tree-node-id="${escapeHtml(node.id)}"${hasChildren ? ' aria-expanded="true"' : ""}><div class="tree-line">${toggle}<button class="tree-row ${node.type}" type="button" data-feature-id="${escapeHtml(node.id)}"><span class="tree-check ${status}" role="img" aria-label="${statusLabel}"><span aria-hidden="true">${status === "complete" ? "✓" : ""}</span></span><span class="tree-copy"><strong>${escapeHtml(node.title)}</strong><small>${escapeHtml(meta)}</small></span>${badge}</button></div>${group}</li>`;
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

const TOOL_FAMILY_COLORS = Object.freeze({
  inspect: "#4f73b6",
  change: "#7658b5",
  execute: "#64748b",
  verify: "#258675",
  coordinate: "#b27627",
  deliver: "#628b37",
  other: "#8993a2",
});

function formatToolDuration(durationMs) {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10} s`;
  return `${Math.round(durationMs / 6_000) / 10} min`;
}

function renderSwimlaneBubbleChart(activity = {}) {
  const calls = (activity.calls ?? [])
    .filter((call) => Number.isFinite(call?.step) && call.step > 0 && String(call?.family ?? "").trim())
    .slice()
    .sort((left, right) => left.step - right.step);
  if (calls.length === 0) return '<div class="swimlane-empty">No normalized tool calls to chart.</div>';

  const actionCounts = new Map();
  const firstStep = new Map();
  for (const call of calls) {
    const actionLabel = String(call.actionLabel ?? call.toolName ?? "Use tool");
    actionCounts.set(actionLabel, (actionCounts.get(actionLabel) ?? 0) + 1);
    if (!firstStep.has(actionLabel)) firstStep.set(actionLabel, call.step);
  }
  const rankedActions = [...actionCounts.keys()].sort((left, right) =>
    actionCounts.get(right) - actionCounts.get(left)
      || firstStep.get(left) - firstStep.get(right)
      || left.localeCompare(right));
  const visibleActionCount = rankedActions.length > 7 ? 6 : 7;
  const visibleActions = new Set(rankedActions.slice(0, visibleActionCount));
  const lanes = rankedActions.slice(0, visibleActionCount);
  if (rankedActions.length > visibleActionCount && !lanes.includes("Other activity")) lanes.push("Other activity");
  const laneIndex = new Map(lanes.map((actionLabel, index) => [actionLabel, index]));
  const laneFor = (call) => visibleActions.has(String(call.actionLabel ?? call.toolName)) ? String(call.actionLabel ?? call.toolName) : "Other activity";
  const totalCalls = Math.max(Number(activity.totalCalls) || 0, ...calls.map((call) => call.step), 1);
  const rowHeight = 32;
  const topPadding = 10;
  const labelWidth = Math.max(126, Math.min(190, 18 + Math.max(...lanes.map((label) => [...label].length)) * 7));
  const width = Math.max(560, Math.min(1_600, totalCalls * 9 + 150));
  const plotLeft = labelWidth + 18;
  const plotRight = width - 18;
  const plotWidth = Math.max(40, plotRight - plotLeft);
  const laneAreaHeight = topPadding + lanes.length * rowHeight + 6;
  const height = laneAreaHeight + 34;
  const observed = calls.filter((call) => call.durationStatus === "observed" && Number.isFinite(call.durationMs));
  const durations = observed.map((call) => call.durationMs);
  const minDuration = durations.length ? Math.min(...durations) : 0;
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  const xFor = (step) => plotLeft + ((Math.max(1, Math.min(totalCalls, step)) - 1) / Math.max(1, totalCalls - 1)) * plotWidth;
  const radiusFor = (call) => {
    if (call.durationStatus !== "observed" || !Number.isFinite(call.durationMs)) return 3.5;
    if (maxDuration - minDuration < 0.001) return 6.5;
    const progress = (Math.sqrt(call.durationMs) - Math.sqrt(minDuration)) / (Math.sqrt(maxDuration) - Math.sqrt(minDuration));
    return 4 + progress * 5.5;
  };

  const laneMarkup = lanes.map((actionLabel, index) => {
    const top = topPadding + index * rowHeight;
    const center = top + rowHeight / 2;
    const label = [...actionLabel].length > 24 ? `${[...actionLabel].slice(0, 23).join("")}…` : actionLabel;
    return `<g class="swimlane-lane" data-action-lane="${escapeHtml(actionLabel)}">${index % 2 ? `<rect class="swimlane-row-alt" data-swimlane-row-alt x="${labelWidth}" y="${top}" width="${width - labelWidth}" height="${rowHeight}"></rect>` : ""}<line class="swimlane-lane-line" data-swimlane-plot-end x1="${plotLeft - 9}" x2="${plotRight + 9}" y1="${center}" y2="${center}"></line><text class="swimlane-lane-label" x="${labelWidth - 12}" y="${center + 4}" text-anchor="end">${escapeHtml(label)}</text></g>`;
  }).join("");
  const tickEvery = Math.max(1, Math.ceil(totalCalls / 7));
  const ticks = [1];
  for (let tick = tickEvery; tick <= totalCalls && ticks.length < 10; tick += tickEvery) {
    if (!ticks.includes(tick)) ticks.push(tick);
  }
  if (!ticks.includes(totalCalls)) ticks.push(totalCalls);
  const grid = ticks.map((tick) => `<line class="swimlane-grid-line" data-swimlane-step="${tick}" x1="${xFor(tick)}" x2="${xFor(tick)}" y1="${topPadding}" y2="${laneAreaHeight}"></line>`).join("");
  const points = calls.map((call) => {
    const family = String(call.family);
    const actionLane = laneFor(call);
    const center = topPadding + (laneIndex.get(actionLane) ?? 0) * rowHeight + rowHeight / 2;
    const failed = call.status === "failed";
    const timed = call.durationStatus === "observed" && Number.isFinite(call.durationMs);
    const timing = timed ? `observed latency ${formatToolDuration(call.durationMs)}` : "latency unavailable";
    const fileEvidence = call.filePaths?.length ? ` · ${call.filePaths.join(" · ")}` : "";
    const actionLabel = call.actionLabel ?? call.toolName ?? "Use tool";
    const detail = call.detail ? ` · ${call.detail}` : "";
    const label = `${actionLabel} · ${call.toolName} · call ${call.step} · ${failed ? "failed" : "observed"} · ${timing}${detail}${fileEvidence}`;
    const tone = failed ? "#c34f4f" : (TOOL_FAMILY_COLORS[family] ?? TOOL_FAMILY_COLORS.other);
    return `<circle class="swimlane-bubble${failed ? " failed" : ""}${timed ? " timed" : " unobserved"}" data-swimlane-step="${call.step}" data-call-id="${escapeHtml(call.id)}" data-action="${escapeHtml(actionLabel)}" data-tool="${escapeHtml(call.toolName)}" data-status="${failed ? "failed" : "observed"}" data-duration="${escapeHtml(timed ? formatToolDuration(call.durationMs) : "timing unavailable")}" data-detail="${escapeHtml(call.detail ?? "")}" data-files="${escapeHtml((call.filePaths ?? []).join(" · "))}" data-family="${escapeHtml(family)}" cx="${xFor(call.step)}" cy="${center}" r="${radiusFor(call)}" fill="${timed || failed ? tone : "#ffffff"}" stroke="${tone}" stroke-width="${timed || failed ? 1.25 : 2}" tabindex="0" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></circle>`;
  }).join("");
  const tickLabels = ticks.map((tick) => `<text class="swimlane-tick" data-swimlane-step="${tick}" x="${xFor(tick)}" y="${laneAreaHeight + 20}" text-anchor="middle">${tick}</text>`).join("");
  const aria = `${totalCalls} normalized tool calls by action, sequence, status, and observed latency`;

  return `<section class="swimlane-chart-card" aria-label="NormalizedToolActivityV1 provider-neutral actions"><div class="swimlane-scroll" tabindex="0"><svg class="swimlane-bubble-chart" data-swimlane-responsive data-total-calls="${totalCalls}" data-min-width="${width}" data-label-width="${labelWidth}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(aria)}"><title>${escapeHtml(aria)}</title><desc>Calls are grouped by normalized action. Bubble area represents observed latency. Outlined small bubbles have no timing evidence. Red bubbles are failed calls.</desc>${laneMarkup}${grid}${points}<line class="swimlane-axis-line" data-swimlane-plot-end x1="${labelWidth}" x2="${plotRight + 9}" y1="${laneAreaHeight}" y2="${laneAreaHeight}"></line><text class="swimlane-axis-label" x="${labelWidth - 12}" y="${laneAreaHeight + 20}" text-anchor="end">Call</text>${tickLabels}</svg></div><div class="swimlane-inspector" data-swimlane-inspector aria-live="polite"><div><strong>Hover or focus a call</strong><span>Action, host tool, status, timing, redacted detail, and attributed files appear here.</span></div></div><footer class="swimlane-legend"><span>${calls.length} calls · ${observed.length} timed</span><span><i class="legend-dot sized"></i>area = latency</span><span><i class="legend-dot outline"></i>timing unavailable</span><span><i class="legend-dot failed"></i>failed</span></footer></section>`;
}

function traceTemplates(sessions) {
  return sessions.map((session) => `<template data-trace-session="${escapeHtml(session.sessionId)}">${renderSwimlaneBubbleChart(session.toolActivity)}</template>`).join("");
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
  const initialMode = report.featureTree.nodes.length > 0 ? "feature" : "date";
  const workspaceName = escapeHtml(report.workspace.name);
  return fillHtmlTemplate({
    PAGE_TITLE: `Harness Inspector · ${workspaceName}`,
    STYLES,
    WORKSPACE_NAME: workspaceName,
    FEATURE_TAB_CLASS: initialMode === "feature" ? "active" : "",
    DATE_TAB_CLASS: initialMode === "date" ? "active" : "",
    FEATURE_PANEL_CLASS: initialMode === "feature" ? "active" : "",
    FEATURE_NODE_COUNT: report.featureTree.nodes.length,
    FEATURE_PICKER: featurePicker(report.featureTree),
    DATE_PANEL_CLASS: initialMode === "date" ? "active" : "",
    DAY_COUNT: report.days.length,
    DATE_PICKER: datePicker(report.days),
    PLATFORM: escapeHtml(platformBadge(report)),
    SESSION_COUNT: report.sessions.length,
    TRACE_TEMPLATES: traceTemplates(report.sessions),
    REPORT_JSON: safeJson(report),
    SCRIPT,
  });
}
