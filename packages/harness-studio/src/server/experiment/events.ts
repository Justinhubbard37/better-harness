import {
  foldCanonicalToolEvent,
  type CanonicalToolEvent,
  type ExperimentToolCall,
} from "../../contracts/experiment-stream-contract.js";

/**
 * Normalize provider-owned run evidence at the server boundary. The browser
 * receives only this small canonical event vocabulary.
 */
export function canonicalToolEvents(value: unknown): CanonicalToolEvent[] {
  const record = eventRecord(value);
  if (record === null) return [];
  if (record.type === "message-started" && typeof record.messageId === "string") {
    return [{ type: "assistant-message-started", messageId: record.messageId }];
  }
  if (record.type === "text-delta"
    && typeof record.messageId === "string"
    && typeof record.text === "string") {
    return [{ type: "assistant-text-delta", messageId: record.messageId, text: record.text }];
  }
  if (record.type === "message-finished" && typeof record.messageId === "string") {
    return [{ type: "assistant-message-finished", messageId: record.messageId }];
  }
  if (record.type === "tool.requested" && typeof record.toolInvocationId === "string") {
    const input = typeof record.filePath === "string"
      ? { file_path: record.filePath }
      : typeof record.commandText === "string"
        ? { command: record.commandText }
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
  if (record.type === "tool-call-started"
    && typeof record.toolCallId === "string"
    && typeof record.toolName === "string") {
    return [{
      type: "tool-call-started",
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      ...(record.input === undefined ? {} : { input: record.input }),
    }];
  }
  if (record.type === "tool-call-result" && typeof record.toolCallId === "string") {
    return [{
      type: "tool-call-result",
      toolCallId: record.toolCallId,
      ...(record.content === undefined ? {} : { content: record.content }),
      ...(record.isError === true ? { isError: true } : {}),
    }];
  }
  if (record.type === "run-finished") return [{ type: "run-finished" }];
  if (record.type === "protocol-event" && record.protocol === "acp"
    && typeof record.direction === "string" && typeof record.method === "string") {
    const rpcId = typeof record.rpcId === "string" ? record.rpcId : undefined;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
    if (record.method === "session/request_permission" && rpcId !== undefined) {
      const payload = objectValue(record.payload);
      const params = objectValue(payload?.params);
      const toolCall = objectValue(params?.toolCall);
      const options = Array.isArray(params?.options)
        ? params.options.flatMap((value) => {
            const option = objectValue(value);
            return option !== null && typeof option.optionId === "string" && typeof option.name === "string"
              ? [{
                  optionId: option.optionId,
                  name: option.name,
                  ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
                }]
              : [];
          })
        : [];
      if (toolCall !== null && typeof toolCall.toolCallId === "string" && options.length > 0) {
        return [{
          type: "permission-requested",
          protocol: "acp",
          requestId: rpcId,
          toolCallId: toolCall.toolCallId,
          title: typeof toolCall.title === "string" ? toolCall.title : "ACP tool permission",
          ...(sessionId === undefined ? {} : { sessionId }),
          options,
        }];
      }
    }
    return [{
      type: "protocol-observed",
      protocol: "acp",
      direction: record.direction,
      method: record.method,
      ...(rpcId === undefined ? {} : { rpcId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }];
  }
  const wrapped = eventRecord(record.event);
  if (wrapped !== null) return canonicalToolEvents(wrapped);

  const message = objectValue(record.message) ?? objectValue(objectValue(record.data)?.message);
  if (!Array.isArray(message?.content)) return [];
  const events: CanonicalToolEvent[] = [];
  for (const item of message.content) {
    const part = objectValue(item);
    if (part === null) continue;
    if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
      events.push({
        type: "tool-call-started",
        toolCallId: part.id,
        toolName: part.name,
        ...(part.input === undefined ? {} : { input: part.input }),
      });
      continue;
    }
    const resultId = part.type === "tool_result"
      ? part.tool_use_id ?? part.toolUseId ?? part.id
      : undefined;
    if (typeof resultId === "string") {
      events.push({
        type: "tool-call-result",
        toolCallId: resultId,
        ...(part.content === undefined ? {} : { content: part.content }),
        ...(part.is_error === true ? { isError: true } : {}),
      });
    }
  }
  return events;
}

export function projectObservedCalls(laneId: string, values: readonly unknown[]): ExperimentToolCall[] {
  let calls: ExperimentToolCall[] = [];
  const runId = `observed:${laneId}`;
  for (const value of values) {
    for (const event of canonicalToolEvents(value)) {
      calls = foldCanonicalToolEvent(calls, laneId, runId, event);
    }
  }
  return calls;
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  const record = objectValue(value);
  return record !== null && typeof record.type === "string" ? record : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
