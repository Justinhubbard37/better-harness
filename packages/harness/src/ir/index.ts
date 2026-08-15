/**
 * Versioned JSON intermediate representation for the Harness DSL.
 *
 * Every artifact carries `irVersion` plus a `kind` discriminator so stored
 * documents stay self-describing. The v0.2 entities follow the standard
 * resource model: capabilities (skill / tool / mcp), workflows, runtimes,
 * harnesses with agent roles, deployment targets, capability bindings,
 * HarnessRevision, and ResolutionReport. There is no generic plugin entity:
 * host-native assets appear only as binding mechanisms in a host namespace
 * (`qoder.plugin`, `pi.extension`).
 */
import { type Static, Type } from "@sinclair/typebox";

export const IR_VERSION = "0.2.0";

const IrVersion = Type.Literal(IR_VERSION);
const Identifier = Type.String({ pattern: "^[_a-zA-Z][\\w-]*$" });
const QualifiedIdentifier = Type.String({ pattern: "^[_a-zA-Z][\\w-]*(\\.[_a-zA-Z][\\w-]*)*$" });

export const StrengthSchema = Type.Union([
  Type.Literal("unsupported"),
  Type.Literal("advisory"),
  Type.Literal("wired"),
  Type.Literal("enforced"),
]);
export type Strength = Static<typeof StrengthSchema>;

export const CapabilityKindSchema = Type.Union([
  Type.Literal("skill"),
  Type.Literal("tool"),
  Type.Literal("mcp"),
]);
export type CapabilityKind = Static<typeof CapabilityKindSchema>;

export const PermissionGrantSchema = Type.Object(
  {
    domain: Type.Union([
      Type.Literal("workspace"),
      Type.Literal("process"),
      Type.Literal("network"),
      Type.Literal("model"),
    ]),
    access: Type.Union([
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("allow"),
      Type.Literal("deny"),
    ]),
  },
  { additionalProperties: false },
);
export type PermissionGrant = Static<typeof PermissionGrantSchema>;

export const ConfigValueSchema = Type.Union([
  Type.Object({ type: Type.Literal("int"), value: Type.Number() }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("duration"), value: Type.String(), ms: Type.Number() },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("string"), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("boolean"), value: Type.Boolean() }, { additionalProperties: false }),
]);
export type ConfigValue = Static<typeof ConfigValueSchema>;

export const ConfigEntrySchema = Type.Object(
  { key: Type.String(), value: ConfigValueSchema },
  { additionalProperties: false },
);
export type ConfigEntryIr = Static<typeof ConfigEntrySchema>;

/** Progressive knowledge: a source directory, inline guidance, or both. */
export const SkillIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("skill"),
    id: Identifier,
    source: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    permissions: Type.Array(PermissionGrantSchema),
  },
  { additionalProperties: false },
);
export type SkillIr = Static<typeof SkillIrSchema>;

/**
 * An atomic callable capability. `implicit` marks tools that were only ever
 * named by a `require tool` and never declared: a contract synthesized from
 * its dotted name, with no permissions of its own.
 */
export const ToolIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("tool"),
    id: QualifiedIdentifier,
    description: Type.Optional(Type.String()),
    inputs: Type.Array(Identifier),
    outputs: Type.Array(Identifier),
    permissions: Type.Array(PermissionGrantSchema),
    implicit: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ToolIr = Static<typeof ToolIrSchema>;

export const McpEndpointIrSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("env"), variable: Identifier },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("literal"), value: Type.String() },
    { additionalProperties: false },
  ),
]);
export type McpEndpointIr = Static<typeof McpEndpointIrSchema>;

/** A capability connection (transport + endpoint), not a tool itself. */
export const McpIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("mcp"),
    id: Identifier,
    transport: Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("sse")]),
    url: Type.Optional(McpEndpointIrSchema),
    command: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type McpIr = Static<typeof McpIrSchema>;

export type CapabilityIr = SkillIr | ToolIr | McpIr;

export const WorkflowEdgeSchema = Type.Object(
  { from: Identifier, to: Identifier },
  { additionalProperties: false },
);
export type WorkflowEdge = Static<typeof WorkflowEdgeSchema>;

export const WorkflowEventSchema = Type.Object(
  { agent: Identifier, outcome: Identifier, to: Identifier },
  { additionalProperties: false },
);
export type WorkflowEvent = Static<typeof WorkflowEventSchema>;

export const WorkflowStopSchema = Type.Object(
  { agent: Identifier, outcome: Identifier },
  { additionalProperties: false },
);
export type WorkflowStop = Static<typeof WorkflowStopSchema>;

/**
 * Control flow: a declarative graph of edges/events/stops, or a programmatic
 * controller in a named language. The two dimensions are independent of how
 * a runtime exposes capabilities (tool calling vs programmatic calling).
 */
