import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Icon } from "@phosphor-icons/react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Binoculars } from "@phosphor-icons/react/Binoculars";
import { BugBeetle } from "@phosphor-icons/react/BugBeetle";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { ChatText } from "@phosphor-icons/react/ChatText";
import { EyeSlash } from "@phosphor-icons/react/EyeSlash";
import { File } from "@phosphor-icons/react/File";
import { FileCode } from "@phosphor-icons/react/FileCode";
import { FileImage } from "@phosphor-icons/react/FileImage";
import { FilePpt } from "@phosphor-icons/react/FilePpt";
import { Flask } from "@phosphor-icons/react/Flask";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Moon } from "@phosphor-icons/react/Moon";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Package } from "@phosphor-icons/react/Package";
import { SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SquaresFour } from "@phosphor-icons/react/SquaresFour";
import { Sun } from "@phosphor-icons/react/Sun";
import {
  isArtifactCatalogResponse,
  type ArtifactCatalogResponse,
  type ArtifactDescriptor,
  type ArtifactFamily,
} from "../artifact-model.js";
import { ArtifactView } from "./ArtifactView.js";
import { CompareView } from "./CompareView.js";
import { ExperimentView } from "./ExperimentView.js";
import { GitHistoryView } from "./GitHistoryView.js";
import { InputTraceView } from "./InputTraceView.js";
import { RunView } from "./RunView.js";
import type { DebuggerSession } from "./session-debugger-model.js";
import { useRovingFocus } from "./roving-tablist.js";
import { studioApiError } from "./studio-api.js";
import { StudioThemeContext, type StudioTheme } from "./studio-theme.js";

const InspectorWorkbench = lazy(async () => ({ default: (await import("./InspectorWorkbench.js")).InspectorWorkbench }));
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
  inputs: ChatText,
  sessions: Binoculars,
  commits: GitBranch,
  artifacts: Package,
  debugger: BugBeetle,
  compare: Flask,
};

// The sidebar already groups these destinations, so the context bar carries the
// view name alone rather than repeating the group as an eyebrow.
const AREA_COPY: Record<StudioArea, string> = {
  overview: "Overview",
  inputs: "Inputs",
  sessions: "Sessions",
  commits: "Commits",
  artifacts: "Artifacts",
  debugger: "Debugger",
  compare: "Compare",
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
  gitEnabled: false,
  harnessMode: "none",
  historyEnabled: false,
  inspectorEnabled: false,
  workspaceWorkbenchEnabled: false,
  workspaceDiscoveryEnabled: false,
  workspaceConnected: false,
  sessionCount: 0,
  inputCount: 0,
  intentAnalysisEnabled: false,
};

