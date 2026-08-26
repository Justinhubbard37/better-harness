export type ToolRelation = "exact" | "same-resource" | "same-tool" | "none";

import type { ExperimentToolCall } from "../../contracts/experiment-stream-contract.js";

export type { ExperimentToolCall } from "../../contracts/experiment-stream-contract.js";

export interface NormalizedToolCall {
  tool: string;
  resource: string | null;
  arguments: string;
}

export type ToolOperationKind = "read" | "edit" | "search" | "list" | "verify" | "command";

export interface ToolOperation {
  id: string;
  callId: string;
  callSequence: number;
  callName: string;
  kind: ToolOperationKind;
  resource: string;
  status: ExperimentToolCall["status"];
}

export interface ToolResultSummary {
  outcome: "running" | "completed" | "failed" | "unavailable";
  exitCode?: number;
  durationMs?: number;
  excerpt?: string;
}

export interface RelatedToolCall {
  relation: ToolRelation;
  score: number;
  call: ExperimentToolCall | null;
  basis: string;
}

export type ActivityPhase =
  | "Orient"
  | "Discover"
  | "Change"
  | "Execute"
  | "Diagnose"
  | "Recover"
  | "Verify"
  | "Deliver";

export interface ActivityProjection {
  call: ExperimentToolCall;
  phase: ActivityPhase;
  basis: string;
}

export function normalizeToolCall(call: ExperimentToolCall): NormalizedToolCall {
  return {
    tool: call.name.trim().toLowerCase(),
    resource: resourceFrom(call.input),
    arguments: canonicalJson(call.input ?? null),
  };
}

/**
 * Projects a provider call into observable operation atoms. A compound shell
 * call remains one call through callId/callSequence while each recorded
 * parsed_cmd or changed path becomes independently comparable.
 */
export function projectToolOperations(call: ExperimentToolCall): ToolOperation[] {
  const input = objectRecord(call.input);
  const operations: Array<Omit<ToolOperation, "id">> = [];
  const parsed = Array.isArray(input?.parsed_cmd) ? input.parsed_cmd : [];
  for (const value of parsed) {
    const command = objectRecord(value);
    if (command === null) continue;
    const commandText = stringValue(command.cmd) ?? "";
    const kind = operationKind(stringValue(command.type), commandText, call.name);
    const resource = operationResource(command, kind, commandText);
    operations.push(operationFrom(call, kind, resource));
  }

  const changes = objectRecord(input?.changes);
  if (changes !== null) {
    const namedResource = resourceFromToolName(call.name);
    const entries = Object.keys(changes);
    for (const path of entries) {
      const resource = entries.length === 1 && namedResource !== null
        ? namedResource
        : normalizeOperationResource(path);
      operations.push(operationFrom(call, "edit", resource));
    }
  }

  if (operations.length === 0) {
    const commandText = commandTextFrom(input);
    const kind = operationKind(undefined, commandText, call.name);
    const normalized = resourceFrom(input);
    const resource = (normalized?.startsWith("command:") === true ? null : normalized)
      ?? resourceFromToolName(call.name)
      ?? resourceFromVerification(commandText, call.result)
      ?? ".";
    operations.push(operationFrom(call, kind, normalizeOperationResource(resource)));
  }

  const unique = new Map<string, Omit<ToolOperation, "id">>();
  for (const operation of operations) {
    unique.set(`${operation.kind}:${operation.resource}`, operation);
  }
  return [...unique.values()].map((operation, index) => ({
    ...operation,
    id: `${call.id}:operation:${index}`,
  }));
}

export function summarizeToolResult(call: ExperimentToolCall): ToolResultSummary {
  if (call.status === "running") return { outcome: "running" };
  if (call.status === "result-unavailable") return { outcome: "unavailable" };
  const parsed = parseResult(call.result);
  const exitCode = numberValue(parsed?.exit_code) ?? numberValue(parsed?.exitCode);
  const durationMs = durationFrom(parsed?.duration);
  const excerpt = resultExcerpt(parsed, call.result);
  return {
    outcome: call.status === "failed" ? "failed" : "completed",
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(excerpt === undefined ? {} : { excerpt }),
  };
}

export function compareToolCalls(left: ExperimentToolCall, right: ExperimentToolCall): RelatedToolCall {
  const a = normalizeToolCall(left);
  const b = normalizeToolCall(right);
  if (a.tool === b.tool && a.arguments === b.arguments) {
    return { relation: "exact", score: 100, call: right, basis: "same tool and canonical arguments" };
  }
  if (a.resource !== null && b.resource !== null && sameResource(a.resource, b.resource)) {
    return {
      relation: "same-resource",
      score: a.tool === b.tool ? 84 : 72,
      call: right,
      basis: `same resource ${a.resource}${a.tool === b.tool ? " and same tool" : ""}`,
    };
  }
  if (a.tool === b.tool) {
    return { relation: "same-tool", score: 40, call: right, basis: `same ${left.name} tool` };
  }
  return { relation: "none", score: 0, call: null, basis: "no shared tool or resource key" };
}

