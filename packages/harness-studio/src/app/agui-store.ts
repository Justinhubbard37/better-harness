import {
  HARNESS_TOOL_RESULT_META_EVENT,
  type AguiEvent,
  type HarnessToolResultMeta,
} from "@qoder-ai/harness-ui/protocol";

export type TimelineItem =
  | { kind: "message"; id: string; text: string; complete: boolean }
  | {
      kind: "tool-call";
      id: string;
      name: string;
      argsText: string;
      status: "preparing" | "running" | "completed" | "failed" | "result-unavailable" | "interrupted";
      resultText?: string;
      resultMessageId?: string;
      resultTruncated?: boolean;
      resultOriginalBytes?: number;
    };

export interface AguiRunState {
  status: "idle" | "running" | "finished" | "error";
  threadId?: string;
  runId?: string;
  timeline: TimelineItem[];
  warnings: string[];
  error?: string;
  result?: unknown;
}

export function initialRunState(): AguiRunState {
  return { status: "idle", timeline: [], warnings: [] };
}

/**
 * Fold one AG-UI event into the run view state. Pure and immutable so the
 * React view is a direct render of `reduce(events)` and the behaviour is
 * testable without a DOM.
 */
export function applyAguiEvent(state: AguiRunState, event: AguiEvent): AguiRunState {
  switch (event.type) {
    case "RUN_STARTED":
      return { ...initialRunState(), status: "running", threadId: event.threadId, runId: event.runId };
    case "TEXT_MESSAGE_START":
      return appendItem(state, { kind: "message", id: event.messageId, text: "", complete: false });
    case "TEXT_MESSAGE_CONTENT":
      return patchItem(state, "message", event.messageId, (item) => ({
        ...item,
        text: item.text + event.delta,
      }));
    case "TEXT_MESSAGE_END":
      return patchItem(state, "message", event.messageId, (item) => ({ ...item, complete: true }));
    case "TOOL_CALL_START":
      return appendItem(state, {
        kind: "tool-call",
        id: event.toolCallId,
        name: event.toolCallName,
        argsText: "",
        status: "preparing",
      });
    case "TOOL_CALL_ARGS":
      return patchItem(state, "tool-call", event.toolCallId, (item) => ({
        ...item,
        argsText: item.argsText + event.delta,
      }));
    case "TOOL_CALL_END":
      return patchItem(state, "tool-call", event.toolCallId, (item) => ({ ...item, status: "running" }));
    case "TOOL_CALL_RESULT":
      return patchItem(state, "tool-call", event.toolCallId, (item) => ({
        ...item,
        status: "completed",
        resultText: event.content,
        resultMessageId: event.messageId,
      }));
    case "CUSTOM": {
      if (event.name === "harness.warning" && typeof event.value === "string") {
        return { ...state, warnings: [...state.warnings, event.value] };
      }
      const metadata = event.name === HARNESS_TOOL_RESULT_META_EVENT
        ? parseToolResultMeta(event.value)
        : undefined;
      return metadata === undefined
        ? state
        : patchItem(state, "tool-call", metadata.toolCallId, (item) => ({
            ...item,
            ...(metadata.isError ? { status: "failed" as const } : {}),
            ...(metadata.truncated ? { resultTruncated: true } : {}),
            ...(metadata.originalBytes !== undefined ? { resultOriginalBytes: metadata.originalBytes } : {}),
          }));
    }
    case "RUN_ERROR":
      return settleTools({ ...state, status: "error", error: event.message }, "interrupted");
    case "RUN_FINISHED":
      return settleTools({
        ...state,
        status: "finished",
        ...(event.result !== undefined ? { result: event.result } : {}),
      }, "result-unavailable");
  }
}

function settleTools(
  state: AguiRunState,
  terminalStatus: "result-unavailable" | "interrupted",
): AguiRunState {
  return {
    ...state,
    timeline: state.timeline.map((item) =>
      item.kind === "tool-call" && (item.status === "preparing" || item.status === "running")
        ? { ...item, status: terminalStatus }
        : item,
    ),
  };
}

function parseToolResultMeta(value: unknown): HarnessToolResultMeta | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.toolCallId !== "string" ||
    typeof metadata.isError !== "boolean" ||
    typeof metadata.truncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    toolCallId: metadata.toolCallId,
    isError: metadata.isError,
    truncated: metadata.truncated,
    ...(typeof metadata.originalBytes === "number" ? { originalBytes: metadata.originalBytes } : {}),
  };
}

function appendItem(state: AguiRunState, item: TimelineItem): AguiRunState {
  return { ...state, timeline: [...state.timeline, item] };
}

function patchItem<Kind extends TimelineItem["kind"]>(
  state: AguiRunState,
  kind: Kind,
  id: string,
  update: (item: Extract<TimelineItem, { kind: Kind }>) => TimelineItem,
): AguiRunState {
  return {
    ...state,
    timeline: state.timeline.map((item) =>
      item.kind === kind && item.id === id
        ? update(item as Extract<TimelineItem, { kind: Kind }>)
        : item,
    ),
  };
}
