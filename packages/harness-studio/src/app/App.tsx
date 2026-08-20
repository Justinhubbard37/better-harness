import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Icon } from "@phosphor-icons/react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Binoculars } from "@phosphor-icons/react/Binoculars";
import { BugBeetle } from "@phosphor-icons/react/BugBeetle";
import { Flask } from "@phosphor-icons/react/Flask";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Package } from "@phosphor-icons/react/Package";
import { SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SquaresFour } from "@phosphor-icons/react/SquaresFour";
import { CompareView } from "./CompareView.js";
import { ExperimentView } from "./ExperimentView.js";
import { InspectorWorkbench } from "./InspectorWorkbench.js";
import { RunView } from "./RunView.js";
import { useRovingFocus } from "./roving-tablist.js";
import {
  capabilitySummary,
  compareSurfaces,
  inspectorSurfaces,
  studioDestinations,
  type StudioArea,
  type StudioCompareSurface,
  type StudioConfig,
  type StudioDestination,
} from "./studio-shell-model.js";

const NAV_ICONS: Record<StudioArea, Icon> = {
  overview: SquaresFour,
  inspector: Binoculars,
  artifacts: Package,
  debugger: BugBeetle,
  compare: Flask,
};

const AREA_COPY: Record<StudioArea, { eyebrow: string; title: string }> = {
  overview: { eyebrow: "Control", title: "Harness Control Center" },
  inspector: { eyebrow: "Observe", title: "Inspector" },
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
  const [configFailure, setConfigFailure] = useState<string | null>(null);
  const [area, setArea] = useState<StudioArea>(areaFromHash);
  const [compareSurface, setCompareSurface] = useState<StudioCompareSurface>("bench");
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
          setCompareSurface((currentSurface) => compareSurfaces(loaded.config).includes(currentSurface) ? currentSurface : compareSurfaces(loaded.config)[0] ?? "bench");
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
      setCompareSurface((currentSurface) => compareSurfaces(loaded.config).includes(currentSurface) ? currentSurface : compareSurfaces(loaded.config)[0] ?? "bench");
      setDataRevision((revision) => revision + 1);
    } catch (error) {
      setConfigFailure(error instanceof Error ? error.message : "Studio source switch failed.");
    }
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
        label: id === "bench" ? "Bench" : "Evidence results",
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
        {area === "inspector" && <InspectorWorkspace key={`inspector-${dataRevision}-${config.inspectorEnabled}`} config={config} />}
        {area === "artifacts" && <ArtifactsWorkspace key={`artifacts-${dataRevision}-${config.artifactsEnabled}`} config={config} />}
        {area === "debugger" && <DebuggerWorkspace config={config} />}
        {area === "compare" && <CompareWorkspace key={`compare-${dataRevision}-${config.experimentEnabled}-${config.evidenceEnabled}`} config={config} surface={compareSurface} navigation={compareNavigation} />}
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
  const nextArea: StudioArea = props.config.inspectorEnabled
    ? "inspector"
    : props.config.aguiEnabled
      ? "debugger"
      : props.config.experimentEnabled || props.config.evidenceEnabled
        ? "compare"
        : "inspector";
  const inputs = [
    ["Inspector report", props.config.inspectorEnabled],
    ["Harness runtime", props.config.aguiEnabled],
    ["Experiment manifest", props.config.experimentEnabled],
    ["Compare evidence", props.config.evidenceEnabled],
    ["History adapter", props.config.historyEnabled],
  ] as const;
  const missingInputs = inputs.filter(([, enabled]) => !enabled);
  const actions = [
    { label: "Go to Inspector", area: "inspector" as const, enabled: props.config.inspectorEnabled, detail: "Retained sessions" },
    { label: "Go to Debugger", area: "debugger" as const, enabled: props.config.aguiEnabled, detail: "Live runs" },
    { label: "Go to Compare", area: "compare" as const, enabled: props.config.experimentEnabled || props.config.evidenceEnabled, detail: "Bench and results" },
  ];
  return <main className="control-overview">
    <section className="control-hero">
      <div><small>Ready now</small><h1>Open the connected workspace.</h1><p>{summary.ready} ready · {summary.partial} partial · {summary.foundation} foundations. Studio shows only configured evidence and keeps unavailable surfaces quiet.</p><button type="button" onClick={() => props.onOpen(nextArea)}>Open {AREA_COPY[nextArea].title}<ArrowRight size={15} weight="bold" /></button></div>
      <aside className="control-actions" aria-label="Available actions"><small>Available actions</small><ul>{actions.map((action) => <li key={action.label} className={action.enabled ? "is-ready" : "is-foundation"}><span className={`availability-dot availability-${action.enabled ? "ready" : "foundation"}`} /><button type="button" disabled={!action.enabled} onClick={() => props.onOpen(action.area)}>{action.label}</button><em>{action.detail}</em></li>)}</ul></aside>
    </section>

    <div className="control-grid">
      <section className="control-panel"><header><div><small>Loaded inputs</small><h2>Current boundary</h2></div><span>Server facts</span></header><ul className="input-readiness">{inputs.map(([label, enabled]) => <li key={label}><span className={`availability-dot ${enabled ? "availability-ready" : "availability-foundation"}`} /><strong>{label}</strong><em>{enabled ? "Connected" : "Not supplied"}</em></li>)}</ul></section>
      <section className="control-panel"><header><div><small>Next action</small><h2>Missing inputs stay explicit</h2></div><span>No inferred state</span></header><ul className="input-readiness">{missingInputs.length > 0 ? missingInputs.map(([label]) => <li key={label}><span className="availability-dot availability-foundation" /><strong>{label}</strong><em>Load when needed</em></li>) : <li><span className="availability-dot availability-ready" /><strong>All configured inputs connected</strong><em>Ready</em></li>}</ul></section>
    </div>
  </main>;
}

