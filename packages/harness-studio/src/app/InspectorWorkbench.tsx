import { useEffect, useRef, useState, type ReactNode } from "react";

type InspectorLoadState = "loading" | "ready" | "fallback";

interface InspectorProvider {
  platform: string;
  sessionCount: number;
}

interface InspectorFeatureNode {
  id: string;
  title: string;
  type?: string;
  stage?: string | null;
  status?: string | null;
  evidence?: string;
  children?: string[];
}

interface InspectorFeatureTree {
  roots?: string[];
  nodes?: InspectorFeatureNode[];
}

interface InspectorStory {
  sessionLinks?: unknown[];
  commitHashes?: string[];
}

interface InspectorDay {
  date: string;
  sessionIds?: string[];
  commitHashes?: string[];
}

interface InspectorReport {
  kind: "HarnessInspectorReportV1";
  workspace?: { name?: string };
  featureTree?: InspectorFeatureTree;
  stories?: InspectorStory[];
  days?: InspectorDay[];
  providers?: InspectorProvider[];
  filters?: { platform?: string };
  sessions?: unknown[];
}

export function InspectorWorkbench(props: { fallback: ReactNode }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const [state, setState] = useState<InspectorLoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cleanupRef.current?.();
    cleanupRef.current = undefined;
    setState("loading");
    setMessage(null);

    void (async () => {
      try {
        const [reportResponse, cssResponse, scriptResponse] = await Promise.all([
          fetch("api/inspector-report"),
          fetch("assets/inspector-workbench.css"),
          fetch("assets/inspector-workbench.js"),
        ]);
        if (reportResponse.status === 204 || reportResponse.status === 404) {
          if (!cancelled) {
            setState("fallback");
            setMessage("Structured Inspector workbench data is unavailable; showing the legacy sandboxed report.");
          }
          return;
        }
        if (!reportResponse.ok) throw new Error(`Inspector report failed (${reportResponse.status}).`);
        if (!cssResponse.ok || !scriptResponse.ok) throw new Error("Inspector workbench assets are unavailable.");
        const report = await reportResponse.json() as InspectorReport;
        const [css, script] = await Promise.all([cssResponse.text(), scriptResponse.text()]);
        if (cancelled) return;
        const host = hostRef.current;
        if (host === null) throw new Error("Inspector workbench host is unavailable.");
        cleanupRef.current = mountInspectorWorkbench(host, report, css, script);
        setState("ready");
      } catch (error) {
        if (!cancelled) {
          setState("fallback");
          setMessage(error instanceof Error ? error.message : "Native Inspector workbench failed to load.");
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = undefined;
    };
  }, []);

  if (state === "fallback") {
    return <div className="inspector-fallback-shell">
      <p className="inspector-fallback-message" role="status">{message}</p>
      {props.fallback}
    </div>;
  }

  return <div className={`inspector-native-shell inspector-native-${state}`}>
    {state === "loading" && <p className="inspector-native-status" role="status">Loading native Inspector workbench…</p>}
    <div ref={hostRef} className="inspector-native-host" aria-label="Native Harness Inspector Workbench" />
  </div>;
}

function mountInspectorWorkbench(host: HTMLDivElement, report: InspectorReport, css: string, script: string): () => void {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = scopedInspectorCss(css);
  const root = document.createElement("div");
  root.className = "native-inspector-root";
  root.setAttribute("data-studio-native-inspector", "");
  root.innerHTML = inspectorWorkbenchMarkup(report);
  shadow.append(style, root);

  const runtime = createScopedRuntime(shadow, root);
  try {
    runtime.run(script);
  } catch (error) {
    runtime.dispose();
    shadow.replaceChildren();
    throw error;
  }
  return () => {
    runtime.dispose();
    shadow.replaceChildren();
  };
}

function createScopedRuntime(shadow: ShadowRoot, root: HTMLDivElement): { run(script: string): void; dispose(): void } {
  const rootListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = [];
  const windowListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = [];
  const resizeObservers: Array<{ disconnect(): void }> = [];
  const intersectionObservers: Array<{ disconnect(): void }> = [];
  const timeouts = new Set<number>();
  const frames = new Set<number>();

  const scopedDocument = {
    get body(): HTMLDivElement { return root; },
    get activeElement(): Element | null { return shadow.activeElement; },
    getElementById: (id: string): HTMLElement | null => shadow.getElementById(id),
    querySelector: <T extends Element = Element>(selector: string): T | null => shadow.querySelector<T>(selector),
    querySelectorAll: <T extends Element = Element>(selector: string): NodeListOf<T> => shadow.querySelectorAll<T>(selector),
    createElement: document.createElement.bind(document),
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
      root.addEventListener(type, listener, options);
      rootListeners.push({ type, listener, options });
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
      root.removeEventListener(type, listener, options);
    },
  };

  const addWindowEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
    globalThis.addEventListener(type, listener, options);
    windowListeners.push({ type, listener, options });
  };
  const removeWindowEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
    globalThis.removeEventListener(type, listener, options);
  };
  const scopedSetTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
    const id = window.setTimeout(handler, timeout, ...args);
    timeouts.add(id);
    return id;
  };
  const scopedClearTimeout = (id?: number): void => {
    if (id !== undefined) {
      timeouts.delete(id);
      window.clearTimeout(id);
    }
  };
  const scopedRequestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = globalThis.requestAnimationFrame(callback);
    frames.add(id);
    return id;
  };
  const scopedCancelAnimationFrame = (id: number): void => {
    frames.delete(id);
    globalThis.cancelAnimationFrame(id);
  };
  const ScopedResizeObserver = typeof globalThis.ResizeObserver === "function"
    ? function ScopedResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
      const observer = new globalThis.ResizeObserver(callback);
      resizeObservers.push(observer);
      return observer;
    }
    : undefined;
  const ScopedIntersectionObserver = typeof globalThis.IntersectionObserver === "function"
    ? function ScopedIntersectionObserver(callback: IntersectionObserverCallback, options?: IntersectionObserverInit): IntersectionObserver {
      const observer = new globalThis.IntersectionObserver(callback, options);
      intersectionObservers.push(observer);
      return observer;
    }
    : undefined;

  return {
    run(script: string): void {
      const runner = new Function(
        "document",
        "location",
        "history",
        "addEventListener",
        "removeEventListener",
        "ResizeObserver",
        "IntersectionObserver",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "setTimeout",
        "clearTimeout",
        `${script}\n//# sourceURL=/assets/inspector-workbench.js`,
      );
      runner(
        scopedDocument,
        globalThis.location,
        globalThis.history,
        addWindowEventListener,
        removeWindowEventListener,
        ScopedResizeObserver,
        ScopedIntersectionObserver,
        scopedRequestAnimationFrame,
        scopedCancelAnimationFrame,
        scopedSetTimeout,
        scopedClearTimeout,
      );
    },
    dispose(): void {
      for (const { type, listener, options } of rootListeners.splice(0)) root.removeEventListener(type, listener, options);
      for (const { type, listener, options } of windowListeners.splice(0)) globalThis.removeEventListener(type, listener, options);
      for (const id of timeouts) window.clearTimeout(id);
      timeouts.clear();
      for (const id of frames) globalThis.cancelAnimationFrame(id);
      frames.clear();
      for (const observer of resizeObservers.splice(0)) observer.disconnect();
      for (const observer of intersectionObservers.splice(0)) observer.disconnect();
    },
  };
}

