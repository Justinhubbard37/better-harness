import type {
  ArtifactBundle,
  ExecutionOptions,
  ExecutionOptionsFor,
  ExecutionPlan,
  ExecutionReceipt,
  ProgrammableWorkspace,
  ProgrammableWorkspaceDriver,
  Snapshot,
  SnapshotRef,
  VerificationReport,
  WorkspaceDescriptor,
  WorkspaceDomainTypes,
  WorkspaceProposal,
} from "./contracts.js";

export type WorkspaceProtocolErrorCode =
  | "domain_mismatch"
  | "workspace_mismatch"
  | "stale_snapshot"
  | "invalid_plan"
  | "invalid_execution_mode";

export class WorkspaceProtocolError extends Error {
  readonly code: WorkspaceProtocolErrorCode;
  readonly details?: unknown;

  constructor(code: WorkspaceProtocolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkspaceProtocolError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Domain-neutral protocol shell. Drivers remain responsible for authoritative
 * revision checks at the real commit or run boundary; these checks fail early
 * for agents and prevent malformed plans from reaching a driver.
 */
export class ProgrammableWorkspaceRuntime<TDomain extends WorkspaceDomainTypes>
  implements ProgrammableWorkspace<TDomain>
{
  readonly descriptor: WorkspaceDescriptor;
  private readonly driver: ProgrammableWorkspaceDriver<TDomain>;

  constructor(driver: ProgrammableWorkspaceDriver<TDomain>) {
    this.driver = driver;
    this.descriptor = driver.descriptor;
  }

  inspect(query: TDomain["query"]): Promise<Snapshot<TDomain["observation"]>> {
    return this.driver.inspect(query);
  }

  async plan(
    proposal: WorkspaceProposal<TDomain["change"]>,
  ): Promise<ExecutionPlan<TDomain["operation"], TDomain["effect"]>> {
    this.assertDomain(proposal.domain);
    await this.assertFresh(proposal.base);

    const plan = await this.driver.plan(proposal);
    this.assertPlan(plan, proposal);
    return plan;
  }

  async execute<TPlan extends ExecutionPlan<TDomain["operation"], TDomain["effect"]>>(
    plan: TPlan,
    options: ExecutionOptionsFor<TPlan>,
  ): Promise<ExecutionReceipt<TDomain["observation"], TDomain["effect"]>> {
    this.assertDomain(plan.domain);
    this.assertExecutionMode(plan, options);
    if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new WorkspaceProtocolError(
        "invalid_plan",
        "A plan with error diagnostics cannot be executed.",
        { diagnostics: plan.diagnostics },
      );
    }
    await this.assertFresh(plan.base);
    return this.driver.execute(plan, options);
  }

  verify(request: TDomain["verificationRequest"]): Promise<VerificationReport> {
    return this.driver.verify(request);
  }

  artifacts(request: TDomain["artifactRequest"]): Promise<ArtifactBundle> {
    return this.driver.artifacts(request);
  }

  close(): Promise<void> {
    return this.driver.close();
  }

  private assertDomain(domain: string): void {
    if (domain !== this.descriptor.domain) {
      throw new WorkspaceProtocolError(
        "domain_mismatch",
        `Expected domain ${this.descriptor.domain}, received ${domain}.`,
      );
    }
  }

  private async assertFresh(expected: SnapshotRef): Promise<void> {
    if (expected.workspaceId !== this.descriptor.id) {
      throw new WorkspaceProtocolError(
        "workspace_mismatch",
        `Expected workspace ${this.descriptor.id}, received ${expected.workspaceId}.`,
      );
    }

    const actual = await this.driver.currentRef();
    const staleClocks = differingClocks(expected, actual);
    if (staleClocks.length > 0) {
      throw new WorkspaceProtocolError(
        "stale_snapshot",
        `Snapshot is stale for: ${staleClocks.join(", ")}.`,
        { expected, actual, staleClocks },
      );
    }
  }

  private assertPlan(
    plan: ExecutionPlan<TDomain["operation"], TDomain["effect"]>,
    proposal: WorkspaceProposal<TDomain["change"]>,
  ): void {
    if (plan.domain !== proposal.domain || plan.intent !== proposal.intent) {
      throw new WorkspaceProtocolError(
        "invalid_plan",
        "Planned proposal changed the domain or intent.",
      );
    }

    const changedBaseClocks = differingClocks(proposal.base, plan.base);
    if (
      plan.base.workspaceId !== proposal.base.workspaceId ||
      changedBaseClocks.length > 0
    ) {
      throw new WorkspaceProtocolError(
        "invalid_plan",
        "Planned proposal dropped or changed its base revision.",
        { proposalBase: proposal.base, planBase: plan.base, changedBaseClocks },
      );
    }
  }

  private assertExecutionMode(
    plan: ExecutionPlan<TDomain["operation"], TDomain["effect"]>,
    options: ExecutionOptions,
  ): void {
    const valid =
      (plan.kind === "transaction" &&
        (options.mode === "preview" || options.mode === "commit")) ||
      (plan.kind === "scenario" && options.mode === "run");

    if (!valid) {
      throw new WorkspaceProtocolError(
        "invalid_execution_mode",
        `Execution mode ${options.mode} is invalid for a ${plan.kind} plan.`,
      );
    }
  }
}

function differingClocks(expected: SnapshotRef, actual: SnapshotRef): string[] {
  return Object.entries(expected.revisions)
    .filter(([clock, revision]) => actual.revisions[clock] !== revision)
    .map(([clock]) => clock);
}
