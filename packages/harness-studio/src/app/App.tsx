import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Icon } from "@phosphor-icons/react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Binoculars } from "@phosphor-icons/react/Binoculars";
import { Database } from "@phosphor-icons/react/Database";
import { Flask } from "@phosphor-icons/react/Flask";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { ListChecks } from "@phosphor-icons/react/ListChecks";
import { SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SquaresFour } from "@phosphor-icons/react/SquaresFour";
import { TreeStructure } from "@phosphor-icons/react/TreeStructure";
import { CompareView } from "./CompareView.js";
import { ExperimentView } from "./ExperimentView.js";
import { RunView } from "./RunView.js";
import { useRovingTablist } from "./roving-tablist.js";
import {
  capabilitySummary,
  experimentSurfaces,
  inspectorSurfaces,
  studioDestinations,
  type StudioArea,
  type StudioConfig,
  type StudioDestination,
  type StudioExperimentSurface,
} from "./studio-shell-model.js";

const NAV_ICONS: Record<StudioArea, Icon> = {
  overview: SquaresFour,
  inspector: Binoculars,
  harnesses: TreeStructure,
  "task-suites": ListChecks,
  experiments: Flask,
  registry: Database,
};

const AREA_COPY: Record<StudioArea, { eyebrow: string; title: string }> = {
  overview: { eyebrow: "Control", title: "Harness Control Center" },
  inspector: { eyebrow: "Observe", title: "Inspector" },
  harnesses: { eyebrow: "Compose", title: "Harnesses" },
  "task-suites": { eyebrow: "Compose", title: "Task Suites" },
  experiments: { eyebrow: "Validate", title: "Experiments · Harness Bench" },
  registry: { eyebrow: "Govern", title: "Registry" },
};