function scopedInspectorCss(css: string): string {
  return css
    .replace(/:root\s*\{/u, ":host, .native-inspector-root {")
    .replace(/html,\s*body\s*\{[^}]*\}/u, ".native-inspector-root { margin:0; min-width:320px; min-height:100%; font:14px/1.45 var(--font-ui); color:var(--ink); background:var(--color-surface); }")
    .replace(/html:has\(body\.session-open\)\s*\{[^}]*\}/u, ".native-inspector-root.session-open { overflow:hidden; }");
}

function inspectorWorkbenchMarkup(report: InspectorReport): string {
  const stories = report.stories ?? [];
  const featureTree = report.featureTree ?? { nodes: [], roots: [] };
  const hasFeatureEvidence = stories.some((story) => (story.sessionLinks?.length ?? 0) > 0 || (story.commitHashes?.length ?? 0) > 0);
  const initialMode = (featureTree.nodes?.length ?? 0) > 0 && hasFeatureEvidence ? "feature" : "date";
  const workspaceName = escapeHtml(report.workspace?.name ?? "workspace");
  const sessionCount = report.sessions?.length ?? 0;
  return `<div class="app" data-harness-inspector>
  <aside class="scope-picker" aria-label="Scope picker">
    <div class="brand"><div class="brand-copy"><strong>Harness Inspector</strong><span>${workspaceName}</span></div><button class="picker-toggle" data-toggle-picker aria-expanded="true" aria-label="Collapse capability tree"><span class="collapse-label">Hide</span><span class="expand-label">Show tree</span></button></div>
    <div class="mode-tabs" role="tablist" aria-label="Picker mode"><button id="mode-feature" role="tab" aria-controls="panel-feature" aria-selected="${initialMode === "feature"}" data-mode="feature" class="${initialMode === "feature" ? "active" : ""}">Capability</button><button id="mode-date" role="tab" aria-controls="panel-date" aria-selected="${initialMode === "date"}" data-mode="date" class="${initialMode === "date" ? "active" : ""}">Date</button></div>
    <section id="panel-feature" class="picker-panel ${initialMode === "feature" ? "active" : ""}" role="tabpanel" aria-labelledby="mode-feature" data-panel="feature"><div class="picker-heading"><strong>Capability tree</strong><span>${featureTree.nodes?.length ?? 0} nodes</span></div>${featurePicker(featureTree)}</section>
    <section id="panel-date" class="picker-panel ${initialMode === "date" ? "active" : ""}" role="tabpanel" aria-labelledby="mode-date" data-panel="date">${datePicker(report.days ?? [])}</section>
  </aside>
  <main class="workspace">
    <header class="workspace-header">
      <nav class="workspace-breadcrumb" aria-label="Workbench breadcrumb"><span>Harness Inspector</span><i>/</i><strong id="workspace-scope-crumb">Delivery Workbench</strong></nav>
      <div class="workspace-header-meta">
        <label class="scope-index" hidden><span class="visually-hidden">Jump to a workbench in this scope</span><select id="scope-index" data-scope-index></select></label>
        <div class="scope-metrics" aria-label="Scope metrics">
          <span class="metric" data-metric="stories" data-metric-label="stories" data-metric-singular="story"><strong id="metric-stories">0</strong><span class="metric-label">stories</span><span class="metric-short" aria-hidden="true">story</span></span>
          <span class="metric" data-metric="sessions" data-metric-label="sessions" data-metric-singular="session"><strong id="metric-sessions">0</strong><span class="metric-label">sessions</span><span class="metric-short" aria-hidden="true">sess</span></span>
          <span class="metric" data-metric="calls" data-metric-label="calls" data-metric-singular="call"><strong id="metric-calls">0</strong><span class="metric-label">calls</span><span class="metric-short" aria-hidden="true">calls</span></span>
          <span class="metric" data-metric="commits" data-metric-label="commits" data-metric-singular="commit"><strong id="metric-commits">0</strong><span class="metric-label">commits</span><span class="metric-short" aria-hidden="true">commits</span></span>
        </div>
        <span class="window-badge">${escapeHtml(platformBadge(report))} · ${sessionCount} sessions</span>
      </div>
    </header>
    <div class="workspace-scroll">
      <section class="workbench-list" id="workbench-list" aria-live="polite"></section>
    </div>
  </main>
</div>
<section class="session-view" id="session-view" role="dialog" aria-modal="true" aria-labelledby="session-view-title" hidden>
  <header class="session-nav"><nav class="session-crumbs" aria-label="Session breadcrumb"><span>${workspaceName}</span><i>/</i><span>Sessions</span><i>/</i><strong id="session-view-title">Session</strong></nav><button class="session-close" id="session-view-close" data-close-session>Close</button></header>
  <div id="session-view-body"></div>
</section>
<script type="application/json" id="inspector-data">${safeJson(report)}</script>`;
}

