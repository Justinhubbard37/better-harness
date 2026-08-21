export const ARTIFACT_WORKSPACE_PROTOCOL_VERSION = 1 as const;

export type PlanKind = "transaction" | "scenario";

export type RevisionVector = Readonly<Record<string, string>>;

/** A domain may expose one clock or several independently changing clocks. */
export interface SnapshotRef {
  workspaceId: string;
  revisions: RevisionVector;
}

export interface Snapshot<T> {
  ref: SnapshotRef;
  value: T;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

/** Associated domain types required by the common workspace protocol. */
export interface WorkspaceDomainTypes {
  open: unknown;
  query: unknown;
  observation: unknown;
  change: unknown;
  operation: unknown;
  effect: unknown;
  verificationRequest: unknown;
  artifactRequest: unknown;
}

export interface DomainManifest {
  id: string;
  version: string;
  planKinds: readonly PlanKind[];
}

export interface WorkspaceDescriptor {
  id: string;
  domain: string;
  capabilities: readonly string[];
}

/** A revision-bound proposal that has not yet become an executable plan. */
export interface WorkspaceProposal<TChange> {
  schemaVersion: typeof ARTIFACT_WORKSPACE_PROTOCOL_VERSION;
  domain: string;
  intent: string;
  base: SnapshotRef;
  change: TChange;
}

interface BasePlan<TEffect> {
  schemaVersion: typeof ARTIFACT_WORKSPACE_PROTOCOL_VERSION;
  id: string;
  domain: string;
  intent: string;
  base: SnapshotRef;
  predictedEffect?: TEffect;
  diagnostics: readonly Diagnostic[];
}

/** Atomic artifact mutation: preview in a sandbox, then explicitly commit. */
export interface TransactionPlan<TOperation, TEffect> extends BasePlan<TEffect> {
  kind: "transaction";
  operations: readonly TOperation[];
  reversible: boolean;
}

export interface ScenarioStep<TOperation> {
  id: string;
  operation: TOperation;
  checkpoint?: boolean;
}

/** Stateful interaction: preflight the scenario, then run checkpoint by checkpoint. */
export interface ScenarioPlan<TOperation, TEffect> extends BasePlan<TEffect> {
  kind: "scenario";
  steps: readonly ScenarioStep<TOperation>[];
}

export type ExecutionPlan<TOperation, TEffect> =
  | TransactionPlan<TOperation, TEffect>
  | ScenarioPlan<TOperation, TEffect>;

export interface TransactionExecutionOptions {
  mode: "preview" | "commit";
  signal?: AbortSignal;
}

export interface ScenarioExecutionOptions {
  mode: "run";
  signal?: AbortSignal;
}

export type ExecutionOptions = TransactionExecutionOptions | ScenarioExecutionOptions;

export type ExecutionOptionsFor<TPlan> = TPlan extends TransactionPlan<unknown, unknown>
  ? TransactionExecutionOptions
  : TPlan extends ScenarioPlan<unknown, unknown>
    ? ScenarioExecutionOptions
    : never;

export interface ArtifactRef {
  id: string;
  role: "primary" | "sidecar" | "evidence" | "trace";
  mediaType: string;
  uri?: string;
  data?: Uint8Array;
  /** Algorithm-prefixed content digest, for example `sha256:<hex>`. */
  digest?: string;
}

export interface ArtifactBundle {
  artifacts: readonly ArtifactRef[];
}

export interface VerificationCheck {
  id: string;
  status: "passed" | "failed" | "skipped" | "unavailable";
  diagnostics: readonly Diagnostic[];
  evidence?: readonly ArtifactRef[];
}

export interface VerificationReport {
  status: "passed" | "failed" | "partial" | "unavailable";
  checks: readonly VerificationCheck[];
}

export interface ExecutionReceipt<TObservation, TEffect> {
  planId: string;
  status: "previewed" | "committed" | "succeeded" | "blocked" | "failed";
  before: SnapshotRef;
  after?: SnapshotRef;
  effect?: TEffect;
  observation?: Snapshot<TObservation>;
  diagnostics: readonly Diagnostic[];
  verification?: VerificationReport;
  artifacts?: ArtifactBundle;
}

export interface ProgrammableDomain<TDomain extends WorkspaceDomainTypes> {
  readonly manifest: DomainManifest;
  open(input: TDomain["open"]): Promise<ProgrammableWorkspace<TDomain>>;
}

export interface ProgrammableWorkspace<TDomain extends WorkspaceDomainTypes> {
  readonly descriptor: WorkspaceDescriptor;

  inspect(query: TDomain["query"]): Promise<Snapshot<TDomain["observation"]>>;

  plan(
    proposal: WorkspaceProposal<TDomain["change"]>,
  ): Promise<ExecutionPlan<TDomain["operation"], TDomain["effect"]>>;

  execute<TPlan extends ExecutionPlan<TDomain["operation"], TDomain["effect"]>>(
    plan: TPlan,
    options: ExecutionOptionsFor<TPlan>,
  ): Promise<ExecutionReceipt<TDomain["observation"], TDomain["effect"]>>;

  verify(request: TDomain["verificationRequest"]): Promise<VerificationReport>;

  artifacts(request: TDomain["artifactRequest"]): Promise<ArtifactBundle>;

  close(): Promise<void>;
}

/**
 * A domain adapter owns parsing, lowering, mutation and real verification.
 * The common runtime only enforces cross-domain protocol invariants.
 */
export interface ProgrammableWorkspaceDriver<TDomain extends WorkspaceDomainTypes> {
  readonly descriptor: WorkspaceDescriptor;

  currentRef(): Promise<SnapshotRef>;

  inspect(query: TDomain["query"]): Promise<Snapshot<TDomain["observation"]>>;

  plan(
    proposal: WorkspaceProposal<TDomain["change"]>,
  ): Promise<ExecutionPlan<TDomain["operation"], TDomain["effect"]>>;

  execute(
    plan: ExecutionPlan<TDomain["operation"], TDomain["effect"]>,
    options: ExecutionOptions,
  ): Promise<ExecutionReceipt<TDomain["observation"], TDomain["effect"]>>;

  verify(request: TDomain["verificationRequest"]): Promise<VerificationReport>;

  artifacts(request: TDomain["artifactRequest"]): Promise<ArtifactBundle>;

  close(): Promise<void>;
}
