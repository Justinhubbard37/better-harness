import { describeAdapter, type AdapterRealizationDescriptor } from "./adapter-descriptor.js";

export const QODER_ADAPTER_DESCRIPTOR = describeAdapter({
  adapterId: "@harness/adapter-qoder",
  specificationVersion: "harness-adapter-v1",
  implementationVersion: "0.1.0",
  skillDelivery: { mechanism: "prompt-preamble", strength: "advisory" },
  toolExposure: Object.freeze({
    "workspace.read": "Read",
    "workspace.glob": "Glob",
    "workspace.search": "Grep",
    "workspace.edit": "Edit",
    "workspace.write": "Write",
    "process.exec": "Bash",
  }),
  mcpSupport: null,
  workflowModes: Object.freeze(["declarative"]),
  programmaticLanguages: Object.freeze([]),
  agentIsolation: "single-session",
  consumedSettings: Object.freeze([]),
  enforcedPermissionDomains: Object.freeze([]),
});

export const PI_ADAPTER_DESCRIPTOR = describeAdapter({
  adapterId: "@harness/adapter-pi",
  specificationVersion: "harness-adapter-v1",
  implementationVersion: "0.1.0",
  skillDelivery: { mechanism: "prompt-preamble", strength: "advisory" },
  toolExposure: Object.freeze({}),
  mcpSupport: null,
  workflowModes: Object.freeze(["declarative"]),
  programmaticLanguages: Object.freeze([]),
  agentIsolation: "single-session",
  consumedSettings: Object.freeze([]),
  enforcedPermissionDomains: Object.freeze([]),
});

export const ADAPTER_DESCRIPTOR_REGISTRY: Readonly<Record<string, AdapterRealizationDescriptor>> =
  Object.freeze({
    [QODER_ADAPTER_DESCRIPTOR.adapterId]: QODER_ADAPTER_DESCRIPTOR,
    [PI_ADAPTER_DESCRIPTOR.adapterId]: PI_ADAPTER_DESCRIPTOR,
  });

export function describeBuiltInAdapter(
  runtimeOrAdapterId: string,
): AdapterRealizationDescriptor | undefined {
  const adapterId = runtimeOrAdapterId.startsWith("@")
    ? runtimeOrAdapterId
    : `@harness/adapter-${runtimeOrAdapterId}`;
  return ADAPTER_DESCRIPTOR_REGISTRY[adapterId];
}
