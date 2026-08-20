import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Icon } from "@phosphor-icons/react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Binoculars } from "@phosphor-icons/react/Binoculars";
import { BugBeetle } from "@phosphor-icons/react/BugBeetle";
import { Flask } from "@phosphor-icons/react/Flask";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Package } from "@phosphor-icons/react/Package";
import { SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SquaresFour } from "@phosphor-icons/react/SquaresFour";
import { CompareView } from "./CompareView.js";
import { ExperimentView } from "./ExperimentView.js";
import { HighlightedCode } from "./HighlightedCode.js";
import { RunView } from "./RunView.js";
import type { DebuggerSession } from "./session-debugger-model.js";
import { useRovingFocus } from "./roving-tablist.js";

const StudioDiff = lazy(() => import("./StudioDiff.js"));
import {
  capabilitySummary,
  compareSurfaces,
  studioDestinations,
  type StudioArea,
  type StudioCompareSurface,
  type StudioConfig,
  type StudioDestination,
} from "./studio-shell-model.js";

const NAV_ICONS: Record<StudioArea, Icon> = {
  overview: SquaresFour,
  sessions: Binoculars,
  artifacts: Package,
  debugger: BugBeetle,
  compare: Flask,
};

const AREA_COPY: Record<StudioArea, { eyebrow: string; title: string }> = {
  overview: { eyebrow: "Control", title: "Harness Control Center" },
  sessions: { eyebrow: "Observe", title: "Sessions" },
  artifacts: { eyebrow: "Observe", title: "Artifacts" },
  debugger: { eyebrow: "Run", title: "Debugger" },
  compare: { eyebrow: "Validate", title: "Compare" },
};

type StudioSourceKind = "inspector" | "evidence" | "experiment";

interface StudioSourceOption {
  id: string;
  kind: StudioSourceKind;
  label: string;
  active: boolean;
}

const EMPTY_CONFIG: StudioConfig = {
  aguiEnabled: false,
  artifactsEnabled: false,
  evidenceEnabled: false,
  experimentEnabled: false,
  historyEnabled: false,
  inspectorEnabled: false,
  workspaceConnected: false,
  sessionCount: 0,
};

