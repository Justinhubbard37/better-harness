export const STOP_CONDITIONS = ["changes", "failures", "permissions", "tests", "responses"] as const;

export type StopCondition = typeof STOP_CONDITIONS[number];
export type DebuggerEventKind = "prompt" | "plan" | "explore" | "change" | "verify" | "response";
export type EvidenceLevel = "Exact" | "Correlated" | "Inferred";

export interface DebuggerToolCall {
  id: string;
  name: string;
  summary: string;
  input: string;
  output: string;
  duration: string;
  resource?: string;
}

export interface DebuggerFileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "modified" | "created" | "deleted";
}

export interface DebuggerDiff {
  path: string;
  beforeStart: number;
  before: string[];
  afterStart: number;
  after: string[];
}

export interface DebuggerValidation {
  command: string;
  status: "failed" | "passed";
  duration: string;
  summary: string;
  output: string[];
}

export interface DebuggerEvidenceLink {
  level: EvidenceLevel;
  label: string;
  detail: string;
}

export interface DebuggerRawAcp {
  direction: "Client → Agent" | "Agent → Client";
  method: string;
  rpcId: string;
  sessionId: string;
  toolCallId?: string;
  traceContext: string;
  payload: Record<string, unknown>;
}

export interface DebuggerEvent {
  id: string;
  kind: DebuggerEventKind;
  phase: string;
  title: string;
  summary: string;
  timestamp: string;
  relativeTime: string;
  stopConditions: StopCondition[];
  toolCalls?: DebuggerToolCall[];
  fileChanges?: DebuggerFileChange[];
  diff?: DebuggerDiff;
  validation?: DebuggerValidation;
  evidence: DebuggerEvidenceLink[];
  rawAcp: DebuggerRawAcp;
}

export interface DebuggerSession {
  id: string;
  name: string;
  agent: string;
  protocol: string;
  connection: string;
  mode: "Recorded sample";
  startedAt: string;
  finishedAt: string;
  events: DebuggerEvent[];
}

export interface DebuggerCursor {
  eventId: string;
  toolCallId?: string;
}

export type StopConditionState = Record<StopCondition, boolean>;

const sessionId = "session_replay_ui_7f3a";

function raw(
  direction: DebuggerRawAcp["direction"],
  method: string,
  rpcId: string,
  payload: Record<string, unknown>,
  toolCallId?: string,
): DebuggerRawAcp {
  return {
    direction,
    method,
    rpcId,
    sessionId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    traceContext: `00-4bf92f3577b34da6a3ce929d0e0e4736-${rpcId.padStart(16, "0")}-01`,
    payload,
  };
}

const exploreTools: DebuggerToolCall[] = [
  { id: "tool_read_workbench", name: "Read", summary: "Read workbench.js", input: '{"path":"scripts/harness-inspector/ui/workbench.js"}', output: "Retained 420 lines around the session renderer.", duration: "83 ms", resource: "scripts/harness-inspector/ui/workbench.js" },
  { id: "tool_read_studio_css", name: "Read", summary: "Read harness-studio.css", input: '{"path":"packages/harness-studio/src/app/index.html"}', output: "Retained the current Studio visual tokens and responsive rules.", duration: "62 ms", resource: "packages/harness-studio/src/app/index.html" },
  { id: "tool_read_replay", name: "Read", summary: "Read replay.js", input: '{"path":"scripts/harness-inspector/ui/workbench.js","line":1028}', output: "Located the retained evidence playback boundary.", duration: "51 ms", resource: "scripts/harness-inspector/ui/workbench.js" },
  { id: "tool_read_timeline", name: "Read", summary: "Read timeline.ts", input: '{"path":"packages/harness-studio/src/app/experiment-trace-model.ts"}', output: "Found the observable activity projection helpers.", duration: "66 ms", resource: "packages/harness-studio/src/app/experiment-trace-model.ts" },
  { id: "tool_read_app", name: "Read", summary: "Read App.tsx", input: '{"path":"packages/harness-studio/src/app/App.tsx"}', output: "Confirmed Compare, Run, and Results routing ownership.", duration: "39 ms", resource: "packages/harness-studio/src/app/App.tsx" },
  { id: "tool_search_cards", name: "Search", summary: "Search renderEventCard", input: '{"query":"renderEventCard","path":"scripts"}', output: "3 matches in Inspector presentation code.", duration: "121 ms" },
  { id: "tool_search_session", name: "Search", summary: "Search session detail", input: '{"query":"Session Detail|Session View","path":"docs"}', output: "11 matches across specs and Inspector documentation.", duration: "96 ms" },
  { id: "tool_search_timeline", name: "Search", summary: "Search timeline rail", input: '{"query":"timeline|rail","path":"packages/harness-studio"}', output: "27 matches in the Studio app and browser tests.", duration: "108 ms" },
  { id: "tool_inspect_reference", name: "Inspect image", summary: "Inspect ACP Debugger reference", input: '{"asset":"acp-debugger-reference.png"}', output: "Desktop IDE shell with synchronized tree, notebook, inspector, and minimap.", duration: "214 ms" },
];