function initialStudioTheme(): StudioTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

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
  const [theme, setTheme] = useState<StudioTheme>(initialStudioTheme);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      globalThis.localStorage.setItem("harness-studio-theme", theme);
    } catch {
      // Theme preference remains usable for this page when storage is blocked.
    }
  }, [theme]);

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
    return <main className="studio-loading"><span className="studio-loading-mark"><GitBranch aria-hidden="true" size={18} weight="bold" /></span><p>Loading Harness control plane…</p></main>;
  }
  if (configFailure !== null) {
    return <main className="studio-loading" role="alert"><span className="studio-loading-mark"><GitBranch aria-hidden="true" size={18} weight="bold" /></span><strong>Cannot load Studio configuration.</strong><p>{configFailure}</p></main>;
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
  const workspaceGateOpen = config.workspaceDiscoveryEnabled && !config.workspaceConnected;

  return <StudioThemeContext.Provider value={theme}>
  <div className={`studio-control-plane${navigationOpen ? " navigation-open" : ""}`} inert={workspaceGateOpen ? true : undefined} aria-hidden={workspaceGateOpen ? true : undefined}>
    <PrimaryNavigation destinations={destinations} current={area} onSelect={openArea} />
    <button className="studio-nav-backdrop" type="button" aria-label="Close Studio navigation" onClick={() => { setNavigationOpen(false); navigationToggleRef.current?.focus(); }} />
    <section className="studio-area">
      <header className={`studio-context-bar${contextNavigation ? " has-surface-navigation" : ""}`}>
        <button ref={navigationToggleRef} className="studio-nav-toggle" type="button" title={navigationOpen ? "Close navigation" : "Open navigation"} aria-label={navigationOpen ? "Close Studio navigation" : "Open Studio navigation"} aria-expanded={navigationOpen} onClick={() => setNavigationOpen((value) => !value)}><SidebarSimple aria-hidden="true" size={17} /></button>
        <div className="studio-context-title"><h1>{AREA_COPY[area]}</h1></div>
        {contextNavigation && <div className="studio-context-navigation">{contextNavigation}</div>}
        <ThemeToggle theme={theme} onChange={setTheme} />
        {sources.length > 0 && <SourceSwitcher sources={sources} onSelect={(source) => void selectSource(source)} />}
        <div className="studio-context-state"><span className={`availability-dot availability-${current.availability}`} /><strong>{current.status}</strong></div>
      </header>
      <div className={`studio-surface studio-surface-${area}`}>
        {area === "overview" && <Overview config={config} onOpen={openArea} />}
        {area === "inputs" && (config.workspaceWorkbenchEnabled ? <InputTraceView key={`inputs-${workspaceRevision}`} intentAnalysisEnabled={config.intentAnalysisEnabled} /> : <EmptyWorkspace eyebrow="User input trace" title={config.workspaceConnected ? "No retained input trace is available" : "Open a project workspace"} detail={config.workspaceConnected ? "This workspace source does not include structured Inspector dialogue evidence." : "Choose the project directory in Sessions before browsing retained user inputs and exact file operations."} />)}
        {area === "sessions" && <SessionsWorkspace key={`sessions-${dataRevision}-${workspaceRevision}`} config={config} onWorkspaceChanged={workspaceChanged} onSelectSession={setSelectedSessionId} onCompare={(ids) => { setSessionCompareIds(ids); setCompareSurface("sessions"); openArea("compare"); }} />}
        {area === "commits" && (config.gitEnabled ? <GitHistoryView key={`commits-${workspaceRevision}`} /> : <EmptyWorkspace eyebrow="Repository history" title={config.workspaceConnected ? "The open workspace is not a Git repository" : "Open a project workspace"} detail={config.workspaceConnected ? "Commit history is available only for a local workspace backed by Git." : "Choose the project directory in Sessions before browsing its local commit history."} />)}
        {area === "artifacts" && <ArtifactsWorkspace key={`artifacts-${dataRevision}-${config.artifactsEnabled}-${selectedSessionId ?? "none"}`} config={config} selectedSessionId={selectedSessionId} />}
        {area === "debugger" && <DebuggerWorkspace config={config} />}
        {area === "compare" && <CompareWorkspace key={`compare-${dataRevision}-${workspaceRevision}-${config.experimentEnabled}-${config.evidenceEnabled}`} config={config} surface={compareSurface} navigation={compareNavigation} sessionIds={sessionCompareIds} />}
      </div>
    </section>
  </div>
  {workspaceGateOpen && <WorkspaceGate onWorkspaceChanged={async () => {
    await workspaceChanged();
    openArea(area === "overview" ? "sessions" : area);
  }} />}
  </StudioThemeContext.Provider>;
}

function WorkspaceGate(props: { onWorkspaceChanged: () => Promise<void> }): React.JSX.Element {
  return <section className="studio-workspace-gate" role="dialog" aria-modal="true" aria-labelledby="workspace-gate-title" aria-describedby="workspace-gate-description">
    <div className="studio-workspace-gate-panel">
      <header><span><FolderOpen aria-hidden="true" size={22} /></span><div><small>Local Web workspace</small><h1 id="workspace-gate-title">Open a workspace to start</h1></div></header>
      <p id="workspace-gate-description">Choose the repository or project directory you worked in. Studio will discover matching local agent inputs and Sessions before opening the workbench.</p>
      <WorkspaceFolderControls autoFocus onWorkspaceChanged={props.onWorkspaceChanged} />
      <footer><strong>Workspace-scoped discovery</strong><span>The selected directory scopes Session lookup; Studio does not treat a global Session folder as the project.</span></footer>
    </div>
  </section>;
}

