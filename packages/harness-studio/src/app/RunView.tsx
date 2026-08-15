import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { AguiEvent } from "@qoder-ai/harness-ui";
import { applyAguiEvent, initialRunState, type AguiRunState, type TimelineItem } from "./agui-store.js";
import { createSseParser } from "./sse-client.js";
import { describeToolPayload } from "./tool-call-model.js";

/** Post one AG-UI run and fold the SSE stream into state updates. */
async function streamRun(
  endpoint: string,
  prompt: string,
  onUpdate: (updater: (state: AguiRunState) => AguiRunState) => void,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: `thread_${Date.now()}`,
      runId: `run_${Date.now()}`,
      messages: [{ id: "m1", role: "user", content: prompt }],
    }),
  });
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Run request failed (${response.status}): ${detail}`);
  }
  const apply = (event: AguiEvent): void => onUpdate((state) => applyAguiEvent(state, event));
  const parser = createSseParser(apply);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
}

type MessageTimelineItem = Extract<TimelineItem, { kind: "message" }>;
type ToolCallTimelineItem = Extract<TimelineItem, { kind: "tool-call" }>;

const MessageEntry = memo(function MessageEntry({ item }: { item: MessageTimelineItem }): React.JSX.Element {
  return (
    <div className="entry message">
      <span className="entry-tag">Assistant</span>
      <pre>{item.text}{item.complete ? "" : " ▌"}</pre>
    </div>
  );
});

const ToolCallEntry = memo(function ToolCallEntry({ item }: { item: ToolCallTimelineItem }): React.JSX.Element {
  const argumentsView = useMemo(
    () => describeToolPayload(item.argsText, "No arguments retained"),
    [item.argsText],
  );
  const resultView = useMemo(
    () => item.resultText === undefined
      ? undefined
      : describeToolPayload(item.resultText, "Empty result"),
    [item.resultText],
  );
  return (
    <details className={`tool-card status-${item.status}`}>
      <summary>
        <span className="tool-icon" aria-hidden="true">⌁</span>
        <span className="tool-title">
          <small>Tool call</small>
          <strong>{item.name}</strong>
          <code>{argumentsView.summary}</code>
        </span>
        <span className="tool-status" aria-live="polite">{toolStatusLabel(item.status)}</span>
        <span className="tool-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-detail">
        <section>
          <h4>Arguments</h4>
          <pre className={argumentsView.structured ? "structured" : ""}>{argumentsView.formatted}</pre>
        </section>
        <section>
          <h4>Result</h4>
          {resultView ? (
            <>
              {item.resultTruncated ? (
                <p className="tool-notice">
                  Result truncated{item.resultOriginalBytes === undefined
                    ? ""
                    : ` from ${item.resultOriginalBytes.toLocaleString()} bytes`}.
                </p>
              ) : null}
              <pre className={resultView.structured ? "structured" : ""}>{resultView.formatted}</pre>
            </>
          ) : (
            <p className="tool-empty">
              {item.status === "running" || item.status === "preparing"
                ? "Waiting for the tool result…"
                : item.status === "result-unavailable"
                  ? "The run finished without a retained result payload."
                  : "No result payload was retained."}
            </p>
          )}
        </section>
        <footer>
          <span>Call ID</span>
          <code title={item.id}>{item.id}</code>
        </footer>
      </div>
    </details>
  );
});

const TimelineEntry = memo(function TimelineEntry({ item }: { item: TimelineItem }): React.JSX.Element {
  return item.kind === "message" ? <MessageEntry item={item} /> : <ToolCallEntry item={item} />;
});

function toolStatusLabel(status: ToolCallTimelineItem["status"]): string {
  switch (status) {
    case "preparing": return "Preparing";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "result-unavailable": return "Result unavailable";
    case "interrupted": return "Interrupted";
  }
}

export function RunView({ aguiEndpoint }: { aguiEndpoint: string }): React.JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<AguiRunState>(initialRunState);
  const busy = useRef(false);
  const toolCount = state.timeline.filter((item) => item.kind === "tool-call").length;

  const start = useCallback(async () => {
    if (busy.current || prompt.trim().length === 0) {
      return;
    }
    busy.current = true;
    setState({ ...initialRunState(), status: "running" });
    try {
      await streamRun(aguiEndpoint, prompt, setState);
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      busy.current = false;
    }
  }, [aguiEndpoint, prompt]);

  return (
    <section className="run-view">
      <div className="run-controls">
        <textarea
          value={prompt}
          placeholder="Task prompt for the harness run…"
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
        />
        <button type="button" onClick={() => void start()} disabled={state.status === "running"}>
          {state.status === "running" ? "Running…" : "Run harness"}
        </button>
      </div>
      <p className="status-line run-status">
        <span className={`status-dot status-${state.status}`} aria-hidden="true" />
        status: <strong>{state.status}</strong>
        {state.runId ? <span> · run {state.runId}</span> : null}
      </p>
      {state.warnings.map((warning, index) => (
        <p className="warning" key={index}>⚠ {warning}</p>
      ))}
      {state.error ? <p className="error">✖ {state.error}</p> : null}
      <section className="activity-panel" aria-label="Live agent activity">
        <header className="activity-panel-head">
          <div>
            <small>Live trace</small>
            <h2>Agent activity</h2>
          </div>
          <span>{toolCount} tool call{toolCount === 1 ? "" : "s"}</span>
        </header>
        <div className="timeline">
          {state.timeline.length > 0 ? state.timeline.map((item) => (
            <TimelineEntry item={item} key={`${item.kind}:${item.id}`} />
          )) : (
            <p className="activity-empty">Messages and expandable tool calls will appear here while the harness runs.</p>
          )}
        </div>
      </section>
      {state.result !== undefined ? (
        <details>
          <summary>Run result</summary>
          <pre>{JSON.stringify(state.result, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}
