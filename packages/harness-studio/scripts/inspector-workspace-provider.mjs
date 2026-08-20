import path from "node:path";

import {
  collectMultiPlatformSessionSummaries,
  resolveRepoRoot,
} from "../../../scripts/commit-session-link/index.mjs";
import { SUPPORTED_SESSION_PROVIDERS } from "../../../scripts/session-analysis/index.mjs";

const MAX_SESSIONS = 100;

/**
 * Repository integration adapter: reuse Inspector's real provider discovery in
 * process and project its privacy-safe summaries into Studio's Session model.
 */
export function createInspectorWorkspaceSessionProvider({
  collect = collectMultiPlatformSessionSummaries,
  repoRootFor = resolveRepoRoot,
  platforms = SUPPORTED_SESSION_PROVIDERS,
} = {}) {
  return {
    async discover(workspacePath) {
      const repoRoot = repoRootFor(workspacePath);
      const { sessions, providers } = await collect({
        workspace: workspacePath,
        repoRoot,
        platforms,
        maxSessions: MAX_SESSIONS,
        includeToolTrace: true,
        includeDialogue: true,
      });
      return {
        label: path.basename(repoRoot),
        sessions: sessions.map(projectInspectorSession).filter(Boolean),
        providers: providers.map((provider) => ({
          provider: provider.platform,
          status: provider.status,
          discovered: provider.discovered,
          included: provider.included,
          ...(provider.message ? { message: provider.message } : {}),
        })),
      };
    },
  };
}

function projectInspectorSession(summary) {
  const savedAt = validTimestamp(summary.lastSeen) ?? validTimestamp(summary.firstSeen);
  if (!savedAt || !summary.sessionId || !summary.platform) return null;
  const prompt = summary.prompts?.[0]?.text?.trim() || `${summary.platform} Session ${String(summary.sessionId).slice(0, 12)}`;
  const id = `${summary.platform}:${summary.sessionId}`;
  return {
    summary: {
      id,
      savedAt,
      prompt,
      status: "observed",
      toolCallCount: Number(summary.toolCallCount) || 0,
      provider: summary.platform,
      messageCount: (Number(summary.promptCount) || 0) + (Number(summary.assistantMessageCount) || 0),
      warningCount: 0,
    },
    debugger: debuggerProjection(summary, { id, prompt, savedAt }),
  };
}

function debuggerProjection(summary, identity) {
  const sessionId = String(summary.sessionId);
  const calls = summary.toolActivity?.calls ?? [];
  const prompts = summary.prompts ?? [];
  const responses = (summary.dialogue?.turns ?? []).filter((turn) => turn.response);
  const events = [];
  for (const [index, prompt] of prompts.entries()) {
    events.push(debuggerEvent({
      id: `prompt_${index + 1}`,
      kind: "prompt",
      phase: "Prompt",
      title: "User request",
      summary: prompt.text,
      timestamp: prompt.timestamp ?? identity.savedAt,
      sessionId,
      rpcId: `p${index + 1}`,
      direction: "Client → Agent",
      method: "session/prompt",
    }));
  }
  for (const [index, call] of calls.entries()) {
    const kind = debuggerKind(call.family);
    events.push(debuggerEvent({
      id: `tool_${index + 1}`,
      kind,
      phase: phaseForKind(kind),
      title: call.actionLabel || `${call.toolName} tool call`,
      summary: call.detail || `${call.toolName} observed by Inspector`,
      timestamp: call.startedAt ? new Date(call.startedAt).toISOString() : identity.savedAt,
      sessionId,
      rpcId: `t${index + 1}`,
      direction: "Agent → Client",
      method: "session/tool-call",
      toolCalls: [{
        id: call.id || `tool_${index + 1}`,
        name: call.toolName || "Unknown tool",
        summary: call.actionLabel || "Observed tool call",
        input: call.detail || "Input not retained in the privacy-safe Inspector projection.",
        output: call.status === "failed" ? "Inspector observed a failed call." : "Result payload not retained in the summary projection.",
        duration: Number.isFinite(call.durationMs) ? `${call.durationMs} ms` : "not retained",
        ...(call.filePath ? { resource: call.filePath } : {}),
      }],
    }));
  }
  for (const [index, turn] of responses.entries()) {
    events.push(debuggerEvent({
      id: `response_${index + 1}`,
      kind: "response",
      phase: "Response",
      title: "Assistant response",
      summary: turn.response,
      timestamp: Number.isFinite(turn.endMs) ? new Date(turn.endMs).toISOString() : identity.savedAt,
      sessionId,
      rpcId: `r${index + 1}`,
      direction: "Agent → Client",
      method: "session/response",
    }));
  }
  if (events.length === 0) {
    events.push(debuggerEvent({
      id: "observed_session",
      kind: "explore",
      phase: "Observed",
      title: "Session evidence",
      summary: "Inspector matched this Session to the selected workspace, but no dialogue detail was retained.",
      timestamp: identity.savedAt,
      sessionId,
      rpcId: "o1",
      direction: "Agent → Client",
      method: "session/observed",
    }));
  }
  return {
    id: identity.id,
    name: identity.prompt,
    agent: summary.platform,
    protocol: "Inspector normalized local evidence",
    connection: "observed",
    mode: "Retained run",
    startedAt: clock(summary.firstSeen ?? identity.savedAt),
    finishedAt: clock(summary.lastSeen ?? identity.savedAt),
    events: events
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
      .map(({ sortKey: _sortKey, ...event }) => event),
  };
}

function debuggerEvent({ id, kind, phase, title, summary, timestamp, sessionId, rpcId, direction, method, toolCalls }) {
  const observedAt = validTimestamp(timestamp) ?? new Date(0).toISOString();
  return {
    sortKey: observedAt,
    id,
    kind,
    phase,
    title,
    summary: String(summary ?? "Observed evidence unavailable."),
    timestamp: clock(observedAt),
    relativeTime: "retained",
    stopConditions: [],
    ...(toolCalls ? { toolCalls } : {}),
    evidence: [{ level: "Exact", label: "Inspector provider evidence", detail: "This projection comes from workspace-matched normalized local Session evidence." }],
    rawAcp: {
      direction,
      method,
      rpcId,
      sessionId,
      traceContext: "inspector-normalized",
      payload: { retained: true },
    },
  };
}

function debuggerKind(family) {
  if (family === "change" || family === "deliver") return "change";
  if (family === "verify") return "verify";
  return "explore";
}

function phaseForKind(kind) {
  if (kind === "change") return "Change";
  if (kind === "verify") return "Verify";
  return "Explore";
}

function validTimestamp(value) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function clock(value) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toISOString().slice(11, 19);
}
