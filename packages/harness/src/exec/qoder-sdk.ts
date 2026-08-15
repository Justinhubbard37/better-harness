import type { HarnessIrBundle, HarnessRevision } from "../ir/index.js";
import {
  assertRevisionHost,
  buildRunPrompt,
  type HarnessExecutor,
  type HarnessRunResult,
  type HarnessRunTask,
} from "./executor.js";

const QODER_SDK_MODULE = "@qoder-ai/qoder-agent-sdk";

export type QoderRuntimeProfile = "qoder-default-v1" | "qoder-minimal-v1";

const QODER_MINIMAL_TOOLS = ["Read", "Write", "Edit", "Bash"] as const;
const QODER_MINIMAL_DENIED_TOOLS = ["WebFetch", "WebSearch", "Agent", "Task"] as const;
type QoderSettingSource = "user" | "project" | "local";
type QoderSystemPrompt = string | {
  type: "preset";
  preset: "qodercli";
  append?: string;
};

export interface QoderSdkTextBlock {
  type: string;
  text?: string;
}

export interface QoderSdkMessage {
  [key: string]: unknown;
  type: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  errors?: string[];
  result?: unknown;
  message?: { content?: QoderSdkTextBlock[] };
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  total_credits?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  session_id?: string;
  stop_reason?: string | null;
  terminal_reason?: string | null;
}

export type QoderPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "yolo"
  | "plan"
  | "dontAsk"
  | "auto";

export type QoderToolPermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type QoderToolPermissionCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown },
) => Promise<QoderToolPermissionResult>;

export interface QoderSdkLike {
  query(params: {
    prompt: string;
    options: {
      auth: unknown;
      cwd?: string;
      allowedTools: string[];
      tools: string[];
      disallowedTools?: string[];
      permissionMode?: QoderPermissionMode;
      canUseTool?: QoderToolPermissionCallback;
      persistSession: boolean;
      maxTurns: number;
      model?: string;
      enableFileCheckpointing?: boolean;
      abortController?: AbortController;
      settingSources?: QoderSettingSource[];
      skills?: string[] | "all";
      extensions?: string[];
      plugins?: unknown[];
      mcpServers?: Record<string, unknown>;
      strictMcpConfig?: boolean;
      systemPrompt?: QoderSystemPrompt;
    };
  }): AsyncIterable<QoderSdkMessage>;
  qodercliAuth(): unknown;
}

export type QoderAuthFactory = (sdk: QoderSdkLike) => unknown;

export interface QoderSdkExecutorOptions {
  /** Injectable SDK loader for deterministic tests. */
  loadSdk?: () => Promise<QoderSdkLike>;
  /** Defaults to the locally signed-in qodercli session. */
  auth?: QoderAuthFactory;
  /** Explicit SDK tool allowlist. v0.1 defaults to no pre-authorized tools. */
  allowedTools?: string[];
  /** Tools visible to the session. v0.1 defaults to none. */
  tools?: string[];
  /** Tools removed from the session even when the runtime would normally expose them. */
  disallowedTools?: string[];
  permissionMode?: QoderPermissionMode;
  canUseTool?: QoderToolPermissionCallback;
  /** Defaults to an ephemeral one-turn query. */
  persistSession?: boolean;
  maxTurns?: number;
  model?: string;
  enableFileCheckpointing?: boolean;
  abortController?: AbortController;
  /** Receives each redacted SDK event as it arrives, including before a timeout. */
  onTraceEvent?: (event: unknown) => void;
  /** A frozen executor-owned runtime contract. Defaults to the SDK-compatible v1 behavior. */
  profile?: QoderRuntimeProfile;
}

/** Execute one resolved revision through the official Qoder Agent SDK. */
export class QoderSdkExecutor implements HarnessExecutor {
  readonly host = "qoder";
  private readonly loadSdk: () => Promise<QoderSdkLike>;
  private readonly auth: QoderAuthFactory;
  private readonly allowedTools: string[];
  private readonly tools: string[];
  private readonly disallowedTools: string[];
  private readonly permissionMode?: QoderPermissionMode;
  private readonly canUseTool?: QoderToolPermissionCallback;
  private readonly persistSession: boolean;
  private readonly maxTurns: number;
  private readonly model?: string;
  private readonly enableFileCheckpointing: boolean;
  private readonly abortController?: AbortController;
  private readonly onTraceEvent?: (event: unknown) => void;
  private readonly profile: QoderRuntimeProfile;
  private readonly settingSources?: QoderSettingSource[];
  private readonly skills?: string[] | "all";
  private readonly extensions?: string[];
  private readonly plugins?: unknown[];
  private readonly mcpServers?: Record<string, unknown>;
  private readonly strictMcpConfig?: boolean;

