import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  localToolChain,
  normalizeToolCall,
  relatedCallFor,
  type ExperimentToolCall,
  type RelatedToolCall,
  type ToolRelation,
} from "./experiment-trace-model.js";

interface LaneDefinition {
  id: string;
  origin: "observed" | "execute";
  startCheckpointDigest?: string;
  harnessId?: string;
  runtime?: { profile: string; model: string };
  identity?: { harnessId?: string; profile?: string; model?: string };
}

interface ExperimentPreview {
  manifest: {
    lanes: LaneDefinition[];
    contrasts: Array<{ id: string; lanes: string[] }>;
    task: { prompt: string };
  };
  checkpoint: { digest: string; plan: string };
  contrasts: Array<{
    id: string;
    lanes: string[];
    attribution: { mode: string; axis?: string; detail: string };
  }>;
  observedEvents: Record<string, unknown[]>;
}

interface LaneTrace {
  status: "history" | "idle" | "preparing" | "running" | "finished" | "failed" | "cancelled";
  calls: ExperimentToolCall[];
  eventCount: number;
  detail?: string;
}

interface StreamEvent {
  type: string;
  experimentId: string;
  laneId: string | null;
  runId: string | null;
  detail?: string;
  event?: unknown;
  compareSet?: {
    contrasts: Array<{ id: string; lanes: string[]; status: string; reason: string }>;
  };
}

interface Selection {
  laneId: string;
  callId: string;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; detail: string }
  | { phase: "ready"; preview: ExperimentPreview };