function sameResource(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.startsWith("command:") || right.startsWith("command:") || left.startsWith("pattern:") || right.startsWith("pattern:")) {
    return false;
  }
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Weighted sequence alignment. It keeps matches one-to-one and monotonic, so a
 * repeated Read cannot become the counterpart of several calls in another lane.
 */
export function alignToolCalls(
  reference: readonly ExperimentToolCall[],
  candidate: readonly ExperimentToolCall[],
): Map<string, RelatedToolCall> {
  const rows = reference.length + 1;
  const columns = candidate.length + 1;
  const scores = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  const moves = Array.from({ length: rows }, () => Array<"up" | "left" | "match" | null>(columns).fill(null));
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const relation = compareToolCalls(reference[row - 1]!, candidate[column - 1]!);
      const match = relation.score >= 40 ? scores[row - 1]![column - 1]! + relation.score : -1;
      const up = scores[row - 1]![column]!;
      const left = scores[row]![column - 1]!;
      if (match >= up && match >= left) {
        scores[row]![column] = match;
        moves[row]![column] = "match";
      } else if (up >= left) {
        scores[row]![column] = up;
        moves[row]![column] = "up";
      } else {
        scores[row]![column] = left;
        moves[row]![column] = "left";
      }
    }
  }
  const aligned = new Map<string, RelatedToolCall>();
  let row = reference.length;
  let column = candidate.length;
  while (row > 0 && column > 0) {
    const move = moves[row]![column];
    if (move === "match") {
      const source = reference[row - 1]!;
      const relation = compareToolCalls(source, candidate[column - 1]!);
      if (relation.score >= 40) aligned.set(source.id, relation);
      row -= 1;
      column -= 1;
    } else if (move === "up") {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return aligned;
}

export function relatedCallFor(
  selected: ExperimentToolCall,
  sourceLane: readonly ExperimentToolCall[],
  targetLane: readonly ExperimentToolCall[],
): RelatedToolCall {
  return alignToolCalls(sourceLane, targetLane).get(selected.id) ?? {
    relation: "none",
    score: 0,
    call: null,
    basis: "no monotonic counterpart",
  };
}

export function localToolChain(
  calls: readonly ExperimentToolCall[],
  selectedId: string,
): ExperimentToolCall[] {
  const index = calls.findIndex((call) => call.id === selectedId);
  if (index < 0) return [];
  return calls.slice(Math.max(0, index - 1), Math.min(calls.length, index + 2));
}

/**
 * Projects recorded calls into engineering phases using only observable tool
 * names, command text, resources, and status. The projection is a navigation
 * aid; it is not a claim about hidden agent intent.
 */
export function projectActivities(calls: readonly ExperimentToolCall[]): ActivityProjection[] {
  return calls.map((call, index) => {
    if (call.status === "failed") {
      return { call, phase: "Diagnose", basis: "recorded failed tool result" };
    }
    if (index > 0 && calls[index - 1]?.status === "failed") {
      return { call, phase: "Recover", basis: "first recorded call after a failure" };
    }
    const tool = call.name.trim().toLowerCase();
    const normalized = normalizeToolCall(call);
    const command = normalized.resource?.startsWith("command:")
      ? normalized.resource.slice("command:".length).toLowerCase()
      : "";
    if (/todo|plan|agent|task/.test(tool)) {
      return { call, phase: "Orient", basis: `tool ${call.name}` };
    }
    if (/read|grep|glob|search|find|list|fetch/.test(tool)) {
      return { call, phase: "Discover", basis: `tool ${call.name}` };
    }
    if (/write|edit|patch|replace|notebook/.test(tool)) {
      return { call, phase: "Change", basis: `tool ${call.name}` };
    }
    if (/git\s+commit|gh\s+pr\s+create|submit|publish|deploy/.test(command) || /deliver|submit|publish/.test(tool)) {
      return { call, phase: "Deliver", basis: command === "" ? `tool ${call.name}` : "recorded delivery command" };
    }
    if (/test|lint|build|check|verify|typecheck|vitest|playwright/.test(command) || /test|verify|check/.test(tool)) {
      return { call, phase: "Verify", basis: command === "" ? `tool ${call.name}` : "recorded verification command" };
    }
    return { call, phase: "Execute", basis: `tool ${call.name}` };
  });
}

export function activityPhaseSequence(calls: readonly ExperimentToolCall[]): ActivityPhase[] {
  const result: ActivityPhase[] = [];
  for (const activity of projectActivities(calls)) {
    if (result.at(-1) !== activity.phase) result.push(activity.phase);
  }
  return result;
}

function operationFrom(
  call: ExperimentToolCall,
  kind: ToolOperationKind,
  resource: string,
): Omit<ToolOperation, "id"> {
  return {
    callId: call.id,
    callSequence: call.sequence,
    callName: call.name,
    kind,
    resource,
    status: call.status,
  };
}

function operationKind(type: string | undefined, command: string, toolName: string): ToolOperationKind {
  const parsedType = type?.toLowerCase();
  if (parsedType === "read") return "read";
  if (parsedType === "search") return "search";
  if (parsedType === "list_files" || parsedType === "list") return "list";
  if (parsedType === "edit" || parsedType === "write" || parsedType === "patch") return "edit";
  const value = `${command} ${toolName}`.toLowerCase();
  if (/\b(read|cat|head|tail)\b/.test(value)) return "read";
  if (/\b(edit|write|patch|replace|delete|remove|move)\b/.test(value)) return "edit";
  if (/\b(search|find|grep)\b/.test(value)) return "search";
  if (/\b(list_files|list|ls|rg\s+--files)\b/.test(value)) return "list";
  if (/\b(test|lint|build|check|verify|typecheck|vitest|playwright)\b/.test(value)
    || /\bgit\s+(diff|status|show)\b/.test(value)) return "verify";
  return "command";
}

function operationResource(
  command: Record<string, unknown>,
  kind: ToolOperationKind,
  commandText: string,
): string {
  const path = stringValue(command.path);
  const query = stringValue(command.query);
  if (kind === "search" && query !== undefined) return normalizeOperationResource(query);
  if (path !== undefined && path !== "..") return normalizeOperationResource(path);
  return resourceFromVerification(commandText) ?? ".";
}

function commandTextFrom(input: Record<string, unknown> | null): string {
  const command = input?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === "string").join(" ");
  return "";
}