export const WorkflowIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("workflow"),
    id: Identifier,
    mode: Type.Union([Type.Literal("declarative"), Type.Literal("programmatic")]),
    edges: Type.Array(WorkflowEdgeSchema),
    events: Type.Array(WorkflowEventSchema),
    stops: Type.Array(WorkflowStopSchema),
    program: Type.Optional(
      Type.Object(
        { language: Identifier, entry: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type WorkflowIr = Static<typeof WorkflowIrSchema>;

export const ExecutionIrSchema = Type.Union([
  Type.Object({ style: Type.Literal("tool-calling") }, { additionalProperties: false }),
  Type.Object(
    {
      style: Type.Literal("programmatic"),
      language: Identifier,
      options: Type.Array(
        Type.Object({ key: Identifier, value: Identifier }, { additionalProperties: false }),
      ),
    },
    { additionalProperties: false },
  ),
]);
export type ExecutionIr = Static<typeof ExecutionIrSchema>;

/** A concrete host with its adapter package and capability-calling style. */
export const RuntimeIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("runtime"),
    id: Identifier,
    adapter: Type.String(),
    execution: ExecutionIrSchema,
  },
  { additionalProperties: false },
);
export type RuntimeIr = Static<typeof RuntimeIrSchema>;

export const CapabilityRequirementIrSchema = Type.Object(
  {
    capabilityId: QualifiedIdentifier,
    capabilityKind: CapabilityKindSchema,
    preferred: Type.Optional(StrengthSchema),
    minimum: StrengthSchema,
    onDegrade: Type.Union([Type.Literal("fail"), Type.Literal("report")]),
  },
  { additionalProperties: false },
);
export type CapabilityRequirementIr = Static<typeof CapabilityRequirementIrSchema>;

export const AgentIrSchema = Type.Object(
  {
    id: Identifier,
    requirements: Type.Array(CapabilityRequirementIrSchema),
  },
  { additionalProperties: false },
);
export type AgentIr = Static<typeof AgentIrSchema>;

export const HarnessSpecIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("harness-spec"),
    id: Identifier,
    workflow: Identifier,
    agents: Type.Array(AgentIrSchema),
    settings: Type.Array(ConfigEntrySchema),
  },
  { additionalProperties: false },
);
export type HarnessSpecIr = Static<typeof HarnessSpecIrSchema>;

/** Deployment statement: harnesses in the bundle deploy to this runtime. */
export const TargetIrSchema = Type.Object(
  {
    runtime: Identifier,
    adapter: Type.Optional(Identifier),
  },
  { additionalProperties: false },
);
export type TargetIr = Static<typeof TargetIrSchema>;

export const CapabilityBindingIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("capability-binding"),
    capabilityId: QualifiedIdentifier,
    runtime: Identifier,
    mechanism: QualifiedIdentifier,
    strength: StrengthSchema,
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CapabilityBindingIr = Static<typeof CapabilityBindingIrSchema>;

export const HarnessIrBundleSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("harness-ir-bundle"),
    skills: Type.Array(SkillIrSchema),
    tools: Type.Array(ToolIrSchema),
    mcps: Type.Array(McpIrSchema),
    workflows: Type.Array(WorkflowIrSchema),
    runtimes: Type.Array(RuntimeIrSchema),
    harnesses: Type.Array(HarnessSpecIrSchema),
    targets: Type.Array(TargetIrSchema),
    bindings: Type.Array(CapabilityBindingIrSchema),
  },
  { additionalProperties: false },
);
export type HarnessIrBundle = Static<typeof HarnessIrBundleSchema>;