async function fetchStudioState(): Promise<{ config: StudioConfig; sources: StudioSourceOption[] }> {
  const [configResponse, sourcesResponse] = await Promise.all([
    fetch("api/config"),
    fetch("api/sources"),
  ]);
  if (!configResponse.ok) throw new Error(`Studio config failed (${configResponse.status}).`);
  const loaded = { ...EMPTY_CONFIG, ...(await configResponse.json() as Partial<StudioConfig>) };
  const sourcesPayload = sourcesResponse.ok ? await sourcesResponse.json() as { sources?: StudioSourceOption[] } : {};
  return {
    config: loaded,
    sources: Array.isArray(sourcesPayload.sources) ? sourcesPayload.sources : [],
  };
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<StudioConfig | undefined>(undefined);
  const [sources, setSources] = useState<StudioSourceOption[]>([]);
  const [dataRevision, setDataRevision] = useState(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [sessionCompareIds, setSessionCompareIds] = useState<[string, string] | undefined>();
  const [configFailure, setConfigFailure] = useState<string | null>(null);
  const [area, setArea] = useState<StudioArea>(areaFromHash);
  const [compareSurface, setCompareSurface] = useState<StudioCompareSurface>("sessions");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchStudioState();
        if (!cancelled) {
          setConfigFailure(null);
          setSources(loaded.sources);
          setConfig(loaded.config);
          setCompareSurface((currentSurface) => compareSurfaces(loaded.config).includes(currentSurface) ? currentSurface : compareSurfaces(loaded.config)[0] ?? "sessions");
        }
      } catch (error) {
        if (!cancelled) {
          setConfigFailure(error instanceof Error ? error.message : "Studio configuration is unavailable.");
          setConfig(EMPTY_CONFIG);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onHashChange = (): void => setArea(areaFromHash());
    globalThis.addEventListener("hashchange", onHashChange);
    globalThis.addEventListener("popstate", onHashChange);
    return () => {
      globalThis.removeEventListener("hashchange", onHashChange);
      globalThis.removeEventListener("popstate", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (!navigationOpen) return undefined;
    const focusFrame = globalThis.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".studio-primary-nav nav button")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setNavigationOpen(false);
      navigationToggleRef.current?.focus();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.cancelAnimationFrame(focusFrame);
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  }, [navigationOpen]);

  function openArea(next: StudioArea): void {
    setArea(next);
    setNavigationOpen(false);
    if (area !== next) globalThis.history.pushState(null, "", `#/${next}`);
  }

  async function selectSource(source: StudioSourceOption): Promise<void> {
    try {
      const response = await fetch("api/sources/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: source.kind, sourceId: source.id }),
      });
      if (!response.ok) throw new Error(`Studio source switch failed (${response.status}).`);
      const loaded = await fetchStudioState();
      setConfigFailure(null);
      setSources(loaded.sources);
      setConfig(loaded.config);
      setCompareSurface((currentSurface) => compareSurfaces(loaded.config).includes(currentSurface) ? currentSurface : compareSurfaces(loaded.config)[0] ?? "sessions");
      setDataRevision((revision) => revision + 1);
    } catch (error) {
      setConfigFailure(error instanceof Error ? error.message : "Studio source switch failed.");
    }
  }

  async function workspaceChanged(): Promise<void> {
    const loaded = await fetchStudioState();
    setConfigFailure(null);
    setSources(loaded.sources);
    setConfig(loaded.config);
    setSelectedSessionId(undefined);
    setSessionCompareIds(undefined);
    setCompareSurface((currentSurface) => compareSurfaces(loaded.config).includes(currentSurface) ? currentSurface : compareSurfaces(loaded.config)[0] ?? "sessions");
    setWorkspaceRevision((revision) => revision + 1);
  }

  if (config === undefined) {
    return <main className="studio-loading"><span className="studio-loading-mark"><GitBranch size={18} weight="bold" /></span><p>Loading Harness control plane…</p></main>;
  }
  if (configFailure !== null) {
    return <main className="studio-loading" role="alert"><span className="studio-loading-mark"><GitBranch size={18} weight="bold" /></span><strong>Cannot load Studio configuration.</strong><p>{configFailure}</p></main>;
  }

  const destinations = studioDestinations(config);
  const current = destinations.find((destination) => destination.id === area) ?? destinations[0]!;
  const compareNavigation = (
    <SurfaceNavigation
      label="Compare surfaces"
      items={compareSurfaces(config).map((id) => ({
        id,
        label: id === "sessions" ? "Sessions" : id === "bench" ? "Bench" : "Evidence results",
      }))}
      active={compareSurface}
      onSelect={setCompareSurface}
    />
  );
  const contextNavigation = area === "compare" && compareSurfaces(config).length > 1
    ? compareNavigation
    : null;

  return <div className={`studio-control-plane${navigationOpen ? " navigation-open" : ""}`}>
    <PrimaryNavigation destinations={destinations} current={area} onSelect={openArea} />
    <button className="studio-nav-backdrop" type="button" aria-label="Close Studio navigation" onClick={() => { setNavigationOpen(false); navigationToggleRef.current?.focus(); }} />
    <section className="studio-area">
      <header className={`studio-context-bar${contextNavigation ? " has-surface-navigation" : ""}`}>
        <button ref={navigationToggleRef} className="studio-nav-toggle" type="button" aria-label={navigationOpen ? "Close Studio navigation" : "Open Studio navigation"} aria-expanded={navigationOpen} onClick={() => setNavigationOpen((value) => !value)}><SidebarSimple size={17} /></button>
        <div className="studio-context-title"><small>{AREA_COPY[area].eyebrow}</small><h1>{AREA_COPY[area].title}</h1></div>
        {contextNavigation && <div className="studio-context-navigation">{contextNavigation}</div>}
        {sources.length > 0 && <SourceSwitcher sources={sources} onSelect={(source) => void selectSource(source)} />}
        <div className="studio-context-state"><span className={`availability-dot availability-${current.availability}`} /><strong>{current.status}</strong><span>Local control plane</span></div>
      </header>
      <div className={`studio-surface studio-surface-${area}`}>
        {area === "overview" && <Overview config={config} onOpen={openArea} />}
        {area === "sessions" && <SessionsWorkspace key={`sessions-${dataRevision}-${workspaceRevision}`} config={config} onWorkspaceChanged={workspaceChanged} onSelectSession={setSelectedSessionId} onCompare={(ids) => { setSessionCompareIds(ids); setCompareSurface("sessions"); openArea("compare"); }} />}
        {area === "artifacts" && <ArtifactsWorkspace key={`artifacts-${dataRevision}-${config.artifactsEnabled}-${selectedSessionId ?? "none"}`} config={config} selectedSessionId={selectedSessionId} />}
        {area === "debugger" && <DebuggerWorkspace config={config} />}
        {area === "compare" && <CompareWorkspace key={`compare-${dataRevision}-${workspaceRevision}-${config.experimentEnabled}-${config.evidenceEnabled}`} config={config} surface={compareSurface} navigation={compareNavigation} sessionIds={sessionCompareIds} />}
      </div>
    </section>
  </div>;
}

