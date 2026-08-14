/**
 * Versioned JSON intermediate representation for the Harness DSL.
 *
 * Every artifact carries `irVersion` plus a `kind` discriminator so stored
 * documents stay self-describing. The five v0.1 entities are:
 * CompositionSpec, ComponentContract, TargetBindingManifest (as part of a
 * plugin manifest), HarnessRevision, and ResolutionReport.
 */
import { type Static, Type } from "@sinclair/typebox";

export const IR_VERSION = "0.1.0";

const IrVersion = Type.Literal(IR_VERSION);
const Identifier = Type.String({ pattern: "^[_a-zA-Z][\\w-]*$" });

export const StrengthSchema = Type.Union([
  Type.Literal("unsupported"),
  Type.Literal("advisory"),
  Type.Literal("wired"),
  Type.Literal("enforced"),
]);
export type Strength = Static<typeof StrengthSchema>;

export const ComponentKindSchema = Type.Union([
  Type.Literal("skill"),
  Type.Literal("tool"),
  Type.Literal("program"),
  Type.Literal("workflow"),
  Type.Literal("hook"),
  Type.Literal("policy"),
  Type.Literal("observer"),
  Type.Literal("ui"),
]);
export type ComponentKind = Static<typeof ComponentKindSchema>;

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

export const ComponentContractIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("component-contract"),
    id: Identifier,
    componentKind: ComponentKindSchema,
    description: Type.Optional(Type.String()),
    inputs: Type.Array(Identifier),
    outputs: Type.Array(Identifier),
    permissions: Type.Array(PermissionGrantSchema),
  },
  { additionalProperties: false },
);
export type ComponentContractIr = Static<typeof ComponentContractIrSchema>;

export const TargetBindingIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("target-binding"),
    componentId: Identifier,
    host: Identifier,
    mechanism: Identifier,
    strength: StrengthSchema,
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TargetBindingIr = Static<typeof TargetBindingIrSchema>;

export const PluginManifestIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("plugin-manifest"),
    id: Identifier,
    version: Type.String(),
    provides: Type.Array(Identifier),
    bindings: Type.Array(
      Type.Object(
        {
          componentId: Identifier,
          host: Identifier,
          mechanism: Identifier,
          strength: StrengthSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PluginManifestIr = Static<typeof PluginManifestIrSchema>;

export const CapabilityRequirementIrSchema = Type.Object(
  {
    componentId: Identifier,
    preferred: Type.Optional(StrengthSchema),
    minimum: StrengthSchema,
    onDegrade: Type.Union([Type.Literal("fail"), Type.Literal("report")]),
  },
  { additionalProperties: false },
);
export type CapabilityRequirementIr = Static<typeof CapabilityRequirementIrSchema>;

export const CompositionSpecIrSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("composition-spec"),
    id: Identifier,
    target: Identifier,
    includes: Type.Array(
      Type.Object({ pluginId: Identifier, range: Type.String() }, { additionalProperties: false }),
    ),
    requirements: Type.Array(CapabilityRequirementIrSchema),
    settings: Type.Array(ConfigEntrySchema),
  },
  { additionalProperties: false },
);
export type CompositionSpecIr = Static<typeof CompositionSpecIrSchema>;

export const HarnessIrBundleSchema = Type.Object(
  {
    irVersion: IrVersion,
    kind: Type.Literal("harness-ir-bundle"),
    components: Type.Array(ComponentContractIrSchema),
    bindings: Type.Array(TargetBindingIrSchema),
    plugins: Type.Array(PluginManifestIrSchema),
    compositions: Type.Array(CompositionSpecIrSchema),
  },
  { additionalProperties: false },
);
export type HarnessIrBundle = Static<typeof HarnessIrBundleSchema>;

export const RealizationSchema = Type.Object(
  {
    componentId: Identifier,
    requestedMinimum: StrengthSchema,
    requestedPreferred: Type.Optional(StrengthSchema),
    declaredStrength: StrengthSchema,
    declaredMechanism: Type.Union([Identifier, Type.Null()]),
    realized: StrengthSchema,
    materializedMechanism: Type.Union([Identifier, Type.Null()]),
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
    composition: Type.Object(
      { id: Identifier, contentHash: Type.String() },
      { additionalProperties: false },
    ),
    target: Type.Object({ host: Identifier }, { additionalProperties: false }),
    resolved: Type.Object(
      {
        plugins: Type.Array(
          Type.Object(
            { id: Identifier, version: Type.String(), contentHash: Type.String() },
            { additionalProperties: false },
          ),
        ),
        components: Type.Array(
          Type.Object(
            { id: Identifier, contentHash: Type.String() },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
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
    compositionId: Identifier,
    target: Identifier,
    status: Type.Union([Type.Literal("resolved"), Type.Literal("failed")]),
    realizations: Type.Array(RealizationSchema),
    errors: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type ResolutionReport = Static<typeof ResolutionReportSchema>;
