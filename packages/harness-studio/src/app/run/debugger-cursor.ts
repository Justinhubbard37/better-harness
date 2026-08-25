import type {
  DebuggerCursor,
  DebuggerEvent,
  DebuggerFileChange,
  DebuggerSession,
  DebuggerToolCall,
  StopConditionState,
} from "../../contracts/debugger-session.js";

export const DEFAULT_STOP_CONDITIONS: StopConditionState = {
  changes: true,
  failures: true,
  permissions: true,
  tests: true,
  responses: false,
};

export const DEFAULT_DEBUGGER_CURSOR: DebuggerCursor = { eventId: "change-workbench" };

export function defaultCursorForSession(session: DebuggerSession, enabled: StopConditionState = DEFAULT_STOP_CONDITIONS): DebuggerCursor {
  const stopped = session.events.find((event) => event.stopConditions.some((condition) => enabled[condition]));
  return { eventId: stopped?.id ?? session.events[0]?.id ?? "prompt" };
}

export function eventForCursor(session: DebuggerSession, cursor: DebuggerCursor): DebuggerEvent {
  return session.events.find((event) => event.id === cursor.eventId) ?? session.events[0]!;
}

export function toolForCursor(session: DebuggerSession, cursor: DebuggerCursor): DebuggerToolCall | undefined {
  if (cursor.toolCallId === undefined) return undefined;
  return eventForCursor(session, cursor).toolCalls?.find((tool) => tool.id === cursor.toolCallId);
}

export function cursorNodeId(cursor: DebuggerCursor): string {
  return cursor.toolCallId ?? cursor.eventId;
}

export function cursorForNode(session: DebuggerSession, nodeId: string): DebuggerCursor | undefined {
  const event = session.events.find((candidate) => candidate.id === nodeId);
  if (event !== undefined) return { eventId: event.id };
  for (const candidate of session.events) {
    if (candidate.toolCalls?.some((tool) => tool.id === nodeId)) return { eventId: candidate.id, toolCallId: nodeId };
  }
  return undefined;
}

export function nextStopCursor(
  session: DebuggerSession,
  cursor: DebuggerCursor,
  enabled: StopConditionState,
  direction: 1 | -1 = 1,
): DebuggerCursor {
  const current = Math.max(0, session.events.findIndex((event) => event.id === cursor.eventId));
  for (let index = current + direction; index >= 0 && index < session.events.length; index += direction) {
    const event = session.events[index]!;
    if (event.stopConditions.some((condition) => enabled[condition])) return { eventId: event.id };
  }
  return cursor;
}

export function stepIntoCursor(session: DebuggerSession, cursor: DebuggerCursor): DebuggerCursor {
  const event = eventForCursor(session, cursor);
  const first = event.toolCalls?.[0];
  return first === undefined ? cursor : { eventId: event.id, toolCallId: first.id };
}

export function stepOverCursor(session: DebuggerSession, cursor: DebuggerCursor): DebuggerCursor {
  const event = eventForCursor(session, cursor);
  if (cursor.toolCallId !== undefined && event.toolCalls !== undefined) {
    const current = event.toolCalls.findIndex((tool) => tool.id === cursor.toolCallId);
    const next = event.toolCalls[current + 1];
    return next === undefined ? { eventId: event.id } : { eventId: event.id, toolCallId: next.id };
  }
  const eventIndex = session.events.findIndex((candidate) => candidate.id === event.id);
  const nextEvent = session.events[eventIndex + 1];
  return nextEvent === undefined ? cursor : { eventId: nextEvent.id };
}

export function stepOutCursor(cursor: DebuggerCursor): DebuggerCursor {
  return cursor.toolCallId === undefined ? cursor : { eventId: cursor.eventId };
}

export function previousStateCursor(session: DebuggerSession, cursor: DebuggerCursor): DebuggerCursor {
  const event = eventForCursor(session, cursor);
  if (cursor.toolCallId !== undefined && event.toolCalls !== undefined) {
    const current = event.toolCalls.findIndex((tool) => tool.id === cursor.toolCallId);
    const previous = event.toolCalls[current - 1];
    return previous === undefined ? { eventId: event.id } : { eventId: event.id, toolCallId: previous.id };
  }
  const eventIndex = session.events.findIndex((candidate) => candidate.id === event.id);
  const previous = session.events[eventIndex - 1];
  return previous === undefined ? cursor : { eventId: previous.id };
}

export function priorStopEvent(
  session: DebuggerSession,
  cursor: DebuggerCursor,
  enabled: StopConditionState = DEFAULT_STOP_CONDITIONS,
): DebuggerEvent | undefined {
  const previous = nextStopCursor(session, cursor, enabled, -1);
  if (previous.eventId === cursor.eventId) return undefined;
  return eventForCursor(session, previous);
}

export function cumulativeFileChanges(session: DebuggerSession, cursor: DebuggerCursor): DebuggerFileChange[] {
  const selectedIndex = session.events.findIndex((event) => event.id === cursor.eventId);
  const latest = new Map<string, DebuggerFileChange>();
  session.events.slice(0, selectedIndex + 1).forEach((event) => event.fileChanges?.forEach((change) => latest.set(change.path, change)));
  return [...latest.values()];
}