function SourceSwitcher(props: {
  sources: StudioSourceOption[];
  onSelect: (source: StudioSourceOption) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const active = props.sources.filter((source) => source.active);
  const kinds: StudioSourceKind[] = ["inspector", "evidence", "experiment"];
  return <div className="studio-source-switcher">
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><GitBranch size={14} /><span>Data sources</span><em>{active.length}</em></button>
    {open && <div className="studio-source-menu" role="menu" aria-label="Studio data sources">
      {kinds.map((kind) => {
        const entries = props.sources.filter((source) => source.kind === kind);
        if (entries.length === 0) return null;
        return <section key={kind}>
          <h2>{sourceKindLabel(kind)}</h2>
          {entries.map((source) => <button key={source.id} type="button" role="menuitemradio" aria-checked={source.active} className={source.active ? "selected" : ""} onClick={() => { setOpen(false); if (!source.active) props.onSelect(source); }}><strong>{source.label}</strong><span>{source.active ? "Active" : "Switch"}</span></button>)}
        </section>;
      })}
    </div>}
  </div>;
}

function sourceKindLabel(kind: StudioSourceKind): string {
  if (kind === "inspector") return "Inspector";
  if (kind === "evidence") return "Evidence results";
  return "Experiment bench";
}

function PrimaryNavigation(props: {
  destinations: readonly StudioDestination[];
  current: StudioArea;
  onSelect: (area: StudioArea) => void;
}): React.JSX.Element {
  const groups = [...new Set(props.destinations.map((destination) => destination.group))];
  const buttonRefs = useRef(new Map<StudioArea, HTMLButtonElement>());

  function onNavigationKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const destinations = props.destinations.map((destination) => destination.id);
    const focused = [...buttonRefs.current.entries()].find(([, button]) => button === document.activeElement)?.[0];
    const currentIndex = Math.max(0, destinations.indexOf(focused ?? props.current));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? destinations.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % destinations.length
          : (currentIndex - 1 + destinations.length) % destinations.length;
    buttonRefs.current.get(destinations[nextIndex]!)?.focus();
  }

  return <aside className="studio-primary-nav" aria-label="Studio navigation">
    <header className="studio-product-brand"><span><GitBranch size={18} weight="bold" /></span><div><strong>Better Harness</strong><small>Studio</small></div></header>
    <nav aria-label="Harness control plane" onKeyDown={onNavigationKeyDown}>
      {groups.map((group) => <section className="studio-nav-group" key={group}><h2>{group}</h2>{props.destinations.filter((destination) => destination.group === group).map((destination) => {
        const NavIcon = NAV_ICONS[destination.id];
        return <button key={destination.id} ref={(node) => { if (node) buttonRefs.current.set(destination.id, node); else buttonRefs.current.delete(destination.id); }} type="button" tabIndex={props.current === destination.id ? 0 : -1} aria-current={props.current === destination.id ? "page" : undefined} onClick={() => props.onSelect(destination.id)}>
          <NavIcon size={16} weight={props.current === destination.id ? "fill" : "regular"} />
          <span><strong>{destination.label}</strong><small>{destination.status}</small></span>
          <i className={`availability-dot availability-${destination.availability}`} aria-label={destination.availability} />
        </button>;
      })}</section>)}
    </nav>
    <footer><strong>Observe → Promote</strong><span>Evidence before defaults</span></footer>
  </aside>;
}

