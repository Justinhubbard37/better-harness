import path from "node:path";

import { buildToolCallTrace, createAnalyzer, sanitizePrivateReviewText } from "../session-analysis/index.mjs";
import { attributeSessionToolName } from "./tool-attribution.mjs";

export const DEFAULT_MAX_SESSIONS = 20;
const MAX_PROMPTS_PER_SESSION = 8;
const MAX_FILES_PER_SESSION = 400;
const MAX_MODELS_PER_SESSION = 4;
const PROMPT_SUMMARY_LIMIT = 200;
const MAX_ENTIRE_TRANSCRIPT_LINES = 200_000;
const MAX_SESSION_VIEW_TOOL_CALLS = 1_000;

function timestampMillis(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function boundedMaxSessions(value, fallback = DEFAULT_MAX_SESSIONS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function repoRelativePath(filePath, repoRoot) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function isWithinRepo(candidate, repoRoot) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const relative = path.relative(repoRoot, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Hosts emit different tool request types (claude "tool.call", qoder
// "tool.requested"), so detect tool requests by category and lifecycle phase.
function isToolRequest(event) {
  if (event?.type === "tool.call" || event?.type === "tool.requested") return true;
  return event?.category === "tool" && event?.lifecyclePhase === "request";
}

function isFileEditTool(event) {
  return /(?:^|[_-])(?:edit|write|create|patch|replace|update)(?:$|[_-])/iu.test(String(event?.toolName ?? ""));
}

// Reduce hydrated session events into the bounded, privacy-safe summary shape
// consumed by correlate.mjs and render-html.mjs. Pure over events + repoRoot.
export function summarizeSessionEvents(session, events = [], { repoRoot, platform, includeToolTrace = false } = {}) {
  const files = new Set();
  const prompts = [];
  const models = new Set();
  let firstSeen = timestampMillis(session.firstSeen);
  let lastSeen = timestampMillis(session.lastSeen);
  let promptCount = 0;
  let toolCallCount = 0;
  let assistantMessageCount = 0;
  let fileEditCount = 0;
  let cwdWithinRepo = false;
  const toolCounts = new Map();
  const seenToolInvocations = new Set();
  const tokenTotals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let usageObserved = false;

  for (const event of events) {
    const eventTime = timestampMillis(event?.timestamp);
    if (eventTime !== null) {
      if (firstSeen === null || eventTime < firstSeen) firstSeen = eventTime;
      if (lastSeen === null || eventTime > lastSeen) lastSeen = eventTime;
    }
    if (event?.cwd && !cwdWithinRepo) cwdWithinRepo = isWithinRepo(event.cwd, repoRoot);
    if (isToolRequest(event)) {
      const invocationKey = event.toolInvocationId
        ?? `${event.timestamp ?? ""}|${event.toolName ?? ""}|${event.commandText ?? event.filePath ?? ""}`;
      if (!seenToolInvocations.has(invocationKey)) {
        seenToolInvocations.add(invocationKey);
        toolCallCount += 1;
        const toolName = attributeSessionToolName(event);
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        if (isFileEditTool(event)) fileEditCount += 1;
      }
    }
    if (event?.type === "assistant" && typeof event.content === "string" && event.content.trim().length > 0) {
      assistantMessageCount += 1;
    }
    if (event?.filePath) {
      const relative = repoRelativePath(event.filePath, repoRoot);
      if (relative && files.size < MAX_FILES_PER_SESSION) files.add(relative);
    }
    if (event?.userPrompt === true) {
      promptCount += 1;
      if (prompts.length < MAX_PROMPTS_PER_SESSION) {
        const summary = sanitizePrivateReviewText(event.userText ?? null, { limit: PROMPT_SUMMARY_LIMIT });
        if (summary && !prompts.some((prompt) => prompt.text === summary)) {
          prompts.push({ text: summary, timestamp: event.timestamp ?? null });
        }
      }
    }
    if (event?.modelUsage && typeof event.modelUsage === "object") {
      usageObserved = true;
      tokenTotals.inputTokens += Number(event.modelUsage.inputTokens) || 0;
      tokenTotals.outputTokens += Number(event.modelUsage.outputTokens) || 0;
      tokenTotals.cacheReadInputTokens += Number(event.modelUsage.cacheReadInputTokens) || 0;
    }
    if (event?.model && models.size < MAX_MODELS_PER_SESSION) models.add(String(event.model));
  }

  return {
    sessionId: session.sessionId,
    platform: platform ?? session.platform ?? null,
    firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
    lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    durationMs: firstSeen !== null && lastSeen !== null ? lastSeen - firstSeen : null,
    cwdWithinRepo,
    files: [...files].sort(),
    prompts,
    promptCount,
    toolCallCount,
    assistantMessageCount,
    fileEditCount,
    toolCounts: Object.fromEntries([...toolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    ...(includeToolTrace
      ? {
          // Normalized host streams can include transport diagnostics whose
          // type happens to contain "tool" (for example MCP end markers).
          // Only the normalized tool category belongs in the call trace.
          toolTrace: buildToolCallTrace(
            events
              .filter((event) => event?.category === "tool" || event?.toolName || event?.functionCallName)
              .map((event) => event?.lifecyclePhase === "request"
                ? { ...event, toolName: attributeSessionToolName(event) }
                : event),
            { limit: MAX_SESSION_VIEW_TOOL_CALLS, laneLimit: 8 },
          ),
        }
      : {}),
    models: [...models].sort(),
    tokenUsage: usageObserved ? tokenTotals : null,
  };
}

function withinRange(session, sinceMs, untilMs) {
  const firstSeen = timestampMillis(session.firstSeen);
  const lastSeen = timestampMillis(session.lastSeen);
  if (sinceMs !== null && lastSeen !== null && lastSeen < sinceMs) return false;
  if (untilMs !== null && firstSeen !== null && firstSeen > untilMs) return false;
  return true;
}

export async function collectSessionSummaries({
  workspace,
  repoRoot,
  platform = "qoder",
  since = null,
  until = null,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  const analyzer = await createAnalyzer(platform);
  const scopeOptions = { workspace };
  if (since) scopeOptions.since = since;
  if (until) scopeOptions.until = until;
  const scope = await analyzer.resolveScope(scopeOptions);
  const roots = await analyzer.discoverSourceRoots(scope);
  const discovered = await analyzer.discoverSessions(scope, roots);

  const sinceMs = timestampMillis(since);
  const untilMs = timestampMillis(until);
  const selected = discovered
    .filter((session) => withinRange(session, sinceMs, untilMs))
    .sort((a, b) => (timestampMillis(b.lastSeen) ?? 0) - (timestampMillis(a.lastSeen) ?? 0))
    .slice(0, boundedMaxSessions(maxSessions));

  const summaries = [];
  for (const session of selected) {
    const events = await analyzer.readSession(session, scope, { includeUserText: true });
    summaries.push(summarizeSessionEvents(session, events, { repoRoot, platform }));
  }
  return summaries;
}

// Hydrate one session with full transcript options for the session view.
// Picks the requested session id (exact or unique prefix) or the most recent
// session when no id is given.
export async function collectSessionDetail({
  workspace,
  repoRoot,
  platform = "qoder",
  sessionId = null,
} = {}) {
  const analyzer = await createAnalyzer(platform);
  const scope = await analyzer.resolveScope({ workspace });
  const roots = await analyzer.discoverSourceRoots(scope);
  const discovered = await analyzer.discoverSessions(scope, roots);

  let session = null;
  if (sessionId) {
    const matches = discovered.filter((candidate) =>
      candidate.sessionId === sessionId || candidate.sessionId.startsWith(sessionId));
    if (matches.length === 0) throw new Error(`session not found: ${sessionId}`);
    if (matches.length > 1) throw new Error(`session id is ambiguous: ${sessionId}`);
    [session] = matches;
  } else {
    session = discovered
      .sort((a, b) => (timestampMillis(b.lastSeen) ?? 0) - (timestampMillis(a.lastSeen) ?? 0))[0] ?? null;
    if (!session) throw new Error("no sessions discovered for this workspace");
  }

  const events = await analyzer.readSession(session, scope, {
    includeUserText: true,
    includeContent: true,
    includeCommandText: true,
  });
  return {
    summary: summarizeSessionEvents(session, events, { repoRoot, platform, includeToolTrace: true }),
    events,
  };
}

function platformFromEntireAgent(agent, fallback = "claude") {
  const normalized = String(agent ?? "").toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("qoder")) return "qoder";
  if (normalized.includes("cursor")) return "cursor";
  if (normalized.includes("copilot")) return "copilot";
  return fallback;
}

export async function normalizeEntireCheckpointSession({
  transcript,
  sessionId,
  checkpointId,
  repoRoot,
  agent = null,
  platform = null,
  model = null,
  metadata = null,
} = {}) {
  const resolvedPlatform = platformFromEntireAgent(agent, platform ?? "claude");
  const analyzer = await createAnalyzer(resolvedPlatform);
  const sourceKind = resolvedPlatform === "claude"
    ? "claude-project-jsonl"
    : resolvedPlatform === "codex" ? "codex-session-jsonl" : `${resolvedPlatform}-session-jsonl`;
  const events = [];
  const lines = String(transcript ?? "").split("\n");
  const truncated = lines.length > MAX_ENTIRE_TRANSCRIPT_LINES;
  for (let index = 0; index < Math.min(lines.length, MAX_ENTIRE_TRANSCRIPT_LINES); index += 1) {
    if (!lines[index].trim()) continue;
    let raw;
    try {
      raw = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const sourceRef = {
      kind: sourceKind,
      path: `entire-checkpoint:${checkpointId}`,
      line: index + 1,
      sessionId,
    };
    const options = { includeUserText: true, includeContent: true, includeCommandText: true };
    const normalized = typeof analyzer.normalizeEvents === "function"
      ? analyzer.normalizeEvents(raw, sourceRef, options)
      : [analyzer.normalizeEvent(raw, sourceRef, options)].filter(Boolean);
    events.push(...normalized);
  }
  events.sort((a, b) => (timestampMillis(a.timestamp) ?? 0) - (timestampMillis(b.timestamp) ?? 0));
  const summary = summarizeSessionEvents({ sessionId, platform: resolvedPlatform }, events, {
    repoRoot,
    platform: resolvedPlatform,
    includeToolTrace: true,
  });
  if (model && summary.models.length === 0) summary.models = [model];
  if (metadata?.filesTouched?.length) {
    summary.files = [...new Set([
      ...summary.files,
      ...metadata.filesTouched.map((file) => repoRelativePath(file, repoRoot)).filter(Boolean),
    ])].sort();
  }
  if (!summary.tokenUsage && metadata?.tokenUsage) {
    summary.tokenUsage = {
      inputTokens: Number(metadata.tokenUsage.input_tokens ?? metadata.tokenUsage.inputTokens) || 0,
      outputTokens: Number(metadata.tokenUsage.output_tokens ?? metadata.tokenUsage.outputTokens) || 0,
      cacheReadInputTokens: Number(metadata.tokenUsage.cache_read_tokens ?? metadata.tokenUsage.cacheReadInputTokens) || 0,
    };
  }
  if ((!Number.isFinite(summary.durationMs) || summary.durationMs === 0) && Number.isFinite(metadata?.sessionMetrics?.duration_ms)) {
    summary.durationMs = metadata.sessionMetrics.duration_ms;
  }
  summary.source = "entire-checkpoint";
  summary.sourceCheckpointId = checkpointId;
  return { summary, events, truncated };
}