function resourceFromToolName(name: string): string | null {
  const match = name.match(/<trial-root>[\\/]([^,]+?)(?:\s*$|,)/);
  return match?.[1] === undefined ? null : normalizeOperationResource(match[1]);
}

function resourceFromVerification(command: string, result?: string): string | null {
  const argument = command.match(/\bgit\s+diff\b[^;&|]*?\s--\s+["']?([^\s"';&|]+)/)?.[1];
  if (argument !== undefined) return normalizeOperationResource(argument);
  if (result === undefined) return null;
  const parsed = parseResult(result);
  const output = [parsed?.stdout, parsed?.aggregated_output, parsed?.formatted_output]
    .find((value): value is string => typeof value === "string");
  const diff = output?.match(/diff --git a\/([^\s]+) b\/[^\s]+/)?.[1];
  return diff === undefined ? null : normalizeOperationResource(diff);
}

function normalizeOperationResource(value: string): string {
  const normalized = normalizeResource(value).replace(/^command:/, "");
  const worktree = normalized.lastIndexOf("/worktree/");
  if (worktree >= 0) return normalized.slice(worktree + "/worktree/".length);
  if (/^(?:[A-Za-z]:)?\//.test(normalized)) return normalized.split("/").at(-1) ?? normalized;
  return normalized === "" ? "." : normalized;
}

function parseResult(result: string | undefined): Record<string, unknown> | null {
  if (result === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed !== "string") return objectRecord(parsed);
    return objectRecord(JSON.parse(parsed));
  } catch {
    return null;
  }
}

function resultExcerpt(parsed: Record<string, unknown> | null, raw: string | undefined): string | undefined {
  const value = [parsed?.stderr, parsed?.stdout, parsed?.formatted_output, raw]
    .find((item): item is string => typeof item === "string" && item.trim() !== "");
  if (value === undefined) return undefined;
  const normalizedLines = value.includes("\n") ? value : value.replaceAll("/n", "\n");
  const redacted = normalizedLines
    .replaceAll("\\n", "\n")
    .replace(/(?:\/[A-Za-z0-9._-]+)+\/worktree\//g, "<trial-root>/")
    .trim();
  return redacted.length <= 1_200 ? redacted : `${redacted.slice(0, 1_200)}\n…`;
}

function durationFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const record = objectRecord(value);
  if (record === null) return undefined;
  const seconds = numberValue(record.secs) ?? 0;
  const nanos = numberValue(record.nanos) ?? 0;
  return Math.round(seconds * 1_000 + nanos / 1_000_000);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resourceFrom(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target", "uri"] as const) {
    if (typeof record[key] === "string" && record[key].trim() !== "") {
      return normalizeResource(record[key]);
    }
  }
  if (typeof record.command === "string" && record.command.trim() !== "") {
    return `command:${record.command.trim().replace(/\s+/g, " ")}`;
  }
  if (typeof record.pattern === "string" && record.pattern.trim() !== "") {
    return `pattern:${record.pattern.trim()}`;
  }
  return null;
}

function normalizeResource(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^<trial-root>\//, "")
    .replace(/\/+/g, "/");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