function Overview(props: { config: StudioConfig; onOpen: (area: StudioArea) => void }): React.JSX.Element {
  const summary = capabilitySummary(props.config);
  const nextArea: StudioArea = props.config.workspaceConnected
    ? "sessions"
    : props.config.aguiEnabled
      ? "debugger"
      : props.config.experimentEnabled || props.config.evidenceEnabled
        ? "compare"
        : "sessions";
  const inputs = [
    ["Project workspace", props.config.workspaceConnected],
    ["Artifact catalog", props.config.artifactsEnabled],
    ["Inspector report", props.config.inspectorEnabled],
    ["Harness runtime", props.config.aguiEnabled],
    ["Experiment manifest", props.config.experimentEnabled],
    ["Compare evidence", props.config.evidenceEnabled],
    ["History adapter", props.config.historyEnabled],
  ] as const;
  const missingInputs = inputs.filter(([, enabled]) => !enabled);
  const actions = [
    { label: props.config.workspaceConnected ? "Open Sessions" : "Open workspace", area: "sessions" as const, enabled: true, detail: props.config.workspaceConnected ? `${props.config.sessionCount} retained` : "Choose in Web" },
    { label: "Go to Debugger", area: "debugger" as const, enabled: props.config.aguiEnabled, detail: "Live runs" },
    { label: "Go to Compare", area: "compare" as const, enabled: props.config.sessionCount >= 2 || props.config.experimentEnabled || props.config.evidenceEnabled, detail: "Sessions and evidence" },
  ];
  return <main className="control-overview">
    <section className="control-hero">
      <div><small>Local Web workspace</small><h1>{props.config.workspaceConnected ? "Open the discovered Sessions." : "Choose a project workspace in Studio."}</h1><p>{summary.ready} ready · {summary.partial} partial · {summary.foundation} foundations. Studio discovers workspace-matching agent Sessions through the same provider code as Inspector.</p><button type="button" onClick={() => props.onOpen(nextArea)}>{props.config.workspaceConnected ? "Open Sessions" : "Open workspace"}<ArrowRight size={15} weight="bold" /></button></div>
      <aside className="control-actions" aria-label="Available actions"><small>Available actions</small><ul>{actions.map((action) => <li key={action.label} className={action.enabled ? "is-ready" : "is-foundation"}><span className={`availability-dot availability-${action.enabled ? "ready" : "foundation"}`} /><button type="button" disabled={!action.enabled} onClick={() => props.onOpen(action.area)}>{action.label}</button><em>{action.detail}</em></li>)}</ul></aside>
    </section>

    <div className="control-grid">
      <section className="control-panel"><header><div><small>Loaded inputs</small><h2>Current boundary</h2></div><span>Server facts</span></header><ul className="input-readiness">{inputs.map(([label, enabled]) => <li key={label}><span className={`availability-dot ${enabled ? "availability-ready" : "availability-foundation"}`} /><strong>{label}</strong><em>{enabled ? "Connected" : "Not supplied"}</em></li>)}</ul></section>
      <section className="control-panel"><header><div><small>Next action</small><h2>Missing inputs stay explicit</h2></div><span>No inferred state</span></header><ul className="input-readiness">{missingInputs.length > 0 ? missingInputs.map(([label]) => <li key={label}><span className="availability-dot availability-foundation" /><strong>{label}</strong><em>Load when needed</em></li>) : <li><span className="availability-dot availability-ready" /><strong>All configured inputs connected</strong><em>Ready</em></li>}</ul></section>
    </div>
  </main>;
}

interface SessionSummary {
  id: string;
  savedAt: string;
  prompt: string;
  status: "finished" | "error" | "observed";
  toolCallCount: number;
  provider?: string;
}

function SessionsWorkspace(props: {
  config: StudioConfig;
  onWorkspaceChanged: () => Promise<void>;
  onSelectSession: (id: string) => void;
  onCompare: (ids: [string, string]) => void;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [workspaceLabel, setWorkspaceLabel] = useState("Project workspace");
  const [omittedCount, setOmittedCount] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DebuggerSession>();
  const [failure, setFailure] = useState<string>();
  const [detailFailure, setDetailFailure] = useState<string>();

  useEffect(() => {
    if (!props.config.workspaceConnected) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/sessions");
        if (!response.ok) throw new Error(await studioApiError(response));
        const payload = await response.json() as { workspace: { label: string; omittedCount: number }; sessions: SessionSummary[] };
        if (cancelled) return;
        setWorkspaceLabel(payload.workspace.label);
        setOmittedCount(payload.workspace.omittedCount);
        setSessions(payload.sessions);
        if (payload.sessions[0] !== undefined) await openSession(payload.sessions[0].id, () => cancelled);
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [props.config.workspaceConnected]);

  async function openSession(id: string, cancelled: () => boolean = () => false): Promise<void> {
    try {
      const response = await fetch(`api/sessions/${encodeURIComponent(id)}/debugger`);
      if (!response.ok) throw new Error(await studioApiError(response));
      const loaded = await response.json() as DebuggerSession;
      if (cancelled()) return;
      setDetailFailure(undefined);
      setSelected(id);
      setDetail(loaded);
      props.onSelectSession(id);
    } catch (error) {
      if (cancelled()) return;
      const message = error instanceof Error ? error.message : "Session detail failed to load.";
      setDetailFailure(message);
    }
  }

  function toggleCompare(id: string): void {
    setCompareIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 2) next.add(id);
      return next;
    });
  }

  async function disconnect(): Promise<void> {
    const response = await fetch("api/workspace", { method: "DELETE" });
    if (!response.ok) {
      setFailure(await studioApiError(response));
      return;
    }
    await props.onWorkspaceChanged();
  }

  if (!props.config.workspaceConnected) {
    return <WorkspaceIntake onWorkspaceChanged={props.onWorkspaceChanged} />;
  }
  if (failure !== undefined) {
    return <WorkspaceIntake title="Choose another project workspace" detail={failure} onWorkspaceChanged={props.onWorkspaceChanged} />;
  }
  if (sessions === undefined) return <p className="artifact-status" role="status">Indexing sessions…</p>;

  const pair = [...compareIds];
  return <section className="session-browser-workspace" aria-label="Project workspace sessions">
    <aside className="session-catalog-pane">
      <header><div><small>Local workspace</small><h2 title={workspaceLabel}>{workspaceLabel}</h2></div><span>{sessions.length}</span></header>
      {omittedCount > 0 && <p className="session-omissions">{omittedCount} unsupported or malformed file{omittedCount === 1 ? "" : "s"} omitted.</p>}
      <ul className="session-catalog-rows">{sessions.map((session) => <li key={session.id}>
        <label title="Select for comparison"><input type="checkbox" checked={compareIds.has(session.id)} disabled={!compareIds.has(session.id) && compareIds.size >= 2} onChange={() => toggleCompare(session.id)} /></label>
        <button type="button" className={selected === session.id ? "selected" : undefined} onClick={() => void openSession(session.id)}><small>{session.provider ?? "Local agent"} · {formatSessionTime(session.savedAt)}</small><strong>{session.prompt}</strong><small>{session.status} · {session.toolCallCount} calls</small></button>
      </li>)}</ul>
      <footer><button type="button" className="primary" disabled={pair.length !== 2} onClick={() => props.onCompare(pair as [string, string])}>Compare {pair.length}/2</button><WorkspaceFolderControls compact onWorkspaceChanged={props.onWorkspaceChanged} /><button type="button" onClick={() => void disconnect()}>Disconnect</button></footer>
    </aside>
    <main className="session-detail-pane">
      {detailFailure !== undefined
        ? <p className="artifact-status" role="alert">{detailFailure}</p>
        : detail === undefined
          ? <p className="artifact-status">Select a session to inspect retained evidence.</p>
          : <SessionDetail session={detail} />}
    </main>
  </section>;
}

