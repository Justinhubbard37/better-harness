import { describe, expect, it } from "vitest";
import {
  ARTIFACT_WORKSPACE_PROTOCOL_VERSION,
  ProgrammableWorkspaceRuntime,
  WorkspaceProtocolError,
  type ArtifactBundle,
  type ExecutionOptions,
  type ExecutionPlan,
  type ExecutionReceipt,
  type ProgrammableWorkspaceDriver,
  type Snapshot,
  type SnapshotRef,
  type VerificationReport,
  type WorkspaceDomainTypes,
  type WorkspaceProposal,
} from "../src/artifact-workspace/index.js";

interface DemoWorkspaceTypes extends WorkspaceDomainTypes {
  open: never;
  query: { kind: "state" };
  observation: { value: number };
  change:
    | { kind: "transaction"; delta: number; invalid?: boolean }
    | { kind: "scenario"; delta: number };
  operation: { kind: "add"; value: number };
  effect: { delta: number };
  verificationRequest: { level: "structural" };
  artifactRequest: { role: "primary" };
}

class DemoDriver implements ProgrammableWorkspaceDriver<DemoWorkspaceTypes> {
  readonly descriptor = {
    id: "workspace-1",
    domain: "demo",
    capabilities: ["inspect", "plan", "execute", "verify", "artifacts"],
  } as const;

  planCalls = 0;
  executeCalls = 0;
  private value = 0;
  private revisions: Record<string, string> = { artifact: "1", session: "1", ui: "1" };

  currentRef(): Promise<SnapshotRef> {
    return Promise.resolve(this.ref());
  }

  inspect(_query: DemoWorkspaceTypes["query"]): Promise<Snapshot<DemoWorkspaceTypes["observation"]>> {
    return Promise.resolve({ ref: this.ref(), value: { value: this.value } });
  }

  plan(
    proposal: WorkspaceProposal<DemoWorkspaceTypes["change"]>,
  ): Promise<ExecutionPlan<DemoWorkspaceTypes["operation"], DemoWorkspaceTypes["effect"]>> {
    this.planCalls += 1;
    const common = {
      schemaVersion: ARTIFACT_WORKSPACE_PROTOCOL_VERSION,
      id: `plan-${this.planCalls}`,
      domain: proposal.domain,
      intent: proposal.intent,
      base: proposal.base,
      predictedEffect: { delta: proposal.change.delta },
      diagnostics: proposal.change.kind === "transaction" && proposal.change.invalid === true
        ? [{ severity: "error" as const, code: "demo.invalid", message: "Invalid demo change." }]
        : [],
    };
    const operation = { kind: "add" as const, value: proposal.change.delta };
    return Promise.resolve(proposal.change.kind === "transaction"
      ? { ...common, kind: "transaction", operations: [operation], reversible: true }
      : { ...common, kind: "scenario", steps: [{ id: "step-1", operation, checkpoint: true }] });
  }

  execute(
    plan: ExecutionPlan<DemoWorkspaceTypes["operation"], DemoWorkspaceTypes["effect"]>,
    options: ExecutionOptions,
  ): Promise<ExecutionReceipt<DemoWorkspaceTypes["observation"], DemoWorkspaceTypes["effect"]>> {
    this.executeCalls += 1;
    const before = this.ref();
    const delta = plan.predictedEffect?.delta ?? 0;
    if (plan.kind === "transaction") {
      if (options.mode === "run") throw new Error("Runtime must reject run before delegation.");
      if (options.mode === "commit") {
        this.value += delta;
        this.bump("artifact");
      }
      return Promise.resolve({
        planId: plan.id,
        status: options.mode === "preview" ? "previewed" : "committed",
        before,
        after: this.ref(),
        effect: { delta },
        diagnostics: [],
      });
    }
    if (options.mode !== "run") throw new Error("Runtime must reject transaction mode before delegation.");
    this.value += delta;
    this.bump("ui");
    return Promise.resolve({
      planId: plan.id,
      status: "succeeded",
      before,
      after: this.ref(),
      effect: { delta },
      observation: { ref: this.ref(), value: { value: this.value } },
      diagnostics: [],
    });
  }