  constructor(options: QoderSdkExecutorOptions = {}) {
    this.profile = options.profile ?? "qoder-default-v1";
    assertSupportedProfile(this.profile);
    if (this.profile === "qoder-minimal-v1") {
      assertMinimalProfileOptions(options);
    }
    this.loadSdk = () => loadQoderSdk(options.loadSdk);
    this.auth = options.auth ?? ((sdk) => sdk.qodercliAuth());
    this.allowedTools = this.profile === "qoder-minimal-v1" ? [] : [...(options.allowedTools ?? [])];
    this.tools = this.profile === "qoder-minimal-v1"
      ? [...QODER_MINIMAL_TOOLS]
      : [...(options.tools ?? [])];
    this.disallowedTools = this.profile === "qoder-minimal-v1"
      ? unique([...QODER_MINIMAL_DENIED_TOOLS, ...(options.disallowedTools ?? [])])
      : [...(options.disallowedTools ?? [])];
    this.permissionMode = this.profile === "qoder-minimal-v1" ? "default" : options.permissionMode;
    this.canUseTool = options.canUseTool;
    this.persistSession = this.profile === "qoder-minimal-v1" ? false : (options.persistSession ?? false);
    this.maxTurns = options.maxTurns ?? 1;
    this.model = options.model;
    this.enableFileCheckpointing = options.enableFileCheckpointing ?? false;
    this.abortController = options.abortController;
    this.onTraceEvent = options.onTraceEvent;
    if (this.profile === "qoder-minimal-v1") {
      this.settingSources = [];
      this.skills = [];
      this.extensions = [];
      this.plugins = [];
      this.mcpServers = {};
      this.strictMcpConfig = true;
    }
  }

  async execute(
    revision: HarnessRevision,
    bundle: HarnessIrBundle,
    task: HarnessRunTask,
  ): Promise<HarnessRunResult> {
    assertRevisionHost(revision, this.host);
    const { prompt, warnings } = buildRunPrompt(revision, bundle, task);
    const sdk = await this.loadSdk();
    const systemPrompt = this.profile === "qoder-minimal-v1"
      ? buildQoderMinimalSystemPrompt(task.cwd)
      : undefined;
    const sdkOptions: Parameters<QoderSdkLike["query"]>[0]["options"] = {
      auth: this.auth(sdk),
      cwd: task.cwd,
      allowedTools: [...this.allowedTools],
      tools: [...this.tools],
      disallowedTools: [...this.disallowedTools],
      persistSession: this.persistSession,
      maxTurns: this.maxTurns,
      enableFileCheckpointing: this.enableFileCheckpointing,
      ...(this.permissionMode !== undefined ? { permissionMode: this.permissionMode } : {}),
      ...(this.canUseTool !== undefined ? { canUseTool: this.canUseTool } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.abortController !== undefined ? { abortController: this.abortController } : {}),
      ...(this.settingSources !== undefined ? { settingSources: [...this.settingSources] } : {}),
      ...(this.skills !== undefined ? { skills: Array.isArray(this.skills) ? [...this.skills] : this.skills } : {}),
      ...(this.extensions !== undefined ? { extensions: [...this.extensions] } : {}),
      ...(this.plugins !== undefined ? { plugins: [...this.plugins] } : {}),
      ...(this.mcpServers !== undefined ? { mcpServers: { ...this.mcpServers } } : {}),
      ...(this.strictMcpConfig !== undefined ? { strictMcpConfig: this.strictMcpConfig } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
    const stream = sdk.query({
      prompt,
      options: sdkOptions,
    });
    const output: string[] = [];
    const errors: string[] = [];
    const trace: unknown[] = [];
    let metrics: HarnessRunResult["metrics"];
    let exitCode = 0;
    let sawResult = false;
    for await (const message of stream) {
      const traceEvent = redactTraceValue(message);
      trace.push(traceEvent);
      this.onTraceEvent?.(traceEvent);
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            output.push(block.text);
          }
        }
      }
      if (message.type === "result") {
        sawResult = true;
        metrics = {
          ...(message.duration_ms !== undefined ? { durationMs: message.duration_ms } : {}),
          ...(message.duration_api_ms !== undefined ? { durationApiMs: message.duration_api_ms } : {}),
          ...(message.num_turns !== undefined ? { turns: message.num_turns } : {}),
          ...(message.total_cost_usd !== undefined ? { costUsd: message.total_cost_usd } : {}),
          ...(message.total_credits !== undefined ? { credits: message.total_credits } : {}),
          ...(message.usage !== undefined ? { usage: redactTraceValue(message.usage) as Record<string, unknown> } : {}),
          ...(message.modelUsage !== undefined
            ? { modelUsage: redactTraceValue(message.modelUsage) as Record<string, unknown> }
            : {}),
          ...(message.permission_denials !== undefined
            ? { permissionDenials: redactTraceValue(message.permission_denials) as unknown[] }
            : {}),
          ...(message.session_id !== undefined ? { sessionId: message.session_id } : {}),
          ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
          ...(message.terminal_reason ? { terminalReason: message.terminal_reason } : {}),
        };
        if (message.is_error === true || message.subtype !== "success") {
          exitCode = 1;
          errors.push(...(message.errors ?? [message.error ?? stringifyResult(message.result)]));
        }
      }
    }
    if (!sawResult) {
      exitCode = 1;
      errors.push("Qoder SDK query ended without a result message.");
    }
    return {
      host: this.host,
      revisionId: revision.revisionId,
      exitCode,
      output: output.join(""),
      errorOutput: errors.filter(Boolean).join("\n"),
      warnings,
      trace,
      runtimeReceipt: {
        executor: "@qoder-ai/qoder-agent-sdk",
        runtimeProfile: this.profile,
        tools: [...this.tools],
        allowedTools: [...this.allowedTools],
        disallowedTools: [...this.disallowedTools],
        ...(this.permissionMode !== undefined ? { permissionMode: this.permissionMode } : {}),
        maxTurns: this.maxTurns,
        persistSession: this.persistSession,
        ...(this.model !== undefined ? { model: this.model } : {}),
        fileCheckpointing: this.enableFileCheckpointing,
        permissionCallback: this.canUseTool ? "configured" : "none",
        systemPromptSource: systemPrompt === undefined ? "runtime-default" : "executor-profile",
        settingSources: this.settingSources === undefined ? "runtime-default" : [...this.settingSources],
        skills: this.skills === undefined
          ? "runtime-default"
          : Array.isArray(this.skills) ? [...this.skills] : this.skills,
        ...(this.extensions !== undefined ? { extensionCount: this.extensions.length } : {}),
        ...(this.plugins !== undefined ? { pluginCount: this.plugins.length } : {}),
        ...(this.mcpServers !== undefined ? { mcpServerNames: Object.keys(this.mcpServers).sort() } : {}),
        ...(this.strictMcpConfig !== undefined ? { strictMcpConfig: this.strictMcpConfig } : {}),
      },
      ...(metrics !== undefined ? { metrics } : {}),
    };
  }
}