function SessionDetail({ session }: { session: DebuggerSession }): React.JSX.Element {
  const toolCalls = session.events.reduce((count, event) => count + (event.toolCalls?.length ?? 0), 0);
  return <section className="session-detail" aria-label={`Session detail: ${session.name}`}>
    <header><div><small>Retained Session</small><h1>{session.name}</h1></div><span className={`run-badge status-${session.connection}`}>{session.connection}</span></header>
    <dl><div><dt>Agent</dt><dd>{session.agent}</dd></div><div><dt>Protocol</dt><dd>{session.protocol}</dd></div><div><dt>Events</dt><dd>{session.events.length}</dd></div><div><dt>Tool calls</dt><dd>{toolCalls}</dd></div></dl>
    <ol className="session-event-rows">{session.events.map((event) => <li key={event.id}><time>{event.timestamp}</time><span><strong>{event.phase} · {event.title}</strong><small>{event.summary}</small></span>{event.toolCalls && <em>{event.toolCalls.map((tool) => tool.name).join(", ")}</em>}</li>)}</ol>
  </section>;
}

function WorkspaceIntake(props: { title?: string; detail?: string; onWorkspaceChanged: () => Promise<void> }): React.JSX.Element {
  return <main className="workspace-intake empty-workspace"><span><FolderOpen size={22} /></span><small>Local Web workspace</small><h1>{props.title ?? "Open a project workspace"}</h1><p>{props.detail ?? "Choose the repository or project directory you worked in. Studio uses Inspector's provider discovery to find matching Sessions in local agent evidence stores."}</p><WorkspaceFolderControls onWorkspaceChanged={props.onWorkspaceChanged} /></main>;
}

