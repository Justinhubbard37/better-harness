import type { HarnessIrBundle, HarnessRevision } from "../ir/index.js";
import {
  assertRevisionHost,
  buildRunPrompt,
  type HarnessExecutor,
  type HarnessRunResult,
  type HarnessRunTask,
} from "./executor.js";

const QODER_SDK_MODULE = "@qoder-ai/qoder-agent-sdk";

export interface QoderSdkTextBlock {
  type: string;
  text?: string;
}

export interface QoderSdkMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  errors?: string[];
  result?: unknown;
  message?: { content?: QoderSdkTextBlock[] };
}

export interface QoderSdkLike {
  query(params: {
    prompt: string;
    options: {
      auth: unknown;
      cwd?: string;
      allowedTools: string[];
      tools: string[];
      persistSession: boolean;
      maxTurns: number;
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
  /** Defaults to an ephemeral one-turn query. */
  persistSession?: boolean;
  maxTurns?: number;
}

/** Execute one resolved revision through the official Qoder Agent SDK. */
export class QoderSdkExecutor implements HarnessExecutor {
  readonly host = "qoder";
  private readonly loadSdk: () => Promise<QoderSdkLike>;
  private readonly auth: QoderAuthFactory;
  private readonly allowedTools: string[];
  private readonly tools: string[];
  private readonly persistSession: boolean;
  private readonly maxTurns: number;

  constructor(options: QoderSdkExecutorOptions = {}) {
    this.loadSdk = () => loadQoderSdk(options.loadSdk);
    this.auth = options.auth ?? ((sdk) => sdk.qodercliAuth());
    this.allowedTools = [...(options.allowedTools ?? [])];
    this.tools = [...(options.tools ?? [])];
    this.persistSession = options.persistSession ?? false;
    this.maxTurns = options.maxTurns ?? 1;
  }

  async execute(
    revision: HarnessRevision,
    bundle: HarnessIrBundle,
    task: HarnessRunTask,
  ): Promise<HarnessRunResult> {
    assertRevisionHost(revision, this.host);
    const { prompt, warnings } = buildRunPrompt(revision, bundle, task);
    const sdk = await this.loadSdk();
    const stream = sdk.query({
      prompt,
      options: {
        auth: this.auth(sdk),
        cwd: task.cwd,
        allowedTools: [...this.allowedTools],
        tools: [...this.tools],
        persistSession: this.persistSession,
        maxTurns: this.maxTurns,
      },
    });
    const output: string[] = [];
    const errors: string[] = [];
    let exitCode = 0;
    let sawResult = false;
    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            output.push(block.text);
          }
        }
      }
      if (message.type === "result") {
        sawResult = true;
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
    };
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
