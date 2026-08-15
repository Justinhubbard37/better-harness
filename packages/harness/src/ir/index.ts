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
    materializedMechanism: Type.Union([QualifiedIdentifier, Type.Null()]),
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
      { runtime: Identifier, adapter: Type.String(), execution: ExecutionIrSchema },
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
    permissions: Type.Array(PermissionGrantSchema),
    settings: Type.Array(ConfigEntrySchema),
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
  },
  { additionalProperties: false },
);
export type ResolutionReport = Static<typeof ResolutionReportSchema>;

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
