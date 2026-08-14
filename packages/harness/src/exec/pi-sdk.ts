import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessIrBundle, HarnessRevision } from "../ir/index.js";
import {
  assertRevisionHost,
  buildRunPrompt,
  type HarnessExecutor,
  type HarnessRunResult,
  type HarnessRunTask,
} from "./executor.js";

const PI_SDK_MODULE = "@earendil-works/pi-coding-agent";

/**
 * Structural view of the Pi SDK surface this executor relies on
 * (`createAgentSession`, `SessionManager.inMemory`, and `ModelRuntime.create`).
 * Tests inject a stub through `loadSdk`.
 */
export interface PiSdkLike {
  createAgentSession(config: {
    cwd?: string;
    sessionManager: unknown;
    modelRuntime: unknown;
    model?: unknown;
    noTools?: "all";
  }): Promise<{
    session: {
      prompt(text: string): Promise<void>;
      subscribe?(listener: (event: PiSdkEvent) => void): (() => void) | void;
      dispose?(): void;
    };
  }>;
  SessionManager: { inMemory(): unknown };
  ModelRuntime: { create(): Promise<PiModelRuntimeLike> };
}

export interface PiModelRuntimeLike {
  setRuntimeApiKey?(providerId: string, apiKey: string): Promise<void>;
  getModels?(providerId?: string): readonly unknown[];
}

interface PiSdkEvent {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  };
}

export interface PiSdkExecutorOptions {
  /** Injectable SDK loader; defaults to importing the optional peer dependency. */
  loadSdk?: () => Promise<PiSdkLike>;
  /** In-memory credential/runtime setup; callers must not log credential values. */
  configureModelRuntime?: (runtime: PiModelRuntimeLike) => Promise<void> | void;
  /** Optional explicit model selection after runtime configuration. */
  selectModel?: (runtime: PiModelRuntimeLike) => Promise<unknown> | unknown;
}

/**
 * Executes a resolved revision through the Pi coding agent SDK
 * (`@earendil-works/pi-coding-agent`, an optional peer dependency).
 */
export class PiSdkExecutor implements HarnessExecutor {
  readonly host = "pi";
  private readonly loadSdk: () => Promise<PiSdkLike>;
  private readonly configureModelRuntime?: PiSdkExecutorOptions["configureModelRuntime"];
  private readonly selectModel?: PiSdkExecutorOptions["selectModel"];

  constructor(options: PiSdkExecutorOptions = {}) {
    this.loadSdk = () => loadPiSdk(options.loadSdk);
    this.configureModelRuntime = options.configureModelRuntime;
    this.selectModel = options.selectModel;
  }

  async execute(
    revision: HarnessRevision,
    bundle: HarnessIrBundle,
    task: HarnessRunTask,
  ): Promise<HarnessRunResult> {
    assertRevisionHost(revision, this.host);
    const { prompt, warnings } = buildRunPrompt(revision, bundle, task);
    const sdk = await this.loadSdk();
    const modelRuntime = await sdk.ModelRuntime.create();
    await this.configureModelRuntime?.(modelRuntime);
    const model = await this.selectModel?.(modelRuntime);
    const { session } = await sdk.createAgentSession({
      cwd: task.cwd,
      sessionManager: sdk.SessionManager.inMemory(),
      modelRuntime,
      ...(model !== undefined ? { model } : {}),
      noTools: "all",
    });
    let streamedOutput = "";
    let errorOutput = "";
    const unsubscribe = session.subscribe?.((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta" &&
        typeof event.assistantMessageEvent.delta === "string"
      ) {
        streamedOutput += event.assistantMessageEvent.delta;
      }
      if (
        event.type === "message_end" &&
        event.message?.role === "assistant" &&
        (event.message.stopReason === "error" || event.message.stopReason === "aborted")
      ) {
        errorOutput =
          event.message.errorMessage ?? `Pi SDK stopped with '${event.message.stopReason}'.`;
      }
    });
    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe?.();
      session.dispose?.();
    }
    return {
      host: this.host,
      revisionId: revision.revisionId,
      exitCode: errorOutput ? 1 : 0,
      output: streamedOutput,
      errorOutput,
      warnings,
    };
  }
}

async function loadPiSdk(loader?: () => Promise<PiSdkLike>): Promise<PiSdkLike> {
  try {
    if (loader) {
      return await loader();
    }
    const moduleName = PI_SDK_MODULE;
    const sdk = await import(moduleName);
    return {
      createAgentSession: sdk.createAgentSession,
      SessionManager: sdk.SessionManager,
      ModelRuntime: sdk.ModelRuntime,
    } as PiSdkLike;
  } catch (error) {
    throw new Error(
      `The Pi executor needs the optional peer dependency '${PI_SDK_MODULE}'. ` +
        `Install it with: npm install ${PI_SDK_MODULE}`,
      { cause: error },
    );
  }
}

/**
 * Materialize a revision as an installable Pi package directory:
 * a `package.json` with the `pi.skills` contribution plus one
 * `skills/<component>/SKILL.md` per advisory skill-shaped component.
 * Returns the relative paths that were written.
 */
export async function materializePiPackage(
  revision: HarnessRevision,
  bundle: HarnessIrBundle,
  directory: string,
): Promise<string[]> {
  assertRevisionHost(revision, "pi");
  const written: string[] = [];
  const manifest = {
    name: `harness-revision-${revision.revisionId.slice(3, 15)}`,
    version: "0.0.0",
    private: true,
    description: `Materialized harness revision ${revision.revisionId} for host '${revision.target.host}'.`,
    pi: { skills: ["./skills"] },
  };
  await mkdir(directory, { recursive: true });
  const existingEntries = await readdir(directory);
  if (existingEntries.length > 0) {
    throw new Error(
      `Pi package destination must be empty: '${directory}' contains ${existingEntries.length} ` +
        `existing ${existingEntries.length === 1 ? "entry" : "entries"}.`,
    );
  }
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  written.push("package.json");

  for (const realization of revision.realization) {
    if (realization.action === "failed" || realization.realized !== "advisory") {
      continue;
    }
    const contract = bundle.components.find((component) => component.id === realization.componentId);
    if (!contract || contract.componentKind !== "skill") {
      continue;
    }
    const skillDir = join(directory, "skills", contract.id);
    await mkdir(skillDir, { recursive: true });
    const description = contract.description ?? `Harness component '${contract.id}'.`;
    const body = [
      "---",
      `name: ${contract.id}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      description,
      "",
      `Provenance: harness revision ${revision.revisionId}, component hash ` +
        `${revision.resolved.components.find((entry) => entry.id === contract.id)?.contentHash ?? "unknown"}.`,
      "",
    ].join("\n");
    await writeFile(join(skillDir, "SKILL.md"), body, "utf8");
    written.push(join("skills", contract.id, "SKILL.md"));
  }
  return written;
}
