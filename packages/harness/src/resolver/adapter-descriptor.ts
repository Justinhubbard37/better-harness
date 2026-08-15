/**
 * Adapter realization facts.
 *
 * The harness DSL declares what a run needs. What a runtime can actually
 * provide is not an authoring decision: it belongs to the adapter that talks to
 * the host SDK. A descriptor is that adapter's own statement of capability, and
 * the resolver materializes requirements against it instead of assuming every
 * declared binding becomes prompt guidance.
 *
 * Each capability kind is realized along its own dimension, so the descriptor
 * answers different questions per kind:
 *
 * - skill → delivered as guidance the model reads
 * - tool  → exposed as a callable host tool
 * - mcp   → connected as a live server with discovered tools
 * - flow  → orchestrated by the adapter, or only described to the model
 */
import type { CapabilityKind, Strength, WorkflowIr } from "../ir/index.js";

export interface AdapterSkillDelivery {
  mechanism: string;
  strength: Strength;
}

export interface AdapterMcpSupport {
  mechanism: string;
  strength: Strength;
}

export interface AdapterRealizationDescriptor {
  /** Adapter package id, matched against `revision.target.adapter`. */
  adapterId: string;
  specificationVersion: string;
  /** Version of the adapter implementation whose realization facts were resolved. */
  implementationVersion: string;
  /** How skills reach the model, and the honest ceiling of that channel. */
  skillDelivery: AdapterSkillDelivery | null;
  /**
   * DSL tool id → host tool name the adapter really exposes to the session.
   * Anything absent from this map cannot be satisfied: a prompt line saying
   * "use workspace.write" does not hand the model a callable tool.
   */
  toolExposure: Readonly<Record<string, string>>;
  /** MCP support, or `null` while the adapter opens no MCP connections. */
  mcpSupport: AdapterMcpSupport | null;
  /** Workflow modes the adapter can actually drive. */
  workflowModes: readonly WorkflowIr["mode"][];
  /**
   * `single-session` adapters cannot instantiate one host session per agent, so
   * a multi-agent workflow can only be described in prompt text.
   */
  agentIsolation: "single-session" | "session-per-agent";
  /** Setting keys the adapter reads. Everything else is reported as ignored. */
  consumedSettings: readonly string[];
  /** Permission domains the adapter enforces on the host runtime. */
  enforcedPermissionDomains: readonly string[];
}

/**
 * The floor every adapter is measured against: guidance-only delivery, no tool
 * surface, no MCP, declarative flow description, one session. Resolving without
 * a descriptor uses this, so an unknown runtime fails closed rather than
 * inheriting optimistic defaults.
 */
export const PROMPT_ONLY_DESCRIPTOR: AdapterRealizationDescriptor = Object.freeze({
  adapterId: "@harness/adapter-unknown",
  specificationVersion: "harness-adapter-v1",
  implementationVersion: "unresolved",
  skillDelivery: { mechanism: "prompt-preamble", strength: "advisory" as Strength },
  toolExposure: Object.freeze({}),
  mcpSupport: null,
  workflowModes: Object.freeze(["declarative" as const]),
  agentIsolation: "single-session",
  consumedSettings: Object.freeze([]),
  enforcedPermissionDomains: Object.freeze([]),
});

/** Build a descriptor from the prompt-only floor plus the facts an adapter adds. */
export function describeAdapter(
  overrides: Partial<AdapterRealizationDescriptor> & Pick<AdapterRealizationDescriptor, "adapterId">,
): AdapterRealizationDescriptor {
  return Object.freeze({ ...PROMPT_ONLY_DESCRIPTOR, ...overrides });
}

export interface CapabilityRealizationFact {
  strength: Strength;
  mechanism: string | null;
  dimension: "delivered" | "exposed" | "connected";
  /** Present when the adapter cannot realize the capability as requested. */
  limitation?: string;
}

/** What the descriptor can do for one capability of one kind. */
export function realizationFactFor(
  descriptor: AdapterRealizationDescriptor,
  capabilityId: string,
  kind: CapabilityKind,
): CapabilityRealizationFact {
  switch (kind) {
    case "skill":
      return descriptor.skillDelivery === null
        ? {
            strength: "unsupported",
            mechanism: null,
            dimension: "delivered",
            limitation: `adapter '${descriptor.adapterId}' delivers no skill guidance`,
          }
        : {
            strength: descriptor.skillDelivery.strength,
            mechanism: descriptor.skillDelivery.mechanism,
            dimension: "delivered",
          };
    case "tool": {
      const hostTool = descriptor.toolExposure[capabilityId];
      return hostTool === undefined
        ? {
            strength: "unsupported",
            mechanism: null,
            dimension: "exposed",
            limitation:
              `adapter '${descriptor.adapterId}' exposes no host tool for '${capabilityId}'; ` +
              "a tool requirement cannot be satisfied by prompt guidance",
          }
        : { strength: "wired", mechanism: `host-tool:${hostTool}`, dimension: "exposed" };
    }
    case "mcp":
      return descriptor.mcpSupport === null
        ? {
            strength: "unsupported",
            mechanism: null,
            dimension: "connected",
            limitation:
              `adapter '${descriptor.adapterId}' opens no MCP connection, so '${capabilityId}' ` +
              "is never connected or tool-discovered",
          }
        : {
            strength: descriptor.mcpSupport.strength,
            mechanism: descriptor.mcpSupport.mechanism,
            dimension: "connected",
          };
  }
}

export interface WorkflowRealizationFact {
  mode: string | null;
  supported: boolean;
  /** Set when the adapter drives the flow less strongly than the DSL implies. */
  limitation?: string;
}

/** Whether the descriptor can drive this workflow, and how honestly. */
export function workflowFactFor(
  descriptor: AdapterRealizationDescriptor,
  workflow: WorkflowIr,
  agentCount: number,
): WorkflowRealizationFact {
  if (!descriptor.workflowModes.includes(workflow.mode)) {
    const detail = workflow.mode === "programmatic"
      ? `adapter '${descriptor.adapterId}' cannot execute the programmatic controller ` +
        `'${workflow.program?.entry ?? "?"}'`
      : `adapter '${descriptor.adapterId}' cannot drive a ${workflow.mode} workflow`;
    return { mode: null, supported: false, limitation: detail };
  }
  if (agentCount > 1 && descriptor.agentIsolation === "single-session") {
    return {
      mode: "single-session-prompt-roles",
      supported: true,
      limitation:
        `adapter '${descriptor.adapterId}' runs one host session, so the ${agentCount} agent roles ` +
        "share one context: there is no per-agent session, handoff, or outcome event",
    };
  }
  return { mode: workflow.mode, supported: true };
}