function InspectorWorkspace(props: { config: StudioConfig }): React.JSX.Element {
  const available = inspectorSurfaces(props.config);
  if (available.length === 0) {
    return <EmptyWorkspace eyebrow="Observed delivery" title="Connect an Inspector report" detail="Render a privacy-filtered Harness Inspector HTML report, then start Studio with --inspector <report.html>. Live runs remain under Experiments until Studio has a retained-session contract." command="--inspector ./harness-inspector.html" />;
  }
  if (props.config.inspectorEnabled) {
    return <section className="inspector-workspace" aria-label="Inspector workspace">
      <header><div><strong>Inspector Workbench</strong><span>Read-only</span></div></header>
      <InspectorWorkbench fallback={<iframe title="Harness Inspector Workbench" src="inspector" sandbox="allow-scripts" referrerPolicy="no-referrer" />} />
    </section>;
  }
  return <EmptyWorkspace eyebrow="Observed delivery" title="Connect an Inspector report" detail="Inspector requires retained, privacy-filtered evidence. It never substitutes the recorded Session Debugger fixture for a real workspace." command="--inspector ./harness-inspector.html" />;
}

interface ArtifactDescriptor {
  id: string;
  kind: string;
  label: string;
  size: number;
}

/**
 * Artifacts pane: a row list of run outputs plus a sandboxed preview.
 *
 * The preview frame withholds `allow-same-origin`, so artifact code runs on an
 * opaque origin and cannot reach the Studio shell.
 */
function ArtifactsWorkspace(props: { config: StudioConfig }): React.JSX.Element {
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
        // Deliberately no auto-selection: compiling an artifact the reader has
        // not asked for spends server work and can open the pane on an error.
        setArtifacts(Array.isArray(payload.artifacts) ? payload.artifacts : []);
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [props.config.artifactsEnabled]);

  if (!props.config.artifactsEnabled) {
    return <EmptyWorkspace eyebrow="Run outputs" title="Load an artifact directory" detail="Artifacts renders what a run produced. It reads a directory read-only and never writes back to it." command="--artifacts ./artifacts" />;
  }
  if (failure !== undefined) {
    return <EmptyWorkspace eyebrow="Run outputs" title="Cannot read the artifact catalog" detail={failure} command="--artifacts ./artifacts" />;
  }
  if (artifacts === undefined) {
    return <p className="artifact-status" role="status">Loading artifacts…</p>;
  }
  if (artifacts.length === 0) {
    return <EmptyWorkspace eyebrow="Run outputs" title="No artifacts in this directory" detail="The configured directory holds no files Studio can render yet. Artifact rows appear once a run writes into it." command="--artifacts ./artifacts" />;
  }

  const active = artifacts.find((entry) => entry.id === selected);
  return <section className="artifact-workspace" aria-label="Artifacts workspace">
    <div className="artifact-list-pane">
      <header><div><small>Retained</small><h2>Artifacts</h2></div><span>{artifacts.length}</span></header>
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
        : active.kind === "module"
          ? <iframe
            key={active.id}
            className="artifact-frame"
            title={`Artifact preview: ${active.label}`}
            src={`artifact-host.html?module=api/artifacts/${active.id}/module.js`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
          : <p className="artifact-status" role="status">No renderer for <code>{active.kind}</code> yet. Only compiled modules render in this increment.</p>}
    </div>
  </section>;
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
  return <div className="debugger-mode"><RunView aguiEndpoint="agui" /></div>;
}

function CompareWorkspace(props: {
  config: StudioConfig;
  surface: StudioCompareSurface;
  navigation: ReactNode;
}): React.JSX.Element {
  const available = compareSurfaces(props.config);
  if (available.length === 0) {
    return <EmptyWorkspace eyebrow="Controlled validation" title="Load an experiment or evidence bundle" detail="Compare needs a locked experiment manifest or frozen compare evidence. It does not infer an experiment from an Inspector association." command="--experiment ./experiment.json" />;
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