const EMPTY_CONFIG: StudioConfig = {
  aguiEnabled: false,
  evidenceEnabled: false,
  experimentEnabled: false,
  historyEnabled: false,
  inspectorEnabled: false,
};

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<StudioConfig | undefined>(undefined);
  const [configFailure, setConfigFailure] = useState<string | null>(null);
  const [area, setArea] = useState<StudioArea>(areaFromHash);
  const [experimentSurface, setExperimentSurface] = useState<StudioExperimentSurface>("experiment");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/config");
        if (!response.ok) throw new Error(`Studio config failed (${response.status}).`);
        const loaded = { ...EMPTY_CONFIG, ...(await response.json() as Partial<StudioConfig>) };
        if (!cancelled) {
          setConfigFailure(null);
          setConfig(loaded);
          setExperimentSurface(experimentSurfaces(loaded)[0] ?? "experiment");
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

  if (config === undefined) {
    return <main className="studio-loading"><span className="studio-loading-mark"><GitBranch size={18} weight="bold" /></span><p>Loading Harness control plane…</p></main>;
  }
  if (configFailure !== null) {
    return <main className="studio-loading" role="alert"><span className="studio-loading-mark"><GitBranch size={18} weight="bold" /></span><strong>Cannot load Studio configuration.</strong><p>{configFailure}</p></main>;
  }

  const destinations = studioDestinations(config);
  const current = destinations.find((destination) => destination.id === area) ?? destinations[0]!;
  const experimentNavigation = (
    <SurfaceNavigation
      label="Experiment surfaces"
      items={experimentSurfaces(config).map((id) => ({
        id,
        label: id === "experiment" ? "Bench" : id === "live-run" ? "Live trial" : "Evidence results",
      }))}
      active={experimentSurface}
      onSelect={setExperimentSurface}
    />
  );
  const contextNavigation = area === "experiments" && experimentSurfaces(config).length > 1
    ? experimentNavigation
    : null;

  return <div className={`studio-control-plane${navigationOpen ? " navigation-open" : ""}`}>
    <PrimaryNavigation destinations={destinations} current={area} onSelect={openArea} />
    <button className="studio-nav-backdrop" type="button" aria-label="Close Studio navigation" onClick={() => { setNavigationOpen(false); navigationToggleRef.current?.focus(); }} />
    <section className="studio-area">
      <header className={`studio-context-bar${contextNavigation ? " has-surface-navigation" : ""}`}>
        <button ref={navigationToggleRef} className="studio-nav-toggle" type="button" aria-label={navigationOpen ? "Close Studio navigation" : "Open Studio navigation"} aria-expanded={navigationOpen} onClick={() => setNavigationOpen((value) => !value)}><SidebarSimple size={17} /></button>
        <div className="studio-context-title"><small>{AREA_COPY[area].eyebrow}</small><h1>{AREA_COPY[area].title}</h1></div>
        {contextNavigation && <div className="studio-context-navigation">{contextNavigation}</div>}
        <div className="studio-context-state"><span className={`availability-dot availability-${current.availability}`} /><strong>{current.status}</strong><span>Local control plane</span></div>
      </header>
      <div className={`studio-surface studio-surface-${area}`}>
        {area === "overview" && <Overview config={config} onOpen={openArea} />}
        {area === "inspector" && <InspectorWorkspace config={config} />}
        {area === "harnesses" && <HarnessesWorkspace config={config} onOpen={openArea} />}
        {area === "task-suites" && <TaskSuitesWorkspace config={config} onOpen={openArea} />}
        {area === "experiments" && <ExperimentsWorkspace config={config} surface={experimentSurface} navigation={experimentNavigation} />}
        {area === "registry" && <RegistryWorkspace />}
      </div>
    </section>
  </div>;
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
  const nextArea: StudioArea = props.config.experimentEnabled
    ? "experiments"
    : props.config.inspectorEnabled
      ? "inspector"
      : props.config.aguiEnabled || props.config.evidenceEnabled
        ? "experiments"
      : "harnesses";
  const inputs = [
    ["Inspector report", props.config.inspectorEnabled],
    ["Harness runtime", props.config.aguiEnabled],
    ["Experiment manifest", props.config.experimentEnabled],
    ["Compare evidence", props.config.evidenceEnabled],
    ["History adapter", props.config.historyEnabled],
  ] as const;
  const loop = [
    { step: "01", label: "Observe", detail: "Inspect retained delivery evidence", ready: props.config.inspectorEnabled },
    { step: "02", label: "Compose", detail: "Name the Harness change", ready: props.config.aguiEnabled || props.config.experimentEnabled },
    { step: "03", label: "Experiment", detail: "Hold task and runtime constant", ready: props.config.experimentEnabled },
    { step: "04", label: "Explain", detail: "Compare outcome and trace evidence", ready: props.config.experimentEnabled || props.config.evidenceEnabled },
    { step: "05", label: "Promote", detail: "Bind evidence to a team default", ready: false },
  ];
  return <main className="control-overview">
    <section className="control-hero">
      <div><small>Repository-native Harness Engineering</small><h1>Change one Harness variable.<br />Prove it holds.</h1><p>Observe real delivery, lock the Harness and runtime envelope, run a controlled comparison, then decide with evidence.</p><button type="button" onClick={() => props.onOpen(nextArea)}>Open {AREA_COPY[nextArea].title}<ArrowRight size={15} weight="bold" /></button></div>
      <aside aria-label="Harness analysis unit"><small>Analysis unit</small><strong>Harness Revision</strong><span>× Task Suite</span><span>× Runtime Envelope</span><p>Sessions and tool calls are evidence inside this unit, not the product's top-level object.</p></aside>
    </section>

    <section className="control-loop" aria-labelledby="control-loop-title"><header><div><small>Operating model</small><h2 id="control-loop-title">Observe → Compose → Experiment → Explain → Promote</h2></div><span>{summary.ready} ready · {summary.partial} partial · {summary.foundation} foundations</span></header><ol>{loop.map((item) => <li key={item.step} className={item.ready ? "is-ready" : "is-foundation"}><small>{item.step}</small><strong>{item.label}</strong><p>{item.detail}</p><span>{item.ready ? "Available" : "Contract first"}</span></li>)}</ol></section>

    <div className="control-grid">
      <section className="control-panel"><header><div><small>Loaded inputs</small><h2>Current workspace boundary</h2></div><span>Server facts</span></header><ul className="input-readiness">{inputs.map(([label, enabled]) => <li key={label}><span className={`availability-dot ${enabled ? "availability-ready" : "availability-foundation"}`} /><strong>{label}</strong><em>{enabled ? "Connected" : "Not supplied"}</em></li>)}</ul></section>
      <section className="control-panel"><header><div><small>Information architecture</small><h2>Objects before pages</h2></div><span>No invented state</span></header><div className="object-map"><article><strong>Harnesses</strong><p>Source, components, revisions, compatibility, materialization.</p></article><article><strong>Task Suites</strong><p>Tasks, checkpoints, graders, splits, replayability.</p></article><article><strong>Experiments</strong><p>Design, lock, run, analyze, evidence bundle.</p></article><article><strong>Registry</strong><p>Candidates, policies, revalidation, rollback.</p></article></div></section>
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
      <header><div><strong>Inspector Workbench</strong><span>Cross-delivery evidence · read-only</span></div><p>Capability / Date → Session → Commit / File</p></header>
      <iframe title="Harness Inspector Workbench" src="inspector" sandbox="allow-scripts" referrerPolicy="no-referrer" />
    </section>;
  }
  return <EmptyWorkspace eyebrow="Observed delivery" title="Connect an Inspector report" detail="Inspector requires retained, privacy-filtered evidence. It never substitutes the recorded Session Debugger fixture for a real workspace." command="--inspector ./harness-inspector.html" />;
}

