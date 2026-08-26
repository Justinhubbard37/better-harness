export interface ExperimentToolCall {
  laneId: string;
  runId: string;
  id: string;
  sequence: number;
  name: string;
  input?: unknown;
  status: "running" | "completed" | "failed" | "result-unavailable";
  result?: string;
}

export type CanonicalToolEvent =
  | { type: "assistant-message-started"; messageId: string }
  | { type: "assistant-text-delta"; messageId: string; text: string }
  | { type: "assistant-message-finished"; messageId: string }
  | { type: "tool-call-started"; toolCallId: string; toolName: string; input?: unknown }
  | { type: "tool-call-result"; toolCallId: string; content?: unknown; isError?: boolean }
  | {
      type: "protocol-observed";
      protocol: "acp";
      direction: string;
      method: string;
      rpcId?: string;
      sessionId?: string;
    }
  | {
      type: "permission-requested";
      protocol: "acp";
      requestId: string;
      toolCallId: string;
      title: string;
      sessionId?: string;
      options: Array<{ optionId: string; name: string; kind?: string }>;
    }
  | { type: "run-finished" };

export function foldCanonicalToolEvent(
  calls: readonly ExperimentToolCall[],
  laneId: string,
  runId: string,
  event: CanonicalToolEvent,
): ExperimentToolCall[] {
  if (event.type === "tool-call-started") {
    return [...calls, {
      laneId,
      runId,
      id: `${runId}:${event.toolCallId}`,
      sequence: calls.length,
      name: event.toolName,
      ...(event.input === undefined ? {} : { input: event.input }),
      status: "running",
    }];
  }
  if (event.type === "tool-call-result") {
    return calls.map((call) => call.id === `${runId}:${event.toolCallId}`
      ? {
          ...call,
          status: event.isError === true ? "failed" as const : "completed" as const,
          ...(typeof event.content === "string" ? { result: event.content } : {}),
        }
      : call);
  }
  if (event.type !== "run-finished") return [...calls];
  return calls.map((call) => call.status === "running" && call.runId === runId
    ? { ...call, status: "result-unavailable" as const }
    : call);
}