function assertSupportedProfile(profile: QoderRuntimeProfile): void {
  if (profile !== "qoder-default-v1" && profile !== "qoder-minimal-v1") {
    throw new Error(`Unsupported Qoder runtime profile '${String(profile)}'.`);
  }
}

function assertMinimalProfileOptions(options: QoderSdkExecutorOptions): void {
  if (options.tools !== undefined && !sameToolSet(options.tools, QODER_MINIMAL_TOOLS)) {
    throw new Error(`qoder-minimal-v1 fixes the visible tools to: ${QODER_MINIMAL_TOOLS.join(", ")}.`);
  }
  if ((options.allowedTools?.length ?? 0) > 0) {
    throw new Error("qoder-minimal-v1 does not permit auto-approved tools; use canUseTool for bounded decisions.");
  }
  const minimalTools = new Set<string>(QODER_MINIMAL_TOOLS);
  const deniedRequired = options.disallowedTools?.filter((tool) => minimalTools.has(tool)) ?? [];
  if (deniedRequired.length > 0) {
    throw new Error(`qoder-minimal-v1 cannot disallow required tools: ${deniedRequired.join(", ")}.`);
  }
  if (options.permissionMode !== undefined && options.permissionMode !== "default") {
    throw new Error("qoder-minimal-v1 fixes permissionMode to 'default'.");
  }
  if (options.persistSession === true) {
    throw new Error("qoder-minimal-v1 requires an ephemeral session.");
  }
  if (options.canUseTool === undefined) {
    throw new Error("qoder-minimal-v1 requires canUseTool so every tool call has a host-owned decision.");
  }
}

function sameToolSet(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((tool) => actual.includes(tool));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildQoderMinimalSystemPrompt(cwd?: string): string {
  const workingDirectory = cwd ?? process.cwd();
  return [
    "You are a focused coding agent operating inside the host-supplied working directory.",
    `The working directory is ${JSON.stringify(workingDirectory)}. Use relative paths such as package.json; do not guess other absolute roots.`,
    "Use only the Read, Write, Edit, and Bash tools exposed by the host.",
    "Inspect repository evidence before editing, keep changes inside the requested scope, and verify the result.",
    "Use Bash only for validation commands explicitly allowed by the task or host policy.",
    "Do not access the network, invent repository facts, or report success without concrete validation evidence.",
  ].join("\n");
}

const SECRET_FIELD = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?account[_-]?key|secret|credential)/i;

/**
 * Recursively remove credential-shaped fields before persisting SDK events.
 *
 * Only the current ancestor chain is tracked, so a value referenced twice in
 * sibling positions is still recorded instead of being reported as a cycle.
 */
export function redactTraceValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactTraceValue(item, ancestors));
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SECRET_FIELD.test(key) ? "[REDACTED]" : redactTraceValue(item, ancestors);
    }
    return redacted;
  } finally {
    ancestors.delete(value);
  }
}

async function loadQoderSdk(loader?: () => Promise<QoderSdkLike>): Promise<QoderSdkLike> {
  try {
    if (loader) {
      return await loader();
    }
    const moduleName = QODER_SDK_MODULE;
    const sdk = await import(moduleName);
    return { query: sdk.query, qodercliAuth: sdk.qodercliAuth } as QoderSdkLike;
  } catch (error) {
    throw new Error(
      `The Qoder executor needs '${QODER_SDK_MODULE}'. Install workspace dependencies with: npm install`,
      { cause: error },
    );
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return result === undefined ? "Qoder SDK query failed." : JSON.stringify(result);
}