function ExperimentsWorkspace(props: {
  config: StudioConfig;
  surface: StudioExperimentSurface;
  navigation: ReactNode;
}): React.JSX.Element {
  const available = experimentSurfaces(props.config);
  if (available.length === 0) {
    return <EmptyWorkspace eyebrow="Controlled validation" title="Load an experiment or evidence bundle" detail="Harness Bench needs a locked experiment manifest, a live Harness, or frozen compare evidence. It does not infer an experiment from an Inspector association." command="--experiment ./experiment.json" />;
  }
  if (props.surface === "experiment" && props.config.experimentEnabled) {
    return <main className="experiment-mode"><ExperimentView navigation={props.navigation} /></main>;
  }
  if (props.surface === "live-run" && props.config.aguiEnabled) {
    return <div className="debugger-mode"><RunView aguiEndpoint="agui" navigation={props.navigation} initialMode="live" /></div>;
  }
  if (props.surface === "results" && props.config.evidenceEnabled) {
    return <main className="evidence-results"><header><div><small>Frozen comparison</small><h1>Evidence results</h1></div>{props.navigation}</header><CompareView /></main>;
  }
  const fallback = available[0]!;
  return <EmptyWorkspace eyebrow="Surface unavailable" title="Choose a configured experiment surface" detail={`The requested surface is not connected. Available now: ${fallback}.`} />;
}

function HarnessesWorkspace(props: { config: StudioConfig; onOpen: (area: StudioArea) => void }): React.JSX.Element {
  const loaded = props.config.aguiEnabled || props.config.experimentEnabled;
  return <FoundationWorkspace
    eyebrow="Harness Revision"
    title={loaded ? "Harness context is loaded, editing is not." : "Load a Harness source or experiment."}
    detail="Harnesses own the change under test: Skills, Tools, MCP, Workflows, Runtime Profiles, the locked Revision, and host materialization. Studio currently receives that context from the server; it does not yet expose a source editor or revision catalog."
    current={loaded ? "Current experiment/runtime can identify Harness and profile context." : "No Harness or experiment context was supplied."}
    capabilities={["Source & components", "Semantic diff", "Revision history", "Host compatibility", "Materialization preview"]}
    action={props.config.experimentEnabled ? { label: "Open Harness Bench", onClick: () => props.onOpen("experiments") } : undefined}
  />;
}