function ThemeToggle(props: { theme: StudioTheme; onChange: (theme: StudioTheme) => void }): React.JSX.Element {
  const next = props.theme === "dark" ? "light" : "dark";
  const label = `${props.theme === "dark" ? "Dark" : "Light"} theme active. Switch to ${next} theme`;
  return <button className="studio-theme-toggle" type="button" title={`Switch to ${next} theme`} aria-label={label} onClick={() => props.onChange(next)}>
    {props.theme === "dark" ? <Moon aria-hidden="true" size={15} weight="fill" /> : <Sun aria-hidden="true" size={15} weight="fill" />}
    <span>{props.theme === "dark" ? "Dark" : "Light"}</span>
  </button>;
}

function SourceSwitcher(props: {
  sources: StudioSourceOption[];
  onSelect: (source: StudioSourceOption) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const active = props.sources.filter((source) => source.active);
  const kinds: StudioSourceKind[] = ["inspector", "evidence", "experiment"];
  return <div className="studio-source-switcher">
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><GitBranch aria-hidden="true" size={14} /><span>Data sources</span><em>{active.length}</em></button>
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
    <header className="studio-product-brand"><span><GitBranch aria-hidden="true" size={18} weight="bold" /></span><div><strong>Better Harness</strong><small>Studio</small></div></header>
    <nav aria-label="Harness control plane" onKeyDown={onNavigationKeyDown}>
      {groups.map((group) => <section className="studio-nav-group" key={group}><h2>{group}</h2>{props.destinations.filter((destination) => destination.group === group).map((destination) => {
        const NavIcon = NAV_ICONS[destination.id];
        return <button key={destination.id} ref={(node) => { if (node) buttonRefs.current.set(destination.id, node); else buttonRefs.current.delete(destination.id); }} type="button" tabIndex={props.current === destination.id ? 0 : -1} aria-current={props.current === destination.id ? "page" : undefined} onClick={() => props.onSelect(destination.id)}>
          <NavIcon aria-hidden="true" size={17} weight={props.current === destination.id ? "fill" : "regular"} />
          <span><strong>{destination.label}</strong><small>{destination.status}</small></span>
          <i className={`availability-dot availability-${destination.availability}`} aria-label={destination.availability} />
        </button>;
      })}</section>)}
    </nav>
  </aside>;
}

function Overview(props: { config: StudioConfig; onOpen: (area: StudioArea) => void }): React.JSX.Element {
  const summary = capabilitySummary(props.config);
  const nextArea: StudioArea = props.config.workspaceConnected
    ? "inputs"
    : props.config.aguiEnabled
      ? "debugger"
      : props.config.experimentEnabled || props.config.evidenceEnabled
        ? "compare"
        : "sessions";
  // Each row states what the input unlocks and how to supply it, so an absent
  // input teaches its own next action instead of only reporting "Not supplied".
  const inputs: Array<{ label: string; connected: boolean; purpose: string; flag?: string }> = [
    { label: "Project workspace", connected: props.config.workspaceConnected, purpose: "Discovers local agent inputs and Sessions" },
    { label: "Inspector workbench", connected: props.config.workspaceWorkbenchEnabled || props.config.inspectorEnabled, purpose: "Capability and date evidence", flag: "--inspector" },
    { label: "Harness runtime", connected: props.config.aguiEnabled, purpose: "Live runs in the Debugger", flag: "--harness" },
    { label: "Compare evidence", connected: props.config.evidenceEnabled, purpose: "Frozen verdict and trials", flag: "--evidence" },
    { label: "Experiment manifest", connected: props.config.experimentEnabled, purpose: "Three-lane experiment trace", flag: "--experiment" },
    { label: "Artifact catalog", connected: props.config.artifactsEnabled, purpose: "Read-only run outputs", flag: "--artifacts" },
    { label: "History adapter", connected: props.config.historyEnabled, purpose: "Checkpoint picker in the Builder", flag: "--history-catalog" },
  ];
  const connectedCount = inputs.filter((input) => input.connected).length;
  return <main className="control-overview">
    <section className="control-lead">
      <h1>{props.config.workspaceConnected
        ? `${props.config.inputCount} retained inputs discovered in this workspace.`
        : "Choose a project workspace to begin."}</h1>
      <p>{props.config.workspaceConnected
        ? "Open Inputs to trace each retained user prompt to exact observed file reads and changes."
        : "Studio discovers agent Sessions for the directory you pick, using the same provider code as Inspector. Nothing is read until you choose."}</p>
      <div className="control-lead-actions">
        <button className="primary" type="button" onClick={() => props.onOpen(nextArea)}>{props.config.workspaceConnected ? "Open Inputs" : "Open workspace"}<ArrowRight aria-hidden="true" size={15} weight="bold" /></button>
        <span>{summary.ready} ready · {summary.partial} partial · {summary.foundation} foundations</span>
      </div>
    </section>

    <section className="control-panel">
      <header><h2>Inputs</h2><span>{connectedCount} of {inputs.length} connected</span></header>
      <ul className="input-readiness">{inputs.map((input) => <li key={input.label} data-connected={input.connected ? "true" : "false"}>
        <span className={`availability-dot ${input.connected ? "availability-ready" : "availability-foundation"}`} aria-hidden="true" />
        <strong>{input.label}</strong>
        <em>{input.purpose}</em>
        {input.connected
          ? <span className="input-state">Connected</span>
          : input.flag
            ? <code>{input.flag}</code>
            : <span className="input-state">Choose in Studio</span>}
      </li>)}</ul>
    </section>
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
  const [surface, setSurface] = useState<"inspector" | "catalog">(
    props.config.workspaceWorkbenchEnabled ? "inspector" : "catalog",
  );

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
  const catalog = <section className="session-browser-workspace" aria-label="Project workspace sessions">
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

  if (!props.config.workspaceWorkbenchEnabled) return catalog;
  return <section className="session-workbench-stack" aria-label="Workspace Session evidence">
    <header className="session-workbench-toolbar">
      <div><strong>{workspaceLabel}</strong><span>Inspector-owned workspace evidence</span></div>
      <div className="session-surface-tabs" role="tablist" aria-label="Session views">
        <button id="session-tab-inspector" type="button" role="tab" aria-controls="session-workbench-panel" aria-selected={surface === "inspector"} tabIndex={surface === "inspector" ? 0 : -1} className={surface === "inspector" ? "selected" : undefined} onClick={() => setSurface("inspector")} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setSurface("catalog"); (event.currentTarget.nextElementSibling as HTMLButtonElement | null)?.focus(); } }}>Inspector</button>
        <button id="session-tab-catalog" type="button" role="tab" aria-controls="session-workbench-panel" aria-selected={surface === "catalog"} tabIndex={surface === "catalog" ? 0 : -1} className={surface === "catalog" ? "selected" : undefined} onClick={() => setSurface("catalog")} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); setSurface("inspector"); (event.currentTarget.previousElementSibling as HTMLButtonElement | null)?.focus(); } }}>Catalog &amp; Compare</button>
      </div>
    </header>
    <div id="session-workbench-panel" className="session-workbench-surface" role="tabpanel" aria-labelledby={surface === "inspector" ? "session-tab-inspector" : "session-tab-catalog"}>
      {surface === "inspector"
        ? <Suspense fallback={<p className="artifact-status" role="status">Loading Inspector workbench…</p>}>
            <InspectorWorkbench reportUrl="api/workspace-inspector-report" fallback={catalog} />
          </Suspense>
        : catalog}
    </div>
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
  return <main className="workspace-intake empty-workspace"><span><FolderOpen aria-hidden="true" size={22} /></span><small>Local Web workspace</small><h1>{props.title ?? "Open a project workspace"}</h1><p>{props.detail ?? "Choose the repository or project directory you worked in. Studio uses Inspector's provider discovery to find matching Sessions in local agent evidence stores."}</p><WorkspaceFolderControls onWorkspaceChanged={props.onWorkspaceChanged} /></main>;
}

