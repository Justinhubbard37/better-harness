export const NORMALIZED_TOOL_ACTIVITY_KIND = "NormalizedToolActivityV1";
export const NORMALIZED_TOOL_ACTIVITY_SCHEMA_VERSION = 1;

const FAMILY_ORDER = Object.freeze(["inspect", "change", "execute", "verify", "coordinate", "deliver", "other"]);

function familyFor(toolName, transientCommandText = "") {
  const tool = String(toolName ?? "").toLowerCase();
  const command = String(transientCommandText ?? "").toLowerCase();
  if (/(?:apply[_ /-]?patch|\bedit\b|\bwrite\b|\bcreate_file\b|\breplace\b)/u.test(tool)) return "change";
  if (/(?:git[^\n]{0,80}\b(?:commit|push)\b|npm\s+publish|gh\s+pr\s+create)/u.test(command)) return "deliver";
  if (/(?:browser|playwright|screenshot|view_image|validate|lint|test)/u.test(tool)
    || /(?:npm\s+(?:run\s+)?(?:test|check|pack:verify)|node\s+--test|git\s+diff\s+--check|\/health\b|canvas-module\.js)/u.test(command)) return "verify";
  if (/(?:update_plan|request_user|goal|thread|send_message|spawn_agent|wait_agent|\bwait\b)/u.test(tool)) return "coordinate";
  if (/(?:\bread\b|\bview\b|\bopen\b|\bfind\b|\bsearch\b|\bglob\b|\blist\b|tool_search|web)/u.test(tool)
    || /(?:\brg\b|\bsed\b|git\s+(?:status|log|show|diff)\b|\bfind\b)/u.test(command)) return "inspect";
  if (/(?:exec|bash|shell|command|node_repl)/u.test(tool)) return "execute";
  return "other";
}

function safeRelativePath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\\", "/").normalize("NFC").trim();
  if (!normalized
    || normalized.length > 500
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split("/").some((part) => part === "..")
    || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function buildSegments(calls) {
  const segments = [];
  for (const call of calls) {
    const current = segments.at(-1);
    if (!current || current.family !== call.family) {
      segments.push({
        id: `S${segments.length + 1}`,
        family: call.family,
        startStep: call.step,
        endStep: call.step,
        callCount: 1,
        failedCount: call.status === "failed" ? 1 : 0,
        fileCount: call.filePaths?.length ?? (call.filePath ? 1 : 0),
        tools: [call.toolName],
      });
      continue;
    }
    current.endStep = call.step;
    current.callCount += 1;
    if (call.status === "failed") current.failedCount += 1;
    current.fileCount += call.filePaths?.length ?? (call.filePath ? 1 : 0);
    if (!current.tools.includes(call.toolName)) current.tools.push(call.toolName);
  }
  return segments;
}

function buildFiles(calls) {
  const files = new Map();
  for (const call of calls) {
    for (const filePath of call.filePaths ?? (call.filePath ? [call.filePath] : [])) {
      const item = files.get(filePath) ?? { path: filePath, callCount: 0, callIds: [], families: [] };
      item.callCount += 1;
      item.callIds.push(call.id);
      if (!item.families.includes(call.family)) item.families.push(call.family);
      files.set(filePath, item);
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizeToolActivity(traceCalls = [], requestFacts = []) {
  const factsByStep = new Map(requestFacts.map((fact) => [Number(fact.step), fact]));
  const factsByInvocation = new Map(requestFacts
    .filter((fact) => fact.transientInvocationKey)
    .map((fact) => [String(fact.transientInvocationKey), fact]));
  const calls = traceCalls.map((call, index) => {
    const step = Number.isInteger(Number(call?.step)) && Number(call.step) > 0 ? Number(call.step) : index + 1;
    const fact = call?.transientInvocationKey
      ? (factsByInvocation.get(String(call.transientInvocationKey)) ?? {})
      : (factsByStep.get(step) ?? {});
    const filePaths = [...new Set((fact.filePaths ?? [fact.filePath]).map(safeRelativePath).filter(Boolean))];
    const filePath = filePaths[0] ?? null;
    return {
      id: `A${step}`,
      step,
      toolName: String(call?.toolName ?? fact.toolName ?? "Unknown tool").slice(0, 64),
      family: familyFor(call?.toolName ?? fact.toolName, fact.transientCommandText),
      status: call?.status === "failed" ? "failed" : "observed",
      durationStatus: call?.durationStatus === "observed" ? "observed" : "unobserved",
      ...(call?.durationStatus === "observed" && Number.isFinite(call.durationMs) ? { durationMs: Math.round(call.durationMs) } : {}),
      ...(filePath ? { filePath } : {}),
      ...(filePaths.length > 0 ? { filePaths } : {}),
    };
  }).sort((left, right) => left.step - right.step);
  const familyCounts = Object.fromEntries(FAMILY_ORDER.map((family) => [family, 0]));
  for (const call of calls) familyCounts[call.family] += 1;
  return {
    kind: NORMALIZED_TOOL_ACTIVITY_KIND,
    schemaVersion: NORMALIZED_TOOL_ACTIVITY_SCHEMA_VERSION,
    totalCalls: calls.length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    familyCounts,
    segments: buildSegments(calls),
    files: buildFiles(calls),
    calls,
  };
}