export function ExperimentView(props: { navigation?: ReactNode } = {}): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [lanes, setLanes] = useState<Record<string, LaneTrace>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [compareSet, setCompareSet] = useState<StreamEvent["compareSet"]>();
  const [railCollapsed, setRailCollapsed] = useState(
    () => globalThis.matchMedia?.("(max-width: 760px)").matches ?? false,
  );
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/experiment");
        const payload = await response.json() as ExperimentPreview & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `Experiment request failed (${response.status}).`);
        if (cancelled) return;
        setLoad({ phase: "ready", preview: payload });
        const initial: Record<string, LaneTrace> = {};
        for (const lane of payload.manifest.lanes) {
          const history = lane.origin === "observed"
            ? foldObservedEvents(lane.id, payload.observedEvents[lane.id] ?? [])
            : [];
          initial[lane.id] = {
            status: lane.origin === "observed" ? "history" : "idle",
            calls: history,
            eventCount: payload.observedEvents[lane.id]?.length ?? 0,
          };
        }
        setLanes(initial);
        const firstHistory = payload.manifest.lanes
          .map((lane) => initial[lane.id]?.calls[0])
          .find((call): call is ExperimentToolCall => call !== undefined);
        if (firstHistory) setSelection({ laneId: firstHistory.laneId, callId: firstHistory.id });
      } catch (error) {
        if (!cancelled) setLoad({ phase: "error", detail: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(max-width: 760px)");
    if (media === undefined) return;
    const syncRail = (event: MediaQueryListEvent): void => setRailCollapsed(event.matches);
    media.addEventListener("change", syncRail);
    return () => media.removeEventListener("change", syncRail);
  }, []);

  const selectedCall = selection === null ? undefined : lanes[selection.laneId]?.calls
    .find((call) => call.id === selection.callId);
  const relations = useMemo(() => {
    const result = new Map<string, RelatedToolCall>();
    if (selectedCall === undefined) return result;
    const source = lanes[selectedCall.laneId]?.calls ?? [];
    for (const [laneId, lane] of Object.entries(lanes)) {
      result.set(laneId, laneId === selectedCall.laneId
        ? { relation: "exact", score: 100, call: selectedCall, basis: "selected call" }
        : relatedCallFor(selectedCall, source, lane.calls));
    }
    return result;
  }, [lanes, selectedCall]);

  async function runExperiment(): Promise<void> {
    const nextId = `exp_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    const controller = new AbortController();
    abortRef.current = controller;
    setExperimentId(nextId);
    setRunning(true);
    setCompareSet(undefined);
    setLanes((current) => Object.fromEntries(Object.entries(current).map(([laneId, lane]) => [
      laneId,
      lane.status === "history" ? lane : { status: "idle", calls: [], eventCount: 0 },
    ])));
    try {
      const response = await fetch("api/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experimentId: nextId }),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `Experiment start failed (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
          if (data) applyStreamEvent(JSON.parse(data) as StreamEvent);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setLanes((current) => Object.fromEntries(Object.entries(current).map(([laneId, lane]) => [
          laneId,
          lane.status === "running" || lane.status === "preparing"
            ? { ...lane, status: "failed", detail: error instanceof Error ? error.message : String(error) }
            : lane,
        ])));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function applyStreamEvent(event: StreamEvent): void {
    if (event.compareSet) setCompareSet(event.compareSet);
    if (event.laneId === null) return;
    setLanes((current) => {
      const lane = current[event.laneId!] ?? { status: "idle", calls: [], eventCount: 0 };
      const next = applyLaneEvent(lane, event);
      return { ...current, [event.laneId!]: next };
    });
  }

  async function cancelExperiment(): Promise<void> {
    if (experimentId === null) return;
    await fetch(`api/experiment/${encodeURIComponent(experimentId)}`, { method: "DELETE" });
    abortRef.current?.abort();
    setRunning(false);
    setLanes((current) => Object.fromEntries(Object.entries(current).map(([laneId, lane]) => [
      laneId,
      lane.status === "running" || lane.status === "preparing" ? { ...lane, status: "cancelled" } : lane,
    ])));
  }

  if (load.phase === "loading") return <p>Loading checkpoint experiment…</p>;
  if (load.phase === "error") return <p className="warning">Cannot load experiment: {load.detail}</p>;
  const { preview } = load;
  const totalCalls = Object.values(lanes).reduce((count, lane) => count + lane.calls.length, 0);
  const resultRows = compareSet?.contrasts ?? preview.contrasts.map((item) => ({
    id: item.id,
    lanes: item.lanes,
    status: "not-run",
    reason: item.attribution.detail,
  }));
  return (
    <section className={`experiment-shell${railCollapsed ? " rail-collapsed" : ""}`}>
      <aside className="experiment-rail" aria-label="Experiment context">
        <div className="experiment-brand">
          <div className="brand-copy"><strong>Harness Studio</strong><span>Checkpoint experiment</span></div>
          <button
            className="rail-toggle"
            type="button"
            aria-label={railCollapsed ? "Show experiment context" : "Hide experiment context"}
            aria-expanded={!railCollapsed}
            onClick={() => setRailCollapsed((current) => !current)}
          ><span className="hide-label">Hide</span><span className="show-label">Show setup</span></button>
        </div>
        <div className="rail-content">
          {props.navigation}
          <section className="rail-section checkpoint-section">
            <div className="rail-heading"><strong>Checkpoint</strong><span>shared start</span></div>
            <code title={preview.checkpoint.digest}>{shortDigest(preview.checkpoint.digest)}</code>
            <p title={preview.checkpoint.plan}>{preview.checkpoint.plan}</p>
          </section>
          <section className="rail-section task-section">
            <div className="rail-heading"><strong>Task</strong><span>all lanes</span></div>
            <p title={preview.manifest.task.prompt}>{preview.manifest.task.prompt}</p>
          </section>
          <section className="rail-section">
            <div className="rail-heading"><strong>Lanes</strong><span>{preview.manifest.lanes.length}</span></div>
            <ol className="rail-lanes">
              {preview.manifest.lanes.map((definition) => {
                const lane = lanes[definition.id] ?? { status: "idle", calls: [], eventCount: 0 };
                return <li key={definition.id}>
                  <span className={`rail-lane-dot status-${lane.status}`} />
                  <span><strong>{definition.id}</strong><small>{definition.origin === "observed" ? "recorded trajectory" : definition.runtime?.profile ?? "fresh lane"}</small></span>
                  <em>{lane.calls.length}</em>
                </li>;
              })}
            </ol>
          </section>
          <section className="rail-section">
            <div className="rail-heading"><strong>Contrasts</strong><span>{preview.contrasts.length}</span></div>
            <div className="contrast-preview" aria-label="Comparison attribution preview">
              {preview.contrasts.map((contrast) => (
                <span key={contrast.id} className={`contrast-chip mode-${contrast.attribution.mode}`} title={contrast.attribution.detail}>
                  <b>{contrast.id}</b>
                  <small>{contrast.attribution.mode === "attributable" ? contrast.attribution.axis : "descriptive"}</small>
                </span>
              ))}
            </div>
          </section>
        </div>
        <footer className="rail-footer">
          <div><strong>{running ? "Experiment running" : `${totalCalls} tool calls`}</strong><span>{experimentId ? shortDigest(experimentId) : "ready to compare"}</span></div>
          {running ? (
            <button className="secondary" onClick={() => void cancelExperiment()}>Cancel</button>
          ) : (
            <button onClick={() => void runExperiment()}>Run fresh lanes</button>
          )}
        </footer>
      </aside>

      <div className="experiment-workspace">
        <header className="experiment-workspace-header">
          <nav className="workspace-breadcrumb" aria-label="Experiment breadcrumb"><span>Harness Studio</span><i>/</i><strong>ACP Compare</strong></nav>
          <div className="workspace-header-meta">
            <div className="scope-metrics" aria-label="Experiment metrics">
              <span className="metric"><strong>{totalCalls}</strong><span>calls</span></span>
              <span className="metric"><strong>{preview.manifest.lanes.length}</strong><span>lanes</span></span>
              <span className="metric"><strong>{preview.manifest.contrasts.length}</strong><span>contrasts</span></span>
            </div>
            <span className="window-badge" title={preview.checkpoint.digest}>{shortDigest(preview.checkpoint.digest)}</span>
          </div>
        </header>

        <div className="experiment-workspace-scroll">
          <section className="experiment-workbench">
            <header className="experiment-workbench-head">
              <div>
                <small>Live ACP tool paths</small>
                <h2>{selectedCall === undefined ? "Select a tool call to compare its path" : `${selectedCall.name} · ${normalizeToolCall(selectedCall).resource ?? "No resource key"}`}</h2>
                <p>{selectedCall === undefined ? "Three lanes share one checkpoint and task." : "Related calls are evidence links, not causal attribution."}</p>
              </div>
              <span className={`live-state${running ? " running" : ""}`}><i />{running ? "streaming" : "ready"}</span>
            </header>

            <div className="trace-matrix" role="region" aria-label="Three lane tool trace comparison" tabIndex={0}>
              {preview.manifest.lanes.map((definition) => {
                const lane = lanes[definition.id] ?? { status: "idle", calls: [], eventCount: 0 };
                const relation = relations.get(definition.id);
                return (
                  <LaneColumn
                    key={definition.id}
                    definition={definition}
                    lane={lane}
                    relation={relation}
                    selectedCall={selectedCall}
                    onSelect={(call) => setSelection({ laneId: call.laneId, callId: call.id })}
                  />
                );
              })}
            </div>

            {selectedCall !== undefined && (
              <section className="selection-inspector" aria-label="Selected tool chain comparison">
                <div className="inspector-heading">
                  <small>Local chain</small>
                  <strong>Previous → selected → next</strong>
                </div>
                <div className="chain-grid">
                  {preview.manifest.lanes.map((definition) => {
                    const relation = relations.get(definition.id);
                    const matched = relation?.call;
                    const chain = matched ? localToolChain(lanes[definition.id]?.calls ?? [], matched.id) : [];
                    return (
                      <div key={definition.id} className="chain-lane">
                        <div><strong>{definition.id}</strong><span className={`relation relation-${relation?.relation ?? "none"}`}>
                          {relationLabel(relation?.relation ?? "none")}</span></div>
                        {chain.length === 0 ? <p>No counterpart</p> : (
                          <ol>{chain.map((call) => (
                            <li key={call.id} className={call.id === matched?.id ? "chain-selected" : ""}>
                              <b>{call.name}</b><span>{normalizeToolCall(call).resource ?? "no resource"}</span>
                            </li>
                          ))}</ol>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="contrast-results">
              <div className="section-heading"><small>Results</small><h3>One verdict per contrast</h3></div>
              <div className="result-grid">
                {resultRows.map((contrast) => (
                  <article key={contrast.id} className="result-card">
                    <span className={`result-status status-${contrast.status}`}>{contrast.status}</span>
                    <strong>{contrast.id}</strong>
                    <span>{contrast.lanes.join(" vs ")}</span>
                    <small title={contrast.reason}>{contrast.reason}</small>
                  </article>
                ))}
              </div>
            </section>
          </section>
        </div>
      </div>
    </section>
  );
}

function LaneColumn(props: {
  definition: LaneDefinition;
  lane: LaneTrace;
  relation?: RelatedToolCall;
  selectedCall?: ExperimentToolCall;
  onSelect: (call: ExperimentToolCall) => void;
}): React.JSX.Element {
  const identity = props.definition.origin === "observed" ? props.definition.identity : {
    harnessId: props.definition.harnessId,
    profile: props.definition.runtime?.profile,
    model: props.definition.runtime?.model,
  };
  return (
    <article className="lane-column">
      <header>
        <div className="lane-title">
          <small>{props.definition.origin === "observed" ? "Recorded" : "Fresh"}</small>
          <h3>{props.definition.id}</h3>
          <span title={`${identity?.harnessId ?? "unknown"} · ${identity?.profile ?? "unknown"} · ${identity?.model ?? "unknown"}`}>
            {identity?.harnessId ?? "unknown"} · {identity?.profile ?? "unknown"} · {identity?.model ?? "unknown"}
          </span>
        </div>
        <span className={`lane-status lane-status-${props.lane.status}`} aria-live="polite">{props.lane.status}</span>
      </header>
      <div className="lane-relation">
        <span className={`relation relation-${props.relation?.relation ?? "none"}`}>
          {props.selectedCall === undefined ? "No selection" : relationLabel(props.relation?.relation ?? "none")}
        </span>
        <small title={props.definition.origin === "observed" && props.definition.startCheckpointDigest === undefined
          ? "Starting checkpoint was not recorded; this lane is contextual evidence."
          : props.relation?.basis ?? `${props.lane.eventCount} ACP events`}>{props.definition.origin === "observed" && props.definition.startCheckpointDigest === undefined
          ? "checkpoint unknown · contextual"
          : props.relation?.basis ?? `${props.lane.eventCount} ACP events`}</small>
      </div>
      <ol className="tool-trace">
        {props.lane.calls.length === 0 ? <li className="trace-empty">Waiting for tool calls…</li> : props.lane.calls.map((call) => {
          const isSelected = props.selectedCall?.id === call.id && props.selectedCall.laneId === call.laneId;
          const isRelated = props.relation?.call?.id === call.id;
          const normalized = normalizeToolCall(call);
          return (
            <li key={call.id}>
              <button
                className={`${isSelected ? "selected " : ""}${isRelated ? "related" : ""}`.trim()}
                onClick={() => props.onSelect(call)}
                aria-pressed={isSelected}
              >
                <span className="tool-sequence">{String(call.sequence + 1).padStart(2, "0")}</span>
                <span className="tool-summary"><strong>{call.name}</strong><small>{normalized.resource ?? "No resource key"}</small></span>
                <span className={`call-status call-status-${call.status}`}>{call.status}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {props.lane.detail && <p className="lane-detail">{props.lane.detail}</p>}
    </article>
  );
}

function applyLaneEvent(lane: LaneTrace, wrapper: StreamEvent): LaneTrace {
  const status = wrapper.type === "lane-preparing" || wrapper.type === "lane-ready" ? "preparing"
    : wrapper.type === "lane-started" ? "running"
    : wrapper.type === "lane-finished" ? "finished"
    : wrapper.type === "lane-failed" ? "failed"
    : lane.status;
  if (wrapper.type !== "lane-event") return {
    ...lane,
    status,
    ...(wrapper.type === "lane-failed" && wrapper.detail ? { detail: wrapper.detail } : {}),
  };
  const event = runEvent(wrapper.event);
  if (event === null) return { ...lane, eventCount: lane.eventCount + 1 };
  return {
    ...lane,
    status,
    eventCount: lane.eventCount + 1,
    calls: foldRunEvent(lane.calls, wrapper.laneId!, wrapper.runId ?? "run", event),
  };
}

function foldObservedEvents(laneId: string, events: unknown[]): ExperimentToolCall[] {
  let calls: ExperimentToolCall[] = [];
  for (const item of events) {
    for (const event of observedRunEvents(item)) {
      calls = foldRunEvent(calls, laneId, `observed:${laneId}`, event);
    }
  }
  return calls;
}

function observedRunEvents(value: unknown): Array<Record<string, unknown>> {
  const record = runEvent(value);
  if (record === null) return [];
  if (record.type === "tool.requested" && typeof record.toolInvocationId === "string") {
    const input = typeof record.filePath === "string" ? { file_path: record.filePath }
      : typeof record.commandText === "string" ? { command: record.commandText }
      : {};
    return [{
      type: "tool-call-started",
      toolCallId: record.toolInvocationId,
      toolName: typeof record.toolName === "string" ? record.toolName : "Tool",
      input,
    }];
  }
  if (record.type === "tool.execution.finished" && typeof record.toolInvocationId === "string") {
    return [{ type: "tool-call-result", toolCallId: record.toolInvocationId }];
  }
  if (record.type === "tool-call-started" || record.type === "tool-call-result" || record.type === "run-finished") {
    return [record];
  }
  const wrapped = runEvent(record.event);
  if (wrapped !== null) return [wrapped];
  const message = objectValue(record.message) ?? objectValue(objectValue(record.data)?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const item of content) {
    const part = objectValue(item);
    if (part === null) continue;
    if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
      events.push({ type: "tool-call-started", toolCallId: part.id, toolName: part.name, input: part.input });
      continue;
    }
    const resultId = part?.type === "tool_result"
      ? part.tool_use_id ?? part.toolUseId ?? part.id
      : undefined;
    if (typeof resultId === "string") {
      events.push({ type: "tool-call-result", toolCallId: resultId, content: part.content, isError: part.is_error === true });
    }
  }
  return events;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function foldRunEvent(
  calls: ExperimentToolCall[],
  laneId: string,
  runId: string,
  event: Record<string, unknown>,
): ExperimentToolCall[] {
  if (event.type === "tool-call-started" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    return [...calls, {
      laneId,
      runId,
      id: `${runId}:${event.toolCallId}`,
      sequence: calls.length,
      name: event.toolName,
      input: event.input,
      status: "running",
    }];
  }
  if (event.type === "tool-call-result" && typeof event.toolCallId === "string") {
    return calls.map((call) => call.id === `${runId}:${event.toolCallId}` ? {
      ...call,
      status: event.isError === true ? "failed" : "completed",
      ...(typeof event.content === "string" ? { result: event.content } : {}),
    } : call);
  }
  if (event.type === "run-finished") {
    return calls.map((call) => call.status === "running" ? { ...call, status: "result-unavailable" } : call);
  }
  return calls;
}

function runEvent(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"
    ? value as Record<string, unknown>
    : null;
}

function relationLabel(relation: ToolRelation): string {
  switch (relation) {
    case "exact": return "Exact match";
    case "same-resource": return "Same resource";
    case "same-tool": return "Same tool";
    case "none": return "No match";
  }
}

function shortDigest(digest: string): string {
  return digest.length > 22 ? `${digest.slice(0, 17)}…${digest.slice(-4)}` : digest;
}