function WorkspaceFolderControls(props: { autoFocus?: boolean; compact?: boolean; onWorkspaceChanged: () => Promise<void> }): React.JSX.Element {
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
    <button autoFocus={props.autoFocus} className={props.compact ? undefined : "primary"} type="button" disabled={busy} onClick={() => void openWorkspace()}><FolderOpen aria-hidden="true" size={14} />{busy ? "Opening…" : props.compact ? "Change workspace" : "Choose workspace"}</button>
    {busy && <span className="workspace-open-progress" role="status" aria-live="polite"><i aria-hidden="true" /><small>{progressMessage}</small></span>}
    {failure !== undefined && <small className="workspace-folder-error" role="alert">{failure}</small>}
  </div>;
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

/**
 * Artifacts pane: a row list of run outputs plus a sandboxed preview.
 *
 * The preview frame withholds `allow-same-origin`, so artifact code runs on an
 * opaque origin and cannot reach the Studio shell.
 */
type ArtifactNarrowSurface = "explorer" | "preview";

function ArtifactsWorkspace(props: { config: StudioConfig; selectedSessionId?: string }): React.JSX.Element {
  const [catalog, setCatalog] = useState<ArtifactCatalogResponse | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const [collapsed, setCollapsed] = useState<Set<ArtifactFamily>>(() => new Set());
  const [narrowSurface, setNarrowSurface] = useState<ArtifactNarrowSurface>("explorer");
  const [liveGeneration, setLiveGeneration] = useState(0);
  const [liveUpdates, setLiveUpdates] = useState(true);

  useEffect(() => {
    if (!props.config.artifactsEnabled) return;
    let cancelled = false;
    let requestSequence = 0;
    const refreshCatalog = async (liveUpdate = false): Promise<void> => {
      const request = ++requestSequence;
      try {
        const response = await fetch("/api/artifacts");
        if (!response.ok) throw new Error(`Artifact catalog failed (${response.status}).`);
        const payload: unknown = await response.json();
        if (!isArtifactCatalogResponse(payload)) throw new Error("Artifact catalog contract is unsupported.");
        if (cancelled || request !== requestSequence) return;
        setFailure(undefined);
        setCatalog(payload);
        if (liveUpdate) setLiveGeneration((value) => value + 1);
      } catch (error) {
        if (!cancelled && request === requestSequence) setFailure(error instanceof Error ? error.message : String(error));
      }
    };
    void refreshCatalog();
    const events = new EventSource("/api/artifacts/events");
    const invalidate = (): void => {
      // Refetch the authoritative descriptor before asking the active Host to
      // rebuild. Starting from the stale descriptor would intentionally hit the
      // revision route's 409 guard during every ordinary file update.
      void refreshCatalog(true);
    };
    events.addEventListener("artifacts.invalidated", invalidate);
    events.addEventListener("open", () => { if (!cancelled) setLiveUpdates(true); });
    events.addEventListener("error", () => {
      // EventSource retries a dropped transport on its own, but gives up for
      // good when the route answers with something that is not an event stream.
      // Only that second case is worth telling an operator about, because the
      // catalog on screen then stops tracking the directory silently.
      if (!cancelled && events.readyState === EventSource.CLOSED) setLiveUpdates(false);
    });
    return () => { cancelled = true; events.close(); };
  }, [props.config.artifactsEnabled]);

  const narrowTabs = useRovingFocus<ArtifactNarrowSurface>({ ids: ["explorer", "preview"], active: narrowSurface, onSelect: setNarrowSurface });

  if (!props.config.artifactsEnabled) {
    return props.config.workspaceConnected
      ? <EmptyWorkspace eyebrow="Session artifacts" title={props.selectedSessionId === undefined ? "Select a Session first" : "No artifacts indexed for this Session"} detail={props.selectedSessionId === undefined ? "Open Sessions and select retained evidence before viewing its outputs." : "The current Session adapter did not expose an artifact set. Studio does not substitute a loose global folder."} />
      : <EmptyWorkspace eyebrow="Session artifacts" title="Open a project workspace" detail="Artifacts belong to a discovered Session. Choose the project directory in Sessions before opening its outputs." />;
  }
  if (failure !== undefined) {
    return <EmptyWorkspace eyebrow="Session artifacts" title="Cannot read the compatibility artifact catalog" detail={failure} />;
  }
  if (catalog === undefined) {
    return <p className="artifact-status" role="status">Loading artifacts…</p>;
  }
  const artifacts = catalog.artifacts;
  if (artifacts.length === 0) {
    return <EmptyWorkspace eyebrow="Session artifacts" title="No artifacts in this set" detail={catalog.omitted.length === 0
      ? "The catalog contains no readable files."
      : `The catalog declined every entry in this directory: ${describeOmissions(catalog.omitted)}.`} />;
  }

  const active = artifacts.find((entry) => entry.id === selected);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = artifacts.filter((entry) => entry.label.toLocaleLowerCase().includes(normalizedQuery));
  const groups = artifactGroups(visible);
  const selectArtifact = (id: string): void => {
    setSelected(id);
    // Wide layouts keep both panes visible; on narrow layouts selecting a row
    // should reveal the result instead of requiring a second, hidden action.
    setNarrowSurface("preview");
  };
  const toggleGroup = (family: ArtifactFamily): void => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(family)) next.delete(family); else next.add(family);
    return next;
  });
  return <section className="artifact-workspace" data-narrow-surface={narrowSurface} aria-label="Artifacts workspace">
    <div className="artifact-narrow-tabs" role="tablist" aria-label="Artifact workspace view" onKeyDown={narrowTabs.onKeyDown}>
      <button type="button" role="tab" id="artifact-tab-explorer" aria-controls="artifact-explorer-pane" aria-selected={narrowSurface === "explorer"} ref={narrowTabs.itemRef("explorer")} tabIndex={narrowTabs.tabIndexFor("explorer")} onClick={() => setNarrowSurface("explorer")}>Explorer</button>
      <button type="button" role="tab" id="artifact-tab-preview" aria-controls="artifact-preview-pane" aria-selected={narrowSurface === "preview"} disabled={active === undefined} ref={narrowTabs.itemRef("preview")} tabIndex={narrowTabs.tabIndexFor("preview")} onClick={() => setNarrowSurface("preview")}>Preview</button>
    </div>
    <div className="artifact-list-pane" id="artifact-explorer-pane" role="tabpanel" aria-labelledby="artifact-tab-explorer">
      <header><div><small>Revision-bound outputs</small><h2>Artifact Explorer</h2></div><span title={`Catalog revision ${catalog.snapshot.revision}`}>{normalizedQuery === "" ? artifacts.length : `${visible.length}/${artifacts.length}`}</span></header>
      <div className="artifact-explorer-toolbar">
        <label><MagnifyingGlass aria-hidden="true" size={14} /><span className="sr-only">Search artifacts</span><input value={query} type="search" placeholder="Search artifacts…" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
        <div className="artifact-view-switch" role="group" aria-label="Artifact list view">
          <button type="button" aria-pressed={view === "grouped"} onClick={() => setView("grouped")}>Grouped</button>
          <button type="button" aria-pressed={view === "flat"} onClick={() => setView("flat")}>Flat</button>
        </div>
      </div>
      <nav className="artifact-rows" aria-label="Artifacts">
        {visible.length === 0
          ? <p className="artifact-list-empty">No filenames match “{query}”.</p>
          : view === "flat"
            ? visible.map((entry) => <ArtifactRow key={entry.id} artifact={entry} selected={entry.id === selected} onSelect={selectArtifact} />)
            : groups.map((group) => <section className="artifact-group" key={group.family} aria-label={group.label}>
              <button type="button" className="artifact-group-header" aria-expanded={!collapsed.has(group.family)} onClick={() => toggleGroup(group.family)}>
                {collapsed.has(group.family) ? <CaretRight aria-hidden="true" size={14} /> : <CaretDown aria-hidden="true" size={14} />}
                <span>{group.label}</span><small>{group.artifacts.length}</small>
              </button>
              {!collapsed.has(group.family) && group.artifacts.map((entry) => <ArtifactRow key={entry.id} artifact={entry} selected={entry.id === selected} onSelect={selectArtifact} />)}
            </section>)}
      </nav>
      {catalog.omitted.length > 0 && <p className="artifact-omissions" role="note">Not listed: {describeOmissions(catalog.omitted)}.</p>}
      {!liveUpdates && <p className="artifact-omissions" role="note">Live updates stopped. Reopen Artifacts to resume tracking this directory.</p>}
    </div>
    <div className="artifact-preview-pane" id="artifact-preview-pane" role="tabpanel" aria-labelledby="artifact-tab-preview">
      {active === undefined
        ? <p className="artifact-status" role="status">Select an artifact to preview it.</p>
        : <><header className="artifact-editor-header"><div><strong>{active.label}</strong><small>{formatLabel(active.format)} · {formatBytes(active.size)} · {shortRevision(active.revision.id)}</small></div><span>{active.adapter.id} → {active.renderer.label}</span></header><ArtifactView artifact={active} liveGeneration={liveGeneration} /></>}
    </div>
  </section>;
}