function featurePicker(tree: InspectorFeatureTree): string {
  const nodes = tree.nodes ?? [];
  if (nodes.length === 0) return '<p class="picker-empty">No Feature Tree yet. Date mode still exposes observed repository activity.</p>';
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const renderNode = (node: InspectorFeatureNode): string => {
    const children = (node.children ?? []).map((id) => byId.get(id)).filter((child): child is InspectorFeatureNode => child !== undefined);
    const hasChildren = children.length > 0;
    const meta = hasChildren ? `${children.length} item${children.length === 1 ? "" : "s"}` : (node.stage ?? "capability");
    const status = node.status === "complete" ? "complete" : node.status === "todo" ? "todo" : "neutral";
    const statusLabel = status === "complete" ? "Complete" : status === "todo" ? "Todo" : "Status not declared";
    const title = escapeHtml(node.title);
    const toggle = hasChildren
      ? `<button class="tree-branch-toggle" type="button" data-tree-toggle aria-expanded="true" aria-label="Collapse ${title}"><span aria-hidden="true">⌄</span></button>`
      : '<span class="tree-branch-spacer" aria-hidden="true"></span>';
    const group = hasChildren ? `<ul class="tree-children" role="group">${children.map(renderNode).join("")}</ul>` : "";
    const evidence = node.evidence ?? "declared";
    const badge = evidence === "declared" ? "" : `<span class="evidence ${escapeHtml(evidence)}">${escapeHtml(evidence)}</span>`;
    const type = escapeHtml(node.type ?? "feature");
    return `<li class="tree-item ${type}" role="treeitem" data-tree-item data-tree-node-id="${escapeHtml(node.id)}"${hasChildren ? ' aria-expanded="true"' : ""}><div class="tree-line">${toggle}<button class="tree-row ${type}" type="button" data-feature-id="${escapeHtml(node.id)}"><span class="tree-check ${status}" role="img" aria-label="${statusLabel}"><span aria-hidden="true">${status === "complete" ? "✓" : ""}</span></span><span class="tree-copy"><strong>${title}</strong><small>${escapeHtml(meta)}</small></span>${badge}</button></div>${group}</li>`;
  };
  const roots = (tree.roots ?? []).map((id) => byId.get(id)).filter((node): node is InspectorFeatureNode => node !== undefined);
  return `<ul class="capability-tree" role="tree" aria-label="Capability tree">${roots.map(renderNode).join("")}</ul>`;
}