  verify(_request: DemoWorkspaceTypes["verificationRequest"]): Promise<VerificationReport> {
    return Promise.resolve({ status: "passed", checks: [] });
  }

  artifacts(_request: DemoWorkspaceTypes["artifactRequest"]): Promise<ArtifactBundle> {
    return Promise.resolve({ artifacts: [] });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  setRevision(clock: string, revision: string): void {
    this.revisions[clock] = revision;
  }

  private bump(clock: string): void {
    this.revisions[clock] = String(Number(this.revisions[clock]) + 1);
  }

  private ref(): SnapshotRef {
    return { workspaceId: this.descriptor.id, revisions: { ...this.revisions } };
  }
}

describe("artifact workspace runtime", () => {
  it("previews and explicitly commits a revision-bound transaction", async () => {
    const driver = new DemoDriver();
    const workspace = new ProgrammableWorkspaceRuntime<DemoWorkspaceTypes>(driver);
    const plan = await workspace.plan({
      schemaVersion: ARTIFACT_WORKSPACE_PROTOCOL_VERSION,
      domain: "demo",
      intent: "increase the artifact value",
      base: await driver.currentRef(),
      change: { kind: "transaction", delta: 2 },
    });
    if (plan.kind !== "transaction") throw new Error("Expected a transaction plan.");

    expect((await workspace.execute(plan, { mode: "preview" })).status).toBe("previewed");
    expect((await workspace.inspect({ kind: "state" })).value.value).toBe(0);
    expect((await workspace.execute(plan, { mode: "commit" })).status).toBe("committed");
    expect((await workspace.inspect({ kind: "state" })).value.value).toBe(2);
  });

  it("runs scenarios but rejects execution modes from another plan kind", async () => {
    const driver = new DemoDriver();
    const workspace = new ProgrammableWorkspaceRuntime<DemoWorkspaceTypes>(driver);
    const plan = await workspace.plan({
      schemaVersion: ARTIFACT_WORKSPACE_PROTOCOL_VERSION,
      domain: "demo",
      intent: "interact with a live workspace",
      base: await driver.currentRef(),
      change: { kind: "scenario", delta: 3 },
    });
    if (plan.kind !== "scenario") throw new Error("Expected a scenario plan.");

    expect((await workspace.execute(plan, { mode: "run" })).observation?.value.value).toBe(3);
    await expect(workspace.execute(plan, { mode: "commit" } as never)).rejects.toMatchObject({
      code: "invalid_execution_mode",
    });
    expect(driver.executeCalls).toBe(1);
  });

  it("fails closed on stale clocks and error-bearing plans before delegation", async () => {
    const driver = new DemoDriver();
    const workspace = new ProgrammableWorkspaceRuntime<DemoWorkspaceTypes>(driver);
    const base = await driver.currentRef();
    driver.setRevision("ui", "2");

    await expect(workspace.plan({
      schemaVersion: ARTIFACT_WORKSPACE_PROTOCOL_VERSION,
      domain: "demo",
      intent: "plan against stale UI",
      base,
      change: { kind: "scenario", delta: 1 },
    })).rejects.toMatchObject({ code: "stale_snapshot" });
    expect(driver.planCalls).toBe(0);

    driver.setRevision("ui", "1");
    const invalid = await workspace.plan({
      schemaVersion: ARTIFACT_WORKSPACE_PROTOCOL_VERSION,
      domain: "demo",
      intent: "reject an invalid proposal",
      base,
      change: { kind: "transaction", delta: 1, invalid: true },
    });
    await expect(workspace.execute(invalid, { mode: "commit" } as never)).rejects.toSatisfy(
      (error: unknown) => error instanceof WorkspaceProtocolError && error.code === "invalid_plan",
    );
    expect(driver.executeCalls).toBe(0);
  });
});