const OMISSION_LABELS: Record<string, string> = {
  "hard-link": "hard-linked",
  "not-a-file": "not a file",
  "outside-root": "resolving outside the artifact directory",
  symlink: "symlinked",
};

/** Says which entries the catalog declined and why, rather than dropping them. */
function describeOmissions(omitted: ArtifactCatalogResponse["omitted"]): string {
  return [...new Set(omitted.map((omission) => omission.reason))]
    .map((reason) => {
      const labels = omitted.filter((omission) => omission.reason === reason).map((omission) => omission.label);
      return `${labels.length} ${OMISSION_LABELS[reason] ?? reason} (${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", …" : ""})`;
    })
    .join("; ");
}

const ARTIFACT_GROUPS: Array<{ family: ArtifactFamily; label: string }> = [
  { family: "documents", label: "Documents" },
  { family: "images-diagrams", label: "Images & diagrams" },
  { family: "data", label: "Data" },
  { family: "source-text", label: "Source & text" },
  { family: "other", label: "Other" },
];

function artifactGroups(artifacts: ArtifactDescriptor[]): Array<{ family: ArtifactFamily; label: string; artifacts: ArtifactDescriptor[] }> {
  return ARTIFACT_GROUPS.map((group) => ({ ...group, artifacts: artifacts.filter((artifact) => artifact.family === group.family) }))
    .filter((group) => group.artifacts.length > 0);
}