function datePicker(days: InspectorDay[]): string {
  if (days.length === 0) return '<p class="picker-empty">No timestamped sessions or commits in this window.</p>';
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = new Date(`${days[0]!.date}T00:00:00.000Z`);
  const last = new Date(`${days.at(-1)!.date}T00:00:00.000Z`);
  const gridStart = new Date(first);
  gridStart.setUTCDate(gridStart.getUTCDate() - ((gridStart.getUTCDay() + 6) % 7));
  const gridEnd = new Date(last);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + ((7 - gridEnd.getUTCDay()) % 7));
  const sameMonth = first.getUTCFullYear() === last.getUTCFullYear() && first.getUTCMonth() === last.getUTCMonth();
  const calendarLabel = sameMonth
    ? new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(first)
    : `${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(first)}–${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(last)}`;
  const cells: string[] = [];
  for (const cursor = new Date(gridStart); cursor <= gridEnd; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const day = byDate.get(date);
    const number = cursor.getUTCDate();
    if (day === undefined) {
      cells.push(`<span class="date-cell empty" aria-hidden="true"><time datetime="${date}">${number}</time></span>`);
      continue;
    }
    const sessions = day.sessionIds?.length ?? 0;
    const commits = day.commitHashes?.length ?? 0;
    const label = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(cursor)
      + `, ${sessions} session${sessions === 1 ? "" : "s"}, ${commits} commit${commits === 1 ? "" : "s"}`;
    cells.push(`<button class="date-cell" type="button" data-date="${date}" data-session-count="${sessions}" data-commit-count="${commits}" aria-label="${escapeHtml(label)}"><time datetime="${date}">${number}</time><span class="date-activity" aria-hidden="true"></span></button>`);
  }
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span>${day}</span>`).join("");
  return `<div class="date-calendar"><header><strong>${escapeHtml(calendarLabel)}</strong><span>UTC</span></header><div class="date-weekdays" aria-hidden="true">${weekdays}</div><div class="date-grid">${cells.join("")}</div><div class="date-selection-summary" aria-live="polite"><strong data-date-summary-label>Select a date</strong><span data-date-summary-meta></span></div></div><nav class="date-session-navigator" aria-label="Sessions on selected date"><div class="date-session-heading"><strong>Sessions</strong><span data-date-session-count>0</span></div><div class="date-session-list" data-date-session-list><p class="picker-empty">Select a date to browse its Sessions.</p></div></nav>`;
}

function platformBadge(report: InspectorReport): string {
  const contributing = (report.providers ?? []).filter((provider) => provider.sessionCount > 0);
  if (contributing.length === 0) return report.filters?.platform ?? "all";
  if (contributing.length <= 3) return contributing.map((provider) => provider.platform).join(" · ");
  return `${contributing.length} providers`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