function WorkspaceFolderControls(props: { compact?: boolean; onWorkspaceChanged: () => Promise<void> }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"idle" | "choosing" | "discovering" | "opening">("idle");
  const [failure, setFailure] = useState<string>();

  async function openWorkspace(): Promise<void> {
    setBusy(true);
    setFailure(undefined);
    setStage("choosing");
    let monitoring = true;
    const monitor = (async () => {
      while (monitoring) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        if (!monitoring) return;
        try {
          const response = await fetch("api/workspace/open/status");
          if (!response.ok) continue;
          const result = await response.json() as { stage?: "idle" | "choosing" | "discovering" };
          if (result.stage === "choosing" || result.stage === "discovering") setStage(result.stage);
        } catch {
          // The open request remains the authoritative error channel.
        }
      }
    })();
    try {
      const opened = await fetch("api/workspace/open", { method: "POST" });
      if (!opened.ok) throw new Error(await studioApiError(opened));
      const result = await opened.json() as { opened?: boolean; cancelled?: boolean };
      if (result.cancelled || result.opened !== true) {
        return;
      }
      setStage("opening");
      await props.onWorkspaceChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Workspace discovery failed.");
    } finally {
      monitoring = false;
      await monitor;
      setStage("idle");
      setBusy(false);
    }
  }

  const progressMessage = stage === "discovering"
    ? "Finding matching Sessions across local providers…"
    : stage === "opening"
      ? "Opening the discovered Session list…"
      : "Waiting for a project folder selection…";

  return <div className={`workspace-folder-controls${props.compact ? " is-compact" : ""}`}>
    <button className={props.compact ? undefined : "primary"} type="button" disabled={busy} onClick={() => void openWorkspace()}><FolderOpen size={14} />{busy ? "Opening…" : props.compact ? "Change workspace" : "Choose workspace"}</button>
    {busy && <span className="workspace-open-progress" role="status" aria-live="polite"><i aria-hidden="true" /><small>{progressMessage}</small></span>}
    {failure !== undefined && <small className="workspace-folder-error" role="alert">{failure}</small>}
  </div>;
}

async function studioApiError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: string };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // Preserve the status fallback when a proxy returns a non-JSON body.
  }
  return `Studio request failed (${response.status}).`;
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

interface ArtifactDescriptor {
  id: string;
  kind: string;
  label: string;
  size: number;
  renderer: "canvas" | "code" | "diff" | "image" | "json" | "svg" | "text" | "unavailable";
  viewerId?: string;
  viewerLabel?: string;
  reason?: string;
}

/**
 * Artifacts pane: a row list of run outputs plus a sandboxed preview.
 *
 * The preview frame withholds `allow-same-origin`, so artifact code runs on an
 * opaque origin and cannot reach the Studio shell.
 */
function ArtifactsWorkspace(props: { config: StudioConfig; selectedSessionId?: string }): React.JSX.Element {
  const [artifacts, setArtifacts] = useState<ArtifactDescriptor[] | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!props.config.artifactsEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/artifacts");
        if (!response.ok) throw new Error(`Artifact catalog failed (${response.status}).`);
        const payload = await response.json() as { artifacts?: ArtifactDescriptor[] };
        if (cancelled) return;
        const entries = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        setFailure(undefined);
        setArtifacts(entries);
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [props.config.artifactsEnabled]);

  if (!props.config.artifactsEnabled) {
    return props.config.workspaceConnected
      ? <EmptyWorkspace eyebrow="Session artifacts" title={props.selectedSessionId === undefined ? "Select a Session first" : "No artifacts indexed for this Session"} detail={props.selectedSessionId === undefined ? "Open Sessions and select retained evidence before viewing its outputs." : "The current Session adapter did not expose an artifact set. Studio does not substitute a loose global folder."} />
      : <EmptyWorkspace eyebrow="Session artifacts" title="Open a project workspace" detail="Artifacts belong to a discovered Session. Choose the project directory in Sessions before opening its outputs." />;
  }
  if (failure !== undefined) {
    return <EmptyWorkspace eyebrow="Session artifacts" title="Cannot read the compatibility artifact catalog" detail={failure} />;
  }
  if (artifacts === undefined) {
    return <p className="artifact-status" role="status">Loading artifacts…</p>;
  }
  if (artifacts.length === 0) {
    return <EmptyWorkspace eyebrow="Session artifacts" title="No artifacts in this set" detail="The compatibility catalog contains no renderable files." />;
  }

  const active = artifacts.find((entry) => entry.id === selected);
  return <section className="artifact-workspace" aria-label="Artifacts workspace">
    <div className="artifact-list-pane">
      <header><div><small>Compatibility preload</small><h2>Artifacts</h2></div><span>{artifacts.length}</span></header>
      <ul className="artifact-rows">
        {artifacts.map((entry) => <li key={entry.id}>
          <button
            type="button"
            className={entry.id === selected ? "selected" : undefined}
            aria-current={entry.id === selected}
            onClick={() => setSelected(entry.id)}
          >
            <span className="artifact-row-copy"><strong>{entry.label}</strong><small>{entry.kind} · {formatBytes(entry.size)}</small></span>
          </button>
        </li>)}
      </ul>
    </div>
    <div className="artifact-preview-pane">
      {active === undefined
        ? <p className="artifact-status" role="status">Select an artifact to preview it.</p>
        : <ArtifactPreview artifact={active} />}
    </div>
  </section>;
}