export const RealizationSchema = Type.Object(
  {
    agentId: Identifier,
    capabilityId: QualifiedIdentifier,
    capabilityKind: CapabilityKindSchema,
    requestedMinimum: StrengthSchema,
    requestedPreferred: Type.Optional(StrengthSchema),
    declaredStrength: StrengthSchema,
    declaredMechanism: Type.Union([QualifiedIdentifier, Type.Null()]),
    realized: StrengthSchema,
    /**
     * How the adapter realized it: a DSL-shaped mechanism name for guidance, or
     * a host-owned handle such as `host-tool:Write` for a real exposure. Adapter
     * mechanisms are not DSL identifiers, so this is a free-form string.
     */
    materializedMechanism: Type.Union([Type.String(), Type.Null()]),
    action: Type.Union([
      Type.Literal("satisfied"),
      Type.Literal("degraded"),
      Type.Literal("failed"),
    ]),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Realization = Static<typeof RealizationSchema>;

/**
 * Content lock for one capability's on-disk source. Path strings alone cannot
 * make a revision immutable: `./skills/impact-analysis` keeps its name while
 * its `SKILL.md` changes underneath. A lock digests the real bytes so drift is
 * detectable before a run starts.
 */
export const SourceLockSchema = Type.Object(
  {
    capabilityId: QualifiedIdentifier,
    uri: Type.String(),
    digest: Type.String(),
    /** Files covered by the digest; a single file locks as 1. */
    files: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type SourceLock = Static<typeof SourceLockSchema>;

export const HarnessRevisionSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("harness-revision"),
    revisionId: Type.String({ pattern: "^hr_[0-9a-f]{32}$" }),
    harness: Type.Object(
      { id: Identifier, contentHash: Type.String() },
      { additionalProperties: false },
    ),
    target: Type.Object(
      {
        runtime: Identifier,
        adapter: Type.String(),
        adapterSpecificationVersion: Type.String(),
        adapterImplementationVersion: Type.String(),
        adapterDescriptorHash: Type.String(),
        execution: ExecutionIrSchema,
      },
      { additionalProperties: false },
    ),
    workflow: Type.Object(
      {
        id: Identifier,
        mode: Type.Union([Type.Literal("declarative"), Type.Literal("programmatic")]),
        contentHash: Type.String(),
      },
      { additionalProperties: false },
    ),
    resolved: Type.Object(
      {
        capabilities: Type.Array(
          Type.Object(
            { id: QualifiedIdentifier, kind: CapabilityKindSchema, contentHash: Type.String() },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    agents: Type.Array(
      Type.Object(
        { id: Identifier, capabilities: Type.Array(QualifiedIdentifier) },
        { additionalProperties: false },
      ),
    ),
    realization: Type.Array(RealizationSchema),
    /**
     * Permissions the capabilities asked for. Naming them `requested` keeps the
     * artifact honest: no shipped adapter enforces them on the host runtime yet,
     * and the materialization receipt records what was actually enforced.
     */
    requestedPermissions: Type.Array(PermissionGrantSchema),
    settings: Type.Array(ConfigEntrySchema),
    /** Empty unless the caller locked capability sources at resolve time. */
    sourceLocks: Type.Array(SourceLockSchema),
    /** Optional link to the project-component inventory this revision was resolved against. */
    componentSnapshotRef: Type.Optional(Type.Object(
      { snapshotId: Type.String(), digest: Type.String() },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);
export type HarnessRevision = Static<typeof HarnessRevisionSchema>;

export const ResolutionReportSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("resolution-report"),
    harnessId: Identifier,
    runtime: Identifier,
    status: Type.Union([Type.Literal("resolved"), Type.Literal("failed")]),
    realizations: Type.Array(RealizationSchema),
    errors: Type.Array(Type.String()),
    /** Resolved, but weaker than the DSL reads: multi-agent flows on a single-session adapter. */
    warnings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type ResolutionReport = Static<typeof ResolutionReportSchema>;

/**
 * What one adapter actually wired for one revision.
 *
 * The resolver states desired strength; this receipt states observed runtime
 * facts, in the dimension each capability kind is realized along: a skill is
 * `delivered`, a tool is `exposed`, an MCP server is `connected`, a workflow is
 * `orchestrated`. A single `unsupported < advisory < wired < enforced` ladder
 * cannot express those differences on its own.
 */
export const MaterializationStateSchema = Type.Union([
  Type.Literal("materialized"),
  Type.Literal("degraded"),
  Type.Literal("unsupported"),
]);
export type MaterializationState = Static<typeof MaterializationStateSchema>;

export const RealizationDimensionSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("exposed"),
  Type.Literal("connected"),
  Type.Literal("orchestrated"),
]);
export type RealizationDimension = Static<typeof RealizationDimensionSchema>;

export const CapabilityMaterializationSchema = Type.Object(
  {
    capabilityId: QualifiedIdentifier,
    capabilityKind: CapabilityKindSchema,
    dimension: RealizationDimensionSchema,
    requestedMinimum: StrengthSchema,
    realized: StrengthSchema,
    state: MaterializationStateSchema,
    mechanism: Type.Union([Type.String(), Type.Null()]),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CapabilityMaterialization = Static<typeof CapabilityMaterializationSchema>;

export const HarnessMaterializationReceiptSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("materialization-receipt"),
    revisionId: Type.String({ pattern: "^hr_[0-9a-f]{32}$" }),
    adapter: Type.Object(
      { id: Type.String(), specificationVersion: Type.String() },
      { additionalProperties: false },
    ),
    capabilities: Type.Array(CapabilityMaterializationSchema),
    workflow: Type.Object(
      {
        id: Identifier,
        dimension: RealizationDimensionSchema,
        requestedMode: Type.String(),
        realizedMode: Type.Union([Type.String(), Type.Null()]),
        state: MaterializationStateSchema,
        detail: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    permissions: Type.Object(
      {
        requested: Type.Array(PermissionGrantSchema),
        enforced: Type.Array(PermissionGrantSchema),
      },
      { additionalProperties: false },
    ),
    settings: Type.Object(
      { consumed: Type.Array(Type.String()), ignored: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    warnings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type HarnessMaterializationReceipt = Static<typeof HarnessMaterializationReceiptSchema>;

/** Look up one capability across the bundle's skill/tool/mcp arrays. */
export function findCapability(
  bundle: HarnessIrBundle,
  capabilityId: string,
): CapabilityIr | undefined {
  return (
    bundle.skills.find((skill) => skill.id === capabilityId) ??
    bundle.tools.find((tool) => tool.id === capabilityId) ??
    bundle.mcps.find((mcp) => mcp.id === capabilityId)
  );
}
