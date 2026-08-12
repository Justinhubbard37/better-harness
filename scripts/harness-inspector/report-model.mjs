import path from "node:path";

import { redactTranscriptText } from "../commit-session-link/index.mjs";
import { emptyFeatureTree } from "./feature-tree.mjs";

export const HARNESS_INSPECTOR_REPORT_KIND = "HarnessInspectorReportV1";
export const HARNESS_INSPECTOR_REPORT_SCHEMA_VERSION = 1;

const SAFE_LOCATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const TOOL_FAMILIES = new Set(["inspect", "change", "execute", "verify", "coordinate", "deliver", "other"]);
const TOOL_OPERATIONS = new Set([
  "build-project", "check-runtime", "continue-process", "coordinate-work", "create-commit",
  "create-pull-request", "edit-files", "find-tool", "inspect-browser", "inspect-git", "inspect-image",
  "publish-package", "push-branch", "read-files", "research-web", "run-command", "run-tests",
  "search-repository", "use-tool", "verify-project", "wait-process",
]);

function safeText(value, limit = 240, fallback = null) {
  const redacted = redactTranscriptText(value, { limit });
  if (!redacted) return fallback;
  return redacted
    .replace(/(?:^|[\s("'`])(?:\/[A-Za-z0-9._~ -]+){2,}/gu, (match) => `${match[0].match(/\s|\(|"|'|`/u) ?? ""}<absolute-path>`)
    .replace(/(?:^|[\s("'`])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`)]+/gu, (match) => `${match[0].match(/\s|\(|"|'|`/u) ?? ""}<absolute-path>`);
}

function safeLocator(value) {
  const text = String(value ?? "").trim();
  return SAFE_LOCATOR_RE.test(text) ? text : null;
}

function safeRelativeFile(value) {
  const text = String(value ?? "").replaceAll("\\", "/").normalize("NFC").trim();
  if (!text
    || text.length > 500
    || text.startsWith("/")
    || /^[A-Za-z]:\//u.test(text)
    || text.split("/").some((part) => part === "..")
    || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function isoDay(value) {
  const time = new Date(value ?? "");
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}

function sessionRefMatches(ref, session) {
  const locator = `${session.platform ?? "unknown"}/${session.sessionId}`;
  return ref === session.sessionId || ref === locator;
}

function commitRefMatches(ref, commit) {
  return /^[0-9a-f]{7,40}$/u.test(ref) && commit.hash.startsWith(ref);
}

function relativeFeatureSource(source, repoRoot) {
  if (!source || !repoRoot) return source ?? null;
  const absolute = path.resolve(source);
  const relative = path.relative(repoRoot, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return path.basename(source);
}

function safeTree(tree, repoRoot) {
  const input = tree ?? emptyFeatureTree();
  return {
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    source: relativeFeatureSource(input.source, repoRoot),
    roots: [...(input.roots ?? [])],
    nodes: (input.nodes ?? []).map((node) => ({
      id: node.id,
      type: node.type,
      title: safeText(node.title, 160, node.id),
      parentId: node.parentId,
      children: [...node.children],
      status: safeText(node.status, 64),
      stage: safeText(node.stage, 64),
      date: node.date,
      evidence: ["declared", "candidate", "unmapped"].includes(node.evidence) ? node.evidence : "declared",
      refs: {
        specs: node.refs.specs.map((item) => safeText(item, 240)).filter(Boolean),
        issues: node.refs.issues.map((item) => safeText(item, 240)).filter(Boolean),
        prompts: node.refs.prompts.map((item) => safeText(item, 500)).filter(Boolean),
        sessions: node.refs.sessions.map(safeLocator).filter(Boolean),
        commits: node.refs.commits.map(safeLocator).filter(Boolean),
      },
    })),
  };
}

function projectCommit(commit) {
  const files = (commit.files ?? []).map((file) => {
    const filePath = safeRelativeFile(file?.path);
    if (!filePath) return null;
    return {
      path: filePath,
      added: Number.isFinite(file.added) ? file.added : null,
      removed: Number.isFinite(file.removed) ? file.removed : null,
    };
  }).filter(Boolean).slice(0, 800);
  return {
    hash: commit.hash,
    shortHash: commit.shortHash,
    subject: safeText(commit.subject, 500, "untitled commit"),
    authorName: safeText(commit.authorName, 120),
    authoredAt: commit.authoredAt ?? null,
    committedAt: commit.committedAt ?? commit.authoredAt ?? null,
    day: isoDay(commit.committedAt ?? commit.authoredAt),
    fileCount: commit.fileCount ?? files.length,
    files,
    linesAdded: Number(commit.linesAdded) || 0,
    linesRemoved: Number(commit.linesRemoved) || 0,
    matches: (commit.matches ?? []).map((match) => ({
      sessionId: match.sessionId,
      confidence: match.confidence,
      evidence: {
        linkType: match.evidence?.linkType ?? null,
        timeOverlap: match.evidence?.timeOverlap === true,
        overlappingFileCount: Number(match.evidence?.overlappingFileCount) || 0,
        overlappingFiles: (match.evidence?.overlappingFiles ?? []).map(safeRelativeFile).filter(Boolean),
        cwdWithinRepo: match.evidence?.cwdWithinRepo === true,
      },
    })),
  };
}

function projectToolActivity(activity) {
  const calls = (activity?.calls ?? []).map((call, index) => {
    const step = Number.isInteger(Number(call?.step)) && Number(call.step) > 0 ? Number(call.step) : index + 1;
    const family = TOOL_FAMILIES.has(call?.family) ? call.family : "other";
    const filePaths = [...new Set((call?.filePaths ?? [call?.filePath]).map(safeRelativeFile).filter(Boolean))];
    const filePath = filePaths[0] ?? null;
    const observedDuration = call?.durationStatus === "observed" && Number.isFinite(call?.durationMs) && call.durationMs >= 0;
    const toolName = safeText(call?.toolName, 64, "Unknown tool");
    const operation = TOOL_OPERATIONS.has(call?.operation) ? call.operation : "use-tool";
    const fallbackLabel = /read/iu.test(toolName) ? "Read files"
      : /(?:edit|write|patch)/iu.test(toolName) ? "Edit files"
        : /(?:test|validate|lint)/iu.test(toolName) ? "Verify project"
          : "Use tool";
    const actionLabel = safeText(call?.actionLabel, 80, fallbackLabel);
    const detail = safeText(call?.detail, 240);
    return {
      id: `A${step}`,
      step,
      toolName,
      operation,
      actionLabel,
      family,
      status: call?.status === "failed" ? "failed" : "observed",
      durationStatus: observedDuration ? "observed" : "unobserved",
      ...(observedDuration ? { durationMs: Math.round(call.durationMs) } : {}),
      ...(detail ? { detail, detailKind: call?.detailKind === "redacted-input-summary" ? "redacted-input-summary" : "normalized-summary" } : {}),
      ...(filePath ? { filePath } : {}),
      ...(filePaths.length > 0 ? { filePaths } : {}),
    };
  }).sort((left, right) => left.step - right.step);
  const familyCounts = Object.fromEntries([...TOOL_FAMILIES].map((family) => [family, 0]));
  const files = new Map();
  for (const call of calls) {
    familyCounts[call.family] += 1;
    for (const filePath of call.filePaths ?? (call.filePath ? [call.filePath] : [])) {
      const file = files.get(filePath) ?? { path: filePath, callCount: 0, callIds: [], families: [] };
      file.callCount += 1;
      file.callIds.push(call.id);
      if (!file.families.includes(call.family)) file.families.push(call.family);
      files.set(filePath, file);
    }
  }
  const segments = [];
  for (const call of calls) {
    const current = segments.at(-1);
    if (!current || current.family !== call.family) {
      segments.push({ id: `S${segments.length + 1}`, family: call.family, startStep: call.step, endStep: call.step, callCount: 1 });
    } else {
      current.endStep = call.step;
      current.callCount += 1;
    }
  }
  return {
    kind: "NormalizedToolActivityV1",
    schemaVersion: 1,
    totalCalls: calls.length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    familyCounts,
    segments,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    calls,
  };
}

function projectToolTrace(trace) {
  const calls = (trace?.calls ?? []).map((call) => {
    const step = Number(call?.step);
    if (!Number.isInteger(step) || step <= 0) return null;
    const toolName = safeText(call.toolName, 64, "Unknown tool");
    const observedDuration = call.durationStatus === "observed"
      && Number.isFinite(call.durationMs)
      && call.durationMs >= 0;
    return {
      id: `T${step}`,
      step,
      toolName,
      status: call.status === "failed" ? "failed" : "observed",
      durationStatus: observedDuration ? "observed" : "unobserved",
      ...(observedDuration ? {
        durationMs: Math.round(call.durationMs),
        timingSource: call.timingSource === "lifecycle-pair" ? "lifecycle-pair" : "transcript-pair",
      } : {}),
    };
  }).filter(Boolean).sort((left, right) => left.step - right.step);
  const totalCalls = Math.max(Number(trace?.totalCalls) || 0, ...calls.map((call) => call.step), 0);
  return {
    schemaVersion: 2,
    totalCalls,
    shownCalls: calls.length,
    truncated: calls.length < totalCalls,
    calls,
  };
}

function projectDialogue(dialogue, toolActivity) {
  const callsByStep = new Map(toolActivity.calls.map((call) => [call.step, call]));
  const turns = (dialogue?.turns ?? []).map((turn, index) => {
    const steps = (turn?.steps ?? []).map((step) => {
      if (step?.kind === "note") {
        const text = safeText(step.text, 400);
        return text ? { kind: "note", text } : null;
      }
      if (step?.kind !== "tool") return null;
      const callStep = Number(step.callStep);
      const call = callsByStep.get(callStep);
      return {
        kind: "tool",
        callId: call?.id ?? `A${Number.isInteger(callStep) && callStep > 0 ? callStep : index + 1}`,
        toolName: safeText(call?.toolName ?? step.toolName, 64, "Unknown tool"),
        operation: call?.operation ?? "use-tool",
        actionLabel: call?.actionLabel ?? "Use tool",
        ...(call?.detail ? { detail: call.detail, detailKind: call.detailKind } : {}),
        status: call?.status === "failed" ? "failed" : "observed",
        durationStatus: call?.durationStatus === "observed" ? "observed" : "unobserved",
        ...(call?.durationStatus === "observed" && Number.isFinite(call.durationMs) ? { durationMs: call.durationMs } : {}),
        ...(call?.filePaths?.length ? { filePaths: [...call.filePaths] } : {}),
      };
    }).filter(Boolean);
    const promptText = safeText(turn?.prompt?.text, 1_500, "Prompt unavailable after privacy filtering");
    const response = safeText(turn?.response, 6_000);
    return {
      index: Number(turn?.index) || index + 1,
      anchorId: `turn-${Number(turn?.index) || index + 1}`,
      prompt: { text: promptText, timestamp: turn?.prompt?.timestamp ?? null },
      steps,
      toolCallCount: Number(turn?.toolCallCount) || steps.filter((step) => step.kind === "tool").length,
      messageCount: Number(turn?.messageCount) || 0,
      response,
      durationMs: Number.isFinite(turn?.durationMs) ? turn.durationMs : null,
      startMs: Number.isFinite(turn?.startMs) ? turn.startMs : null,
      endMs: Number.isFinite(turn?.endMs) ? turn.endMs : null,
    };
  });
  return {
    truncated: dialogue?.truncated === true,
    turns,
    responseCount: turns.filter((turn) => turn.response).length,
    noteCount: turns.reduce((sum, turn) => sum + turn.steps.filter((step) => step.kind === "note").length, 0),
    shownToolCallCount: turns.reduce((sum, turn) => sum + turn.steps.filter((step) => step.kind === "tool").length, 0),
  };
}

function projectSession(session) {
  const sessionId = safeLocator(session.sessionId);
  if (!sessionId) return null;
  const platform = safeText(session.platform, 40, "unknown");
  const locator = safeLocator(`${platform}/${sessionId}`) ?? sessionId;
  const prompts = (session.prompts ?? []).map((prompt, index) => ({
    id: `${sessionId}:prompt:${index + 1}`,
    text: safeText(prompt.text, 500, "Prompt unavailable after privacy filtering"),
    timestamp: prompt.timestamp ?? null,
    day: isoDay(prompt.timestamp ?? session.firstSeen),
  }));
  const toolTrace = projectToolTrace(session.toolTrace);
  const toolActivity = projectToolActivity(session.toolActivity ?? {
    calls: toolTrace.calls.map((call) => ({ ...call, family: "other" })),
  });
  const dialogue = projectDialogue(session.dialogue, toolActivity);
  return {
    sessionId,
    locator,
    platform,
    firstSeen: session.firstSeen ?? null,
    lastSeen: session.lastSeen ?? null,
    day: isoDay(session.firstSeen ?? session.lastSeen),
    durationMs: Number.isFinite(session.durationMs) ? session.durationMs : null,
    files: [...new Set((session.files ?? []).map(safeRelativeFile).filter(Boolean))].slice(0, 400),
    prompts,
    promptCount: Number(session.promptCount) || prompts.length,
    promptObservationCount: Number(session.promptObservationCount) || Number(session.promptCount) || prompts.length,
    userTurnCount: Number(session.userTurnCount) || prompts.length,
    retainedUserTurnCount: Number(session.retainedUserTurnCount) || prompts.length,
    toolCallCount: Number(session.toolCallCount) || 0,
    assistantMessageCount: Number(session.assistantMessageCount) || 0,
    fileEditCount: Number(session.fileEditCount) || 0,
    models: (session.models ?? []).map((model) => safeText(model, 80)).filter(Boolean),
    tokenUsage: session.tokenUsage && typeof session.tokenUsage === "object" ? {
      inputTokens: Number(session.tokenUsage.inputTokens) || 0,
      outputTokens: Number(session.tokenUsage.outputTokens) || 0,
      cacheReadInputTokens: Number(session.tokenUsage.cacheReadInputTokens) || 0,
    } : null,
    toolTrace,
    toolActivity,
    dialogue,
    source: safeText(session.source, 80, "native-session"),
    sourceCheckpointId: safeLocator(session.sourceCheckpointId),
    storyLinks: [],
    commitLinks: [],
  };
}

const STORY_MATCH_STOP_WORDS = new Set([
  "across", "agent", "better", "build", "coding", "complete", "current", "delivery",
  "evidence", "feature", "harness", "history", "inspect", "project", "review", "session",
  "sessions", "with", "without",
]);

function matchTokens(value) {
  return new Set(String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]{4,}/gu) ?? []
    .filter((token) => !STORY_MATCH_STOP_WORDS.has(token)));
}

function candidateSessionForStory(story, sessions) {
  const storyTokens = matchTokens(story.title);
  if (storyTokens.size === 0) return null;
  const ranked = sessions.map((session) => {
    const sessionTokens = matchTokens(session.prompts.map((prompt) => prompt.text).join(" "));
    const shared = [...storyTokens].filter((token) => sessionTokens.has(token));
    return { session, score: shared.length };
  }).filter((item) => item.score >= 2).sort((left, right) =>
    right.score - left.score
      || String(right.session.lastSeen ?? "").localeCompare(String(left.session.lastSeen ?? "")));
  if (ranked.length === 0) return null;
  if (ranked[1]?.score === ranked[0].score) return null;
  return ranked[0];
}

function buildStoryLinks(tree, sessions, commits, diagnostics) {
  const stories = tree.nodes.filter((node) => node.type === "story").map((story) => {
    const explicitSessions = sessions.filter((session) => story.refs.sessions.some((ref) => sessionRefMatches(ref, session)));
    const declaredCommits = [];
    for (const ref of story.refs.commits) {
      const matched = commits.filter((commit) => commitRefMatches(ref, commit));
      if (matched.length === 1) declaredCommits.push(matched[0]);
      else if (matched.length > 1) diagnostics.push(`Story ${story.id} commit ref ${ref} is ambiguous and was not linked.`);
      else if (!/^[0-9a-f]{7,40}$/u.test(ref)) diagnostics.push(`Story ${story.id} commit ref is not a 7-40 character hexadecimal prefix.`);
    }
    const treeEvidenceKind = story.evidence === "declared" ? "declared" : story.evidence;
    const linkedSessions = new Map(explicitSessions.map((session) => [session.sessionId, {
      sessionId: session.sessionId,
      evidenceKind: treeEvidenceKind,
      confidence: "explicit",
    }]));
    for (const commit of declaredCommits) {
      for (const match of commit.matches) {
        if (!sessions.some((session) => session.sessionId === match.sessionId)) continue;
        if (!linkedSessions.has(match.sessionId)) {
          linkedSessions.set(match.sessionId, {
            sessionId: match.sessionId,
            evidenceKind: match.confidence === "explicit" ? "explicit" : "candidate",
            confidence: match.confidence,
          });
        }
      }
    }
    if (linkedSessions.size === 0 && story.refs.sessions.length === 0 && story.refs.commits.length === 0) {
      const candidate = candidateSessionForStory(story, sessions);
      if (candidate) {
        linkedSessions.set(candidate.session.sessionId, {
          sessionId: candidate.session.sessionId,
          evidenceKind: "candidate",
          confidence: "text-overlap",
        });
      }
    }
    const feature = tree.nodes.find((node) => node.id === story.parentId) ?? null;
    return {
      ...story,
      featureTitle: feature?.title ?? null,
      sessionLinks: [...linkedSessions.values()],
      commitHashes: declaredCommits.map((commit) => commit.hash),
    };
  });

  for (const story of stories) {
    for (const link of story.sessionLinks) {
      const session = sessions.find((item) => item.sessionId === link.sessionId);
      if (session) session.storyLinks.push({ storyId: story.id, evidenceKind: link.evidenceKind, confidence: link.confidence });
    }
  }
  for (const commit of commits) {
    for (const match of commit.matches) {
      const session = sessions.find((item) => item.sessionId === match.sessionId);
      if (!session) continue;
      const activityFiles = new Set(session.toolActivity.files.map((file) => file.path));
      const overlappingFiles = commit.files.map((file) => file.path).filter((file) => activityFiles.has(file));
      session.commitLinks.push({
        hash: commit.hash,
        confidence: match.confidence,
        evidenceKind: match.evidence.linkType ? "explicit" : overlappingFiles.length > 0 ? "observed-overlap" : "candidate",
        overlappingFiles,
      });
    }
  }
  for (const session of sessions) {
    const linkedHashes = new Set(session.commitLinks.map((link) => link.hash));
    const activityFiles = new Set(session.toolActivity.files.map((file) => file.path));
    const contextual = commits.map((commit) => ({
      commit,
      overlappingFiles: commit.files.map((file) => file.path).filter((file) => activityFiles.has(file)),
    })).filter(({ commit, overlappingFiles }) => !linkedHashes.has(commit.hash) && overlappingFiles.length > 0).slice(0, 5);
    for (const { commit, overlappingFiles } of contextual) {
      session.commitLinks.push({
        hash: commit.hash,
        confidence: "contextual",
        evidenceKind: "file-context",
        overlappingFiles,
      });
    }
  }
  return stories;
}

function buildDays(sessions, commits) {
  const byDay = new Map();
  const ensure = (day) => {
    if (!day) return null;
    if (!byDay.has(day)) byDay.set(day, { date: day, sessionIds: [], commitHashes: [], promptCount: 0, toolCallCount: 0 });
    return byDay.get(day);
  };
  for (const session of sessions) {
    const firstDay = isoDay(session.firstSeen);
    const lastDay = isoDay(session.lastSeen);
    const sessionDays = new Set([firstDay, lastDay, ...session.prompts.map((prompt) => prompt.day)].filter(Boolean));
    if (firstDay && lastDay && firstDay !== lastDay) {
      const cursor = new Date(`${firstDay}T00:00:00.000Z`);
      const end = new Date(`${lastDay}T00:00:00.000Z`);
      for (let count = 0; cursor <= end && count < 366; count += 1) {
        sessionDays.add(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    for (const sessionDay of sessionDays) {
      const day = ensure(sessionDay);
      if (!day) continue;
      day.sessionIds.push(session.sessionId);
      day.promptCount += session.prompts.filter((prompt) => prompt.day === sessionDay).length;
      if (firstDay === lastDay) day.toolCallCount += session.toolCallCount;
    }
  }
  for (const commit of commits) {
    const day = ensure(commit.day);
    if (day) day.commitHashes.push(commit.hash);
  }
  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

const PROVIDER_STATUSES = new Set(["ok", "no-evidence", "error"]);

// Providers keep only platform identity, a status whitelist, and bounded
// counts; raw provider error text stays in CLI-side diagnostics.
function projectProviders(providers, sessions) {
  const includedByPlatform = new Map();
  for (const session of sessions) {
    includedByPlatform.set(session.platform, (includedByPlatform.get(session.platform) ?? 0) + 1);
  }
  return (providers ?? []).map((provider) => {
    const platform = safeText(provider?.platform, 40, "unknown");
    return {
      platform,
      status: PROVIDER_STATUSES.has(provider?.status) ? provider.status : "ok",
      discovered: Math.max(0, Math.trunc(Number(provider?.discovered) || 0)),
      sessionCount: includedByPlatform.get(platform) ?? 0,
    };
  });
}

export function buildHarnessInspectorReport({
  repoRoot,
  featureTree,
  sessions = [],
  correlation,
  providers = [],
  filters = {},
  diagnostics = [],
} = {}) {
  const tree = safeTree(featureTree, repoRoot);
  const projectedSessions = sessions.map(projectSession).filter(Boolean);
  const commits = (correlation?.commits ?? []).map(projectCommit);
  const reportDiagnostics = diagnostics.map((item) => safeText(item, 240)).filter(Boolean);
  const stories = buildStoryLinks(tree, projectedSessions, commits, reportDiagnostics);
  const stages = [...new Set(tree.nodes.map((node) => node.stage).filter(Boolean))].sort();
  const unmappedSessionIds = projectedSessions.filter((session) => session.storyLinks.length === 0).map((session) => session.sessionId);

  return {
    kind: HARNESS_INSPECTOR_REPORT_KIND,
    schemaVersion: HARNESS_INSPECTOR_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspace: { name: path.basename(repoRoot ?? "workspace") },
    filters: {
      platform: safeText(filters.platform, 120, "all"),
      since: filters.since ?? null,
      until: filters.until ?? null,
      stage: safeText(filters.stage, 64),
      commitLimit: Number(filters.commitLimit) || null,
      sessionLimit: Number(filters.sessionLimit) || null,
    },
    providers: projectProviders(providers, projectedSessions),
    featureTree: tree,
    stages,
    stories,
    sessions: projectedSessions,
    commits,
    days: buildDays(projectedSessions, commits),
    diagnostics: [
      ...reportDiagnostics,
      ...(tree.nodes.length === 0 ? ["No feature tree was supplied; use Date mode to inspect observed evidence."] : []),
      ...(unmappedSessionIds.length > 0 ? [`${unmappedSessionIds.length} session(s) have no declared or commit-derived Story link.`] : []),
    ],
  };
}