function ArtifactPreview({ artifact }: { artifact: ArtifactDescriptor }): React.JSX.Element {
  const contentUrl = `api/artifacts/${artifact.id}/content`;
  if (artifact.renderer === "canvas") {
    return <iframe key={artifact.id} className="artifact-frame" title={`Artifact preview: ${artifact.label}`} src={`api/artifacts/${artifact.id}/viewer/`} sandbox="allow-scripts" referrerPolicy="no-referrer" />;
  }
  if (artifact.renderer === "svg") {
    return <iframe key={artifact.id} className="artifact-frame" title={`SVG preview: ${artifact.label}`} src={contentUrl} sandbox="" referrerPolicy="no-referrer" />;
  }
  if (artifact.renderer === "image") {
    return <div className="artifact-image-stage"><img src={contentUrl} alt={artifact.label} /></div>;
  }
  if (["code", "diff", "json", "text"].includes(artifact.renderer)) {
    return <ArtifactTextPreview artifact={artifact} url={contentUrl} />;
  }
  return <p className="artifact-status" role="status">{artifact.reason ?? "No renderer is available for this artifact."}</p>;
}

function ArtifactTextPreview({ artifact, url }: { artifact: ArtifactDescriptor; url: string }): React.JSX.Element {
  const [content, setContent] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact content failed (${response.status}).`);
      setContent(await response.text());
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [url]);
  if (failure !== undefined) return <p className="artifact-status" role="alert">{failure}</p>;
  if (content === undefined) return <p className="artifact-status" role="status">Loading preview…</p>;
  if (artifact.renderer === "diff") {
    return <Suspense fallback={<pre className="studio-diff-fallback">{content}</pre>}><StudioDiff patch={content} /></Suspense>;
  }
  return <div className="artifact-code-preview"><HighlightedCode code={content} sourceHint={artifact.label} label={`Artifact source: ${artifact.label}`} /></div>;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function DebuggerWorkspace(props: { config: StudioConfig }): React.JSX.Element {
  if (!props.config.aguiEnabled) {
    return <EmptyWorkspace eyebrow="Live runs" title="Load a harness for live runs" detail="The Debugger drives a live harness run over the embedded AG-UI endpoint and saves finished runs for replay." command="--harness ./my-agent.harness" />;
  }
  return <div className="debugger-mode"><RunView aguiEndpoint="agui" artifactEndpoint={props.config.artifactsEnabled ? "api/artifacts" : undefined} /></div>;
}

function CompareWorkspace(props: {
  config: StudioConfig;
  surface: StudioCompareSurface;
  navigation: ReactNode;
  sessionIds?: [string, string];
}): React.JSX.Element {
  const available = compareSurfaces(props.config);
  if (available.length === 0) {
    return <EmptyWorkspace eyebrow="Session comparison" title={props.config.workspaceConnected ? "Choose a workspace with at least two Sessions" : "Open a project workspace"} detail={props.config.workspaceConnected ? "The current workspace needs two discovered Sessions before observational comparison is available." : "Choose the project directory in Sessions. Studio discovers its matching local agent Sessions without startup parameters."} />;
  }
  if (props.surface === "sessions" && props.config.sessionCount >= 2) {
    return <SessionCompareView navigation={props.navigation} initialIds={props.sessionIds} />;
  }
  if (props.surface === "bench" && props.config.experimentEnabled) {
    return <main className="experiment-mode"><ExperimentView navigation={props.navigation} /></main>;
  }
  if (props.surface === "results" && props.config.evidenceEnabled) {
    return <main className="evidence-results"><header><div><small>Frozen comparison</small><h1>Evidence results</h1></div>{props.navigation}</header><CompareView /></main>;
  }
  const fallback = available[0]!;
  return <EmptyWorkspace eyebrow="Surface unavailable" title="Choose a configured compare surface" detail={`The requested surface is not connected. Available now: ${fallback}.`} />;
}

interface SessionComparisonSide {
  id: string;
  prompt: string;
  savedAt: string;
  status: "finished" | "error" | "observed";
  retainedEventCount: number;
  toolCallCount: number;
  messageCount: number;
  warningCount: number;
  toolSequence: string[];
}

interface SessionComparison {
  kind: "observational-session-compare.v1";
  boundary: string;
  left: SessionComparisonSide;
  right: SessionComparisonSide;
}

function SessionCompareView(props: { navigation: ReactNode; initialIds?: [string, string] }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [leftId, setLeftId] = useState(props.initialIds?.[0] ?? "");
  const [rightId, setRightId] = useState(props.initialIds?.[1] ?? "");
  const [comparison, setComparison] = useState<SessionComparison>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/sessions");
        if (!response.ok) throw new Error(await studioApiError(response));
        const loaded = await response.json() as { sessions: SessionSummary[] };
        if (cancelled) return;
        setSessions(loaded.sessions);
        setLeftId((current) => current || loaded.sessions[0]?.id || "");
        setRightId((current) => current || loaded.sessions[1]?.id || "");
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (leftId === "" || rightId === "" || leftId === rightId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`api/session-compare?${new URLSearchParams({ left: leftId, right: rightId })}`, { signal: controller.signal });
        if (!response.ok) throw new Error(await studioApiError(response));
        setFailure(undefined);
        setComparison(await response.json() as SessionComparison);
      } catch (error) {
        if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => controller.abort();
  }, [leftId, rightId]);

  return <main className="session-compare-workspace">
    <header><div><small>Observed retained evidence</small><h1>Compare Sessions</h1></div>{props.navigation}</header>
    <div className="session-compare-picker"><label><span>Left Session</span><select value={leftId} onChange={(event) => setLeftId(event.target.value)}>{sessions.map((session) => <option key={session.id} value={session.id} disabled={session.id === rightId}>{session.prompt}</option>)}</select></label><label><span>Right Session</span><select value={rightId} onChange={(event) => setRightId(event.target.value)}>{sessions.map((session) => <option key={session.id} value={session.id} disabled={session.id === leftId}>{session.prompt}</option>)}</select></label></div>
    {failure !== undefined && <p className="session-compare-boundary status-danger" role="alert">{failure}</p>}
    {comparison === undefined ? <p className="artifact-status" role="status">Loading Session comparison…</p> : <>
      <p className="session-compare-boundary"><strong>No winner inferred.</strong> {comparison.boundary}</p>
      <div className="session-compare-heads"><article><small>Left</small><h2>{comparison.left.prompt}</h2><span className={`run-badge status-${comparison.left.status}`}>{comparison.left.status}</span></article><article><small>Right</small><h2>{comparison.right.prompt}</h2><span className={`run-badge status-${comparison.right.status}`}>{comparison.right.status}</span></article></div>
      <div className="session-compare-table" role="table" aria-label="Observed Session differences">
        {(["retainedEventCount", "toolCallCount", "messageCount", "warningCount"] as const).map((metric) => <div role="row" key={metric}><strong role="rowheader">{sessionMetricLabel(metric)}</strong><span role="cell">{comparison.left[metric]}</span><span role="cell">{comparison.right[metric]}</span></div>)}
      </div>
      <div className="session-tool-sequences"><section><header>Left tool sequence</header><ol>{comparison.left.toolSequence.map((tool, index) => <li key={`${tool}-${index}`}>{tool}</li>)}</ol></section><section><header>Right tool sequence</header><ol>{comparison.right.toolSequence.map((tool, index) => <li key={`${tool}-${index}`}>{tool}</li>)}</ol></section></div>
    </>}
  </main>;
}

function sessionMetricLabel(metric: "retainedEventCount" | "toolCallCount" | "messageCount" | "warningCount"): string {
  return ({ retainedEventCount: "Retained events", toolCallCount: "Tool calls", messageCount: "Messages", warningCount: "Warnings" })[metric];
}

function EmptyWorkspace(props: { eyebrow: string; title: string; detail: string; command?: string }): React.JSX.Element {
  return <main className="empty-workspace"><span><GitBranch size={22} /></span><small>{props.eyebrow}</small><h1>{props.title}</h1><p>{props.detail}</p>{props.command && <code>{props.command}</code>}</main>;
}

// The surface switcher navigates between separate top-level views (each its own
// <main>), so it is roving navigation with aria-current, not an ARIA tab widget.
function SurfaceNavigation<T extends string>(props: {
  label: string;
  items: readonly { id: T; label: string }[];
  active: T;
  onSelect: (value: T) => void;
}): React.JSX.Element | null {
  const roving = useRovingFocus({ ids: props.items.map((item) => item.id), active: props.active, onSelect: props.onSelect });
  if (props.items.length <= 1) return null;
  return <nav className="studio-tabs studio-secondary-tabs" aria-label={props.label} onKeyDown={roving.onKeyDown} style={{ gridTemplateColumns: `repeat(${props.items.length}, minmax(0, 1fr))` }}>{props.items.map((item) => <button key={item.id} ref={roving.itemRef(item.id)} type="button" tabIndex={roving.tabIndexFor(item.id)} aria-current={props.active === item.id ? "page" : undefined} className={props.active === item.id ? "active" : ""} onClick={() => props.onSelect(item.id)}>{item.label}</button>)}</nav>;
}

function areaFromHash(): StudioArea {
  const candidate = globalThis.location?.hash.replace(/^#\/?/, "") as StudioArea | undefined;
  return candidate !== undefined && Object.hasOwn(AREA_COPY, candidate) ? candidate : "overview";
}