function ArtifactRow(props: { artifact: ArtifactDescriptor; selected: boolean; onSelect: (id: string) => void }): React.JSX.Element {
  const ArtifactIcon = props.artifact.format === "pptx" ? FilePpt : props.artifact.family === "images-diagrams" ? FileImage : props.artifact.family === "source-text" ? FileCode : File;
  return <button
    type="button"
    className={`artifact-row${props.selected ? " selected" : ""}`}
    aria-current={props.selected ? "true" : undefined}
    onClick={() => props.onSelect(props.artifact.id)}
  >
    <ArtifactIcon aria-hidden="true" size={16} />
    <span className="artifact-row-copy"><strong>{props.artifact.label}</strong><small>{formatLabel(props.artifact.format)} · {formatBytes(props.artifact.size)}</small></span>
    {props.artifact.renderer.status === "unavailable" && <EyeSlash aria-label={props.artifact.renderer.reason ?? "Preview unavailable"} size={15} />}
  </button>;
}

/** Display names live here, not in the versioned catalog contract. */
const FORMAT_LABELS: Record<string, string> = {
  docx: "Word",
  file: "File",
  lottie: "Lottie",
  md: "Markdown",
  mermaid: "Mermaid",
  mmd: "Mermaid",
  pdf: "PDF",
  pptx: "PowerPoint",
  xlsx: "Excel",
};

function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

function shortRevision(value: string): string {
  return `${value.slice(0, 14)}…${value.slice(-6)}`;
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
  return <div className="debugger-mode"><RunView aguiEndpoint="agui" artifactEndpoint={props.config.artifactsEnabled ? "/api/artifacts" : undefined} harnessLabel={props.config.harnessMode === "workspace-default" ? "Workspace default · Qoder" : "Live Trial"} /></div>;
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
  return <main className="empty-workspace"><span><GitBranch aria-hidden="true" size={22} /></span><small>{props.eyebrow}</small><h1>{props.title}</h1><p>{props.detail}</p>{props.command && <code>{props.command}</code>}</main>;
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