function TaskSuitesWorkspace(props: { config: StudioConfig; onOpen: (area: StudioArea) => void }): React.JSX.Element {
  return <FoundationWorkspace
    eyebrow="Repository task assets"
    title={props.config.experimentEnabled ? "One task is bound; a Suite is not." : "Task Suite contract comes before evaluation scale."}
    detail="A Task Suite should bind replayable repository tasks to checkpoints, requests, deterministic graders, and held-out coverage. The current experiment manifest supplies one request/checkpoint comparison, so Studio labels that partial truth instead of presenting a dataset dashboard."
    current={props.config.experimentEnabled ? "The loaded experiment provides a single task boundary." : "No task or grader contract is connected."}
    capabilities={["Tasks & checkpoints", "Graders", "History candidates", "Splits & coverage", "Replayability & leakage"]}
    action={props.config.experimentEnabled ? { label: "Inspect current experiment", onClick: () => props.onOpen("experiments") } : undefined}
  />;
}

function RegistryWorkspace(): React.JSX.Element {
  return <FoundationWorkspace
    eyebrow="Evidence-backed governance"
    title="Promotion is intentionally unavailable."
    detail="Registry needs a frozen state machine and immutable Evidence Bundle links before Studio can name a Candidate, Team Default, or Promoted Revision. Revalidation must create new evidence rather than mutate prior proof."
    current="No registry, promotion policy, CI gate, or rollback contract is connected."
    capabilities={["Candidates & promoted revisions", "Evidence bundles", "Promotion policy", "CI gates", "Drift & revalidation", "Rollback"]}
  />;
}

function FoundationWorkspace(props: {
  eyebrow: string;
  title: string;
  detail: string;
  current: string;
  capabilities: readonly string[];
  action?: { label: string; onClick: () => void };
}): React.JSX.Element {
  return <main className="foundation-workspace"><section className="foundation-intro"><small>{props.eyebrow}</small><h1>{props.title}</h1><p>{props.detail}</p>{props.action && <button type="button" onClick={props.action.onClick}>{props.action.label}<ArrowRight size={14} /></button>}</section><div className="foundation-grid"><section><small>Available evidence</small><h2>Current boundary</h2><p>{props.current}</p><span>Facts only · no inferred capability</span></section><section><small>Target object model</small><h2>Planned surfaces</h2><ul>{props.capabilities.map((capability) => <li key={capability}><span className="availability-dot availability-foundation" />{capability}</li>)}</ul></section></div></main>;
}

function EmptyWorkspace(props: { eyebrow: string; title: string; detail: string; command?: string }): React.JSX.Element {
  return <main className="empty-workspace"><span><GitBranch size={22} /></span><small>{props.eyebrow}</small><h1>{props.title}</h1><p>{props.detail}</p>{props.command && <code>{props.command}</code>}</main>;
}

function SurfaceNavigation<T extends string>(props: {
  label: string;
  items: readonly { id: T; label: string }[];
  active: T;
  onSelect: (value: T) => void;
}): React.JSX.Element | null {
  const tablist = useRovingTablist({ ids: props.items.map((item) => item.id), active: props.active, onSelect: props.onSelect });
  if (props.items.length <= 1) return null;
  return <nav className="studio-tabs studio-secondary-tabs" aria-label={props.label} {...tablist.tablistProps} style={{ gridTemplateColumns: `repeat(${props.items.length}, minmax(0, 1fr))` }}>{props.items.map((item) => <button key={item.id} type="button" {...tablist.getTabProps(item.id)} className={props.active === item.id ? "active" : ""} onClick={() => props.onSelect(item.id)}>{item.label}</button>)}</nav>;
}

function areaFromHash(): StudioArea {
  const candidate = globalThis.location?.hash.replace(/^#\/?/, "") as StudioArea | undefined;
  return candidate !== undefined && Object.hasOwn(AREA_COPY, candidate) ? candidate : "overview";
}