export const SAMPLE_DEBUGGER_SESSION: DebuggerSession = {
  id: sessionId,
  name: "优化 Replay UI",
  agent: "qoder-cli · codex-1",
  protocol: "ACP v1",
  connection: "Connected",
  mode: "Recorded sample",
  startedAt: "03:14:21",
  finishedAt: "03:19:02",
  events: [
    {
      id: "prompt",
      kind: "prompt",
      phase: "Prompt",
      title: "User request",
      summary: "参考 Jupyter，优化 workbench.html 的 Session Detail 与 Harness Studio UI。",
      timestamp: "03:14:21",
      relativeTime: "+0s",
      stopConditions: [],
      evidence: [{ level: "Exact", label: "Conversation checkpoint", detail: "Prompt text retained in the recorded session." }],
      rawAcp: raw("Client → Agent", "session/prompt", "1", { text: "参考 Jupyter，优化 workbench.html 的 Session Detail 与 Harness Studio UI。" }),
    },
    {
      id: "plan",
      kind: "plan",
      phase: "Plan",
      title: "Plan revision 1",
      summary: "Inspect the existing session surfaces, map notebook hierarchy, implement the workbench, and verify interaction density.",
      timestamp: "03:14:22",
      relativeTime: "+1s",
      stopConditions: [],
      evidence: [
        { level: "Exact", label: "Agent response", detail: "Plan text is retained as an assistant update." },
        { level: "Inferred", label: "Plan grouping", detail: "The five displayed tasks are a presentation of the retained plan text." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "2", { kind: "plan", revision: 1, items: 5 }),
    },
    {
      id: "explore",
      kind: "explore",
      phase: "Explore",
      title: "Inspect the current UI",
      summary: "Read files ×5 · Search repository ×3 · Inspect image ×1",
      timestamp: "03:14:23",
      relativeTime: "+2s",
      stopConditions: [],
      toolCalls: exploreTools,
      evidence: [
        { level: "Exact", label: "9 tool calls", detail: "Each call id, input, result summary, and order is retained." },
        { level: "Inferred", label: "Explore phase", detail: "The phase label is derived from read, search, and image-inspection tools." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "3", { kind: "tool_call_group", count: 9, tools: ["Read", "Search", "Inspect image"] }),
    },
    {
      id: "change-workbench",
      kind: "change",
      phase: "Change",
      title: "Edit workbench.js",
      summary: "Replace independent event cards with semantic Notebook cells.",
      timestamp: "03:15:01",
      relativeTime: "+40s",
      stopConditions: ["changes"],
      fileChanges: [{ path: "scripts/harness-inspector/ui/workbench.js", additions: 48, deletions: 21, status: "modified" }],
      diff: {
        path: "scripts/harness-inspector/ui/workbench.js",
        beforeStart: 412,
        before: ["function renderEventCard(event) {", "  return `", "    <div class=\"event-card\">", "      <div class=\"event-header\">`;"] ,
        afterStart: 412,
        after: ["function renderNotebookCell(cell) {", "  const { type, title, content, meta } = cell;", "  return `", "    <div class=\"notebook-cell ${cell.type}\">", "      <div class=\"cell-header\">", "        <span class=\"cell-title\">${title}</span>`;"],
      },
      evidence: [
        { level: "Exact", label: "Tool call · Edit", detail: "The retained edit targets workbench.js and includes a bounded patch." },
        { level: "Exact", label: "File change", detail: "+48 and -21 lines are reported by the edit result." },
        { level: "Correlated", label: "Plan task 3", detail: "The path and edit occur after the notebook redesign plan item." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "17", { kind: "tool_call", tool: "Edit", path: "scripts/harness-inspector/ui/workbench.js", additions: 48, deletions: 21 }, "tool_edit_workbench"),
    },
    {
      id: "test-failed",
      kind: "verify",
      phase: "Verify",
      title: "Run focused tests",
      summary: "One layout assertion failed after the notebook restructure.",
      timestamp: "03:16:10",
      relativeTime: "+1m 49s",
      stopConditions: ["failures", "tests"],
      validation: {
        command: "npm run harness-studio:test:browser",
        status: "failed",
        duration: "3.2 s",
        summary: "expected 0 to equal 1",
        output: ["1 failed · 2 passed", "Expected one visible notebook rail marker", "Received 0"],
      },
      evidence: [
        { level: "Exact", label: "Terminal result", detail: "The command, exit state, duration, and failure excerpt are retained." },
        { level: "Correlated", label: "workbench.js", detail: "The failed selector covers the changed notebook rail." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "18", { kind: "tool_result", tool: "Bash", command: "npm run harness-studio:test:browser", exitCode: 1, durationMs: 3200 }, "tool_test_failed"),
    },
    {
      id: "change-css",
      kind: "change",
      phase: "Change",
      title: "Fix notebook layout",
      summary: "Align the execution rail and contain the narrow viewport overflow.",
      timestamp: "03:16:42",
      relativeTime: "+2m 21s",
      stopConditions: ["changes"],
      fileChanges: [{ path: "packages/harness-studio/src/app/index.html", additions: 14, deletions: 3, status: "modified" }],
      diff: {
        path: "packages/harness-studio/src/app/index.html",
        beforeStart: 580,
        before: [".notebook-cell {", "  display: block;", "  min-width: 760px;", "}"],
        afterStart: 580,
        after: [".notebook-cell {", "  display: grid;", "  grid-template-columns: 78px minmax(0, 1fr);", "  min-width: 0;", "}"],
      },
      evidence: [
        { level: "Exact", label: "Tool call · Edit", detail: "The retained edit targets the Studio stylesheet in index.html." },
        { level: "Correlated", label: "Failed assertion", detail: "The changed grid controls the rail marker covered by the preceding test." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "19", { kind: "tool_call", tool: "Edit", path: "packages/harness-studio/src/app/index.html", additions: 14, deletions: 3 }, "tool_edit_css"),
    },
    {
      id: "test-passed",
      kind: "verify",
      phase: "Verify",
      title: "Run tests again",
      summary: "The focused browser flow and layout assertions passed.",
      timestamp: "03:18:31",
      relativeTime: "+4m 10s",
      stopConditions: ["tests"],
      validation: {
        command: "npm run harness-studio:test:browser",
        status: "passed",
        duration: "4.8 s",
        summary: "3 passed",
        output: ["3 passed", "0 console errors", "0 page errors"],
      },
      evidence: [
        { level: "Exact", label: "Terminal result", detail: "The retained command completed with exit code 0." },
        { level: "Correlated", label: "Two modified files", detail: "The verification ran after both retained edits." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "20", { kind: "tool_result", tool: "Bash", command: "npm run harness-studio:test:browser", exitCode: 0, durationMs: 4800 }, "tool_test_passed"),
    },
    {
      id: "response",
      kind: "response",
      phase: "Response",
      title: "Agent response",
      summary: "The Session Detail now reads as a notebook, with synchronized evidence navigation and verified responsive containment.",
      timestamp: "03:19:02",
      relativeTime: "+4m 41s",
      stopConditions: ["responses"],
      evidence: [
        { level: "Exact", label: "Terminal response", detail: "This is the final retained assistant event in the Turn." },
        { level: "Correlated", label: "Verification", detail: "The response follows a retained passing browser test." },
        { level: "Inferred", label: "Outcome wording", detail: "The response summarizes observed edits and tests; it is not an independent correctness proof." },
      ],
      rawAcp: raw("Agent → Client", "session/update", "21", { kind: "agent_message", final: true, content: "The Session Detail now reads as a notebook." }),
    },
  ],
};

export const DEFAULT_STOP_CONDITIONS: StopConditionState = {
  changes: true,
  failures: true,
  permissions: true,
  tests: true,
  responses: false,
};

export const DEFAULT_DEBUGGER_CURSOR: DebuggerCursor = { eventId: "change-workbench" };

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
