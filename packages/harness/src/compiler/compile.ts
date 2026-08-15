import { URI, type LangiumDocument } from "langium";
import { createHarnessServices } from "../language/harness-module.js";
import {
  type AgentDeclaration,
  type CapabilityBinding,
  type CapabilityUse,
  type ConfigValue,
  type ExecutionSpec,
  type HarnessDeclaration,
  type HarnessDocument,
  type McpDeclaration,
  type RuntimeDeclaration,
  type SkillDeclaration,
  type TargetDeclaration,
  type ToolDeclaration,
  type WorkflowDeclaration,
  isEdgeStatement,
  isEnvEndpoint,
  isEventStatement,
  isHarnessDeclaration,
  isMcpDeclaration,
  isProgrammaticExecution,
  isRuntimeDeclaration,
  isSkillDeclaration,
  isStopStatement,
  isTargetDeclaration,
  isToolDeclaration,
  isWorkflowDeclaration,
  isCapabilityBinding,
} from "../language/generated/ast.js";
import {
  type CapabilityBindingIr,
  type CapabilityKind,
  type ConfigValue as ConfigValueIr,
  type ExecutionIr,
  type HarnessIrBundle,
  type HarnessSpecIr,
  IR_VERSION,
  type McpIr,
  type RuntimeIr,
  type SkillIr,
  type Strength,
  type TargetIr,
  type ToolIr,
  type WorkflowIr,
} from "../ir/index.js";

export interface CompileDiagnostic {
  severity: "error" | "warning";
  message: string;
  source: string;
  line?: number;
}

export interface CompileResult {
  bundle?: HarnessIrBundle;
  diagnostics: CompileDiagnostic[];
}

export interface HarnessSource {
  uri?: string;
  text: string;
}

const DURATION_FACTORS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** Default mechanism for a capability without a binding: prompt guidance. */
const DEFAULT_MECHANISM = "prompt-preamble";
/** Default strength for a binding or requirement that omits one. */
const DEFAULT_STRENGTH: Strength = "advisory";

/** The capability kind each requirement verb asks for. */
const VERB_KIND: Record<string, CapabilityKind> = {
  use: "skill",
  require: "tool",
  connect: "mcp",
};

/**
 * Parse one or more Harness DSL sources and lower them into the versioned
 * JSON IR bundle. Cross-file references are resolved across all provided
 * sources. Compilation fails (no bundle) when any parser, linking, or
 * validation error is present.
 */
export async function compileHarness(input: string | HarnessSource[]): Promise<CompileResult> {
  const sources = typeof input === "string" ? [{ text: input }] : input;
  const { shared } = createHarnessServices();
  const documents: LangiumDocument[] = sources.map((source, index) =>
    shared.workspace.LangiumDocumentFactory.fromString(
      source.text,
      URI.parse(source.uri ?? `memory://harness/${index}.harness`),
    ),
  );
  for (const document of documents) {
    shared.workspace.LangiumDocuments.addDocument(document);
  }
  await shared.workspace.DocumentBuilder.build(documents, { validation: true });

  const diagnostics: CompileDiagnostic[] = [];
  for (const document of documents) {
    for (const diagnostic of document.diagnostics ?? []) {
      diagnostics.push({
        severity: diagnostic.severity === 1 ? "error" : "warning",
        message: typeof diagnostic.message === "string" ? diagnostic.message : String(diagnostic.message),
        source: document.uri.toString(),
        line: diagnostic.range.start.line + 1,
      });
    }
  }
  const index = indexDeclarations(documents);
  diagnostics.push(...collectBundleDiagnostics(documents, index));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }

  return { bundle: lowerBundle(index), diagnostics };
}

/** All declarations across the source set, in declaration order. */
interface DeclarationIndex {
  skills: SkillDeclaration[];
  tools: ToolDeclaration[];
  mcps: McpDeclaration[];
  workflows: WorkflowDeclaration[];
  runtimes: RuntimeDeclaration[];
  harnesses: HarnessDeclaration[];
  targets: TargetDeclaration[];
  bindings: CapabilityBinding[];
  /** Capability id -> declared kind, across the shared capability namespace. */
  capabilityKinds: Map<string, CapabilityKind>;
  /** Tool ids named by `require tool` but never declared. */
  implicitTools: Set<string>;
}

function indexDeclarations(documents: LangiumDocument[]): DeclarationIndex {
  const index: DeclarationIndex = {
    skills: [],
    tools: [],
    mcps: [],
    workflows: [],
    runtimes: [],
    harnesses: [],
    targets: [],
    bindings: [],
    capabilityKinds: new Map(),
    implicitTools: new Set(),
  };
  for (const document of documents) {
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      if (isSkillDeclaration(element)) {
        index.skills.push(element);
        index.capabilityKinds.set(element.name, "skill");
      } else if (isToolDeclaration(element)) {
        index.tools.push(element);
        index.capabilityKinds.set(element.name, "tool");
      } else if (isMcpDeclaration(element)) {
        index.mcps.push(element);
        index.capabilityKinds.set(element.name, "mcp");
      } else if (isWorkflowDeclaration(element)) {
        index.workflows.push(element);
      } else if (isRuntimeDeclaration(element)) {
        index.runtimes.push(element);
      } else if (isHarnessDeclaration(element)) {
        index.harnesses.push(element);
      } else if (isTargetDeclaration(element)) {
        index.targets.push(element);
      } else if (isCapabilityBinding(element)) {
        index.bindings.push(element);
      }
    }
  }
  for (const harness of index.harnesses) {
    for (const agent of harness.agents) {
      for (const requirement of agent.requirements) {
        if (requirement.verb === "require" && !index.capabilityKinds.has(requirement.capability)) {
          index.implicitTools.add(requirement.capability);
        }
      }
    }
  }
  return index;
}

function collectBundleDiagnostics(
  documents: LangiumDocument[],
  index: DeclarationIndex,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const capabilities = new Map<string, string>();
  const workflows = new Map<string, string>();
  const runtimes = new Map<string, string>();
  const harnesses = new Map<string, string>();
  const targets = new Map<string, string>();
  const bindings = new Map<string, string>();

  for (const document of documents) {
    const source = document.uri.toString();
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      const line = element.$cstNode?.range.start.line;
      if (isSkillDeclaration(element)) {
        recordUnique(capabilities, element.name, "capability", source, line);
        if (element.source === undefined && element.description === undefined) {
          diagnostics.push(
            semanticDiagnostic(
              `Skill '${element.name}' declares neither 'source' nor 'description'; ` +
                "a skill needs a source directory, inline guidance, or both.",
              source,
              line,
            ),
          );
        }
      } else if (isToolDeclaration(element)) {
        recordUnique(capabilities, element.name, "capability", source, line);
        recordRepeatedValues(element.inputs, "tool input", source, line);
        recordRepeatedValues(element.outputs, "tool output", source, line);
      } else if (isMcpDeclaration(element)) {
        recordUnique(capabilities, element.name, "capability", source, line);
        if (element.transport === "stdio" && element.command === undefined) {
          diagnostics.push(
            semanticDiagnostic(
              `MCP '${element.name}' uses 'stdio' transport but declares no 'command'.`,
              source,
              line,
            ),
          );
        }
        if (element.transport !== "stdio" && element.url === undefined) {
          diagnostics.push(
            semanticDiagnostic(
              `MCP '${element.name}' uses '${element.transport}' transport but declares no 'url'.`,
              source,
              line,
            ),
          );
        }
      } else if (isWorkflowDeclaration(element)) {
        recordUnique(workflows, element.name, "workflow", source, line);
        if (element.program !== undefined && element.statements.length > 0) {
          diagnostics.push(
            semanticDiagnostic(
              `Workflow '${element.name}' mixes 'program' with graph statements; ` +
                "declare either a programmatic controller or a declarative graph.",
              source,
              line,
            ),
          );
        }
        if (element.program === undefined && element.statements.length === 0) {
          diagnostics.push(
            semanticDiagnostic(
              `Workflow '${element.name}' is empty; declare edges or a 'program'.`,
              source,
              line,
            ),
          );
        }
      } else if (isRuntimeDeclaration(element)) {
        recordUnique(runtimes, element.name, "runtime", source, line);
        if (element.execution !== undefined && isProgrammaticExecution(element.execution)) {
          recordRepeatedValues(
            element.execution.options.map((option) => option.key),
            "execution option",
            source,
            line,
          );
        }
      } else if (isHarnessDeclaration(element)) {
        recordUnique(harnesses, element.name, "harness", source, line);
        recordHarnessMembers(element, source, line);
      } else if (isTargetDeclaration(element)) {
        recordUnique(targets, element.runtime, "target runtime", source, line);
        const runtime = index.runtimes.find((candidate) => candidate.name === element.runtime);
        if (runtime !== undefined && element.adapter !== undefined) {
          diagnostics.push(
            semanticDiagnostic(
              `Target '${element.runtime}' declares 'uses adapter.${element.adapter}', but runtime ` +
                `'${runtime.name}' already owns adapter '${runtime.adapter}'; drop the target adapter.`,
              source,
              line,
            ),
          );
        }
      } else if (isCapabilityBinding(element)) {
        for (const runtime of element.runtimes) {
          recordUnique(
            bindings,
            `${element.capability}::${runtime}`,
            "capability/runtime binding",
            source,
            line,
          );
        }
        if (
          !index.capabilityKinds.has(element.capability) &&
          !index.implicitTools.has(element.capability)
        ) {
          diagnostics.push(
            semanticDiagnostic(
              `Binding references unknown capability '${element.capability}'; declare it as a ` +
                "skill, tool, or mcp, or require it from an agent.",
              source,
              line,
            ),
          );
        }
      }
    }
  }

  // Workflow statements name agents by role. Every harness that uses a
  // workflow must declare each referenced role.
  for (const document of documents) {
    const source = document.uri.toString();
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      if (!isHarnessDeclaration(element)) {
        continue;
      }
      // A malformed document can leave the workflow cross-reference entirely
      // unset; parsing already reported the syntax error.
      const workflow = element.workflow?.ref;
      if (workflow === undefined) {
        continue; // Linking already reported the missing workflow.
      }
      const roles = new Set(element.agents.map((agent) => agent.name));
      const line = element.$cstNode?.range.start.line;
      for (const referenced of workflowAgentNames(workflow)) {
        if (!roles.has(referenced)) {
          diagnostics.push(
            semanticDiagnostic(
              `Workflow '${workflow.name}' references agent '${referenced}', which harness ` +
                `'${element.name}' does not declare.`,
              source,
              line,
            ),
          );
        }
      }
    }
  }
  return diagnostics;

  function recordHarnessMembers(
    harness: HarnessDeclaration,
    source: string,
    line: number | undefined,
  ): void {
    recordRepeatedValues(
      harness.agents.map((agent) => agent.name),
      "agent",
      source,
      line,
    );
    recordRepeatedValues(
      harness.settings.map((setting) => setting.key),
      "configuration key",
      source,
      line,
    );
    for (const agent of harness.agents) {
      const agentLine = agent.$cstNode?.range.start.line ?? line;
      recordRepeatedValues(
        agent.requirements.map((requirement) => requirement.capability),
        `agent '${agent.name}' requirement`,
        source,
        agentLine,
      );
      for (const requirement of agent.requirements) {
        diagnoseRequirement(requirement, source, agentLine);
      }
    }
  }

  function diagnoseRequirement(
    requirement: CapabilityUse,
    source: string,
    line: number | undefined,
  ): void {
    const expected = VERB_KIND[requirement.verb];
    const declared = index.capabilityKinds.get(requirement.capability);
    if (declared !== undefined && declared !== expected) {
      diagnostics.push(
        semanticDiagnostic(
          `'${requirement.verb}' expects a ${expected}, but '${requirement.capability}' ` +
            `is declared as a ${declared}.`,
          source,
          line,
        ),
      );
      return;
    }
    // Tools may stay implicit; skills carry sources and MCP entries carry
    // connection facts, so both must be declared.
    if (declared === undefined && expected !== "tool") {
      diagnostics.push(
        semanticDiagnostic(
          `Agent requirement references unknown ${expected} '${requirement.capability}'; ` +
            `declare '${expected} ${requirement.capability} { ... }'.`,
          source,
          line,
        ),
      );
    }
  }

  function recordRepeatedValues(
    values: string[],
    kind: string,
    source: string,
    zeroBasedLine?: number,
  ): void {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) {
        diagnostics.push(duplicateDiagnostic(kind, value, source, zeroBasedLine));
      }
      seen.add(value);
    }
  }

  function recordUnique(
    seen: Map<string, string>,
    key: string,
    kind: string,
    source: string,
    zeroBasedLine?: number,
  ): void {
    const firstSource = seen.get(key);
    if (firstSource !== undefined) {
      diagnostics.push({
        ...duplicateDiagnostic(kind, key, source, zeroBasedLine),
        message: `Duplicate ${kind} '${key}'; first declared in ${firstSource}.`,
      });
      return;
    }
    seen.set(key, source);
  }
}

/** Agent role names referenced by a workflow's declarative statements. */
function workflowAgentNames(workflow: WorkflowDeclaration): Set<string> {
  const names = new Set<string>();
  for (const statement of workflow.statements) {
    if (isEdgeStatement(statement)) {
      names.add(statement.from);
      names.add(statement.to);
    } else if (isEventStatement(statement)) {
      names.add(statement.agent);
      names.add(statement.to);
    } else if (isStopStatement(statement)) {
      names.add(statement.agent);
    }
  }
  return names;
}

function duplicateDiagnostic(
  kind: string,
  value: string,
  source: string,
  zeroBasedLine?: number,
): CompileDiagnostic {
  return {
    severity: "error",
    message: `Duplicate ${kind} '${value}'.`,
    source,
    ...(zeroBasedLine !== undefined ? { line: zeroBasedLine + 1 } : {}),
  };
}

function semanticDiagnostic(
  message: string,
  source: string,
  zeroBasedLine?: number,
): CompileDiagnostic {
  return {
    severity: "error",
    message,
    source,
    ...(zeroBasedLine !== undefined ? { line: zeroBasedLine + 1 } : {}),
  };
}

function lowerBundle(index: DeclarationIndex): HarnessIrBundle {
  return {
    irVersion: IR_VERSION,
    kind: "harness-ir-bundle",
    skills: index.skills.map(lowerSkill),
    tools: [
      ...index.tools.map((tool) => lowerTool(tool)),
      ...[...index.implicitTools].sort().map(implicitTool),
    ],
    mcps: index.mcps.map(lowerMcp),
    workflows: index.workflows.map(lowerWorkflow),
    runtimes: index.runtimes.map(lowerRuntime),
    harnesses: index.harnesses.map(lowerHarness),
    targets: index.targets.map(lowerTarget),
    bindings: index.bindings.flatMap(lowerBinding),
  };
}

function lowerSkill(skill: SkillDeclaration): SkillIr {
  return {
    irVersion: IR_VERSION,
    kind: "skill",
    id: skill.name,
    ...(skill.source !== undefined ? { source: skill.source } : {}),
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    permissions: skill.permissions.map((rule) => ({ domain: rule.domain, access: rule.access })),
  };
}

function lowerTool(tool: ToolDeclaration): ToolIr {
  return {
    irVersion: IR_VERSION,
    kind: "tool",
    id: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputs: [...tool.inputs],
    outputs: [...tool.outputs],
    permissions: tool.permissions.map((rule) => ({ domain: rule.domain, access: rule.access })),
    implicit: false,
  };
}

function implicitTool(id: string): ToolIr {
  return {
    irVersion: IR_VERSION,
    kind: "tool",
    id,
    inputs: [],
    outputs: [],
    permissions: [],
    implicit: true,
  };
}

function lowerMcp(mcp: McpDeclaration): McpIr {
  return {
    irVersion: IR_VERSION,
    kind: "mcp",
    id: mcp.name,
    transport: mcp.transport,
    ...(mcp.url !== undefined
      ? {
          url: isEnvEndpoint(mcp.url)
            ? { type: "env" as const, variable: mcp.url.variable }
            : { type: "literal" as const, value: mcp.url.value },
        }
      : {}),
    ...(mcp.command !== undefined ? { command: mcp.command } : {}),
  };
}

function lowerWorkflow(workflow: WorkflowDeclaration): WorkflowIr {
  const edges: WorkflowIr["edges"] = [];
  const events: WorkflowIr["events"] = [];
  const stops: WorkflowIr["stops"] = [];
  for (const statement of workflow.statements) {
    if (isEdgeStatement(statement)) {
      edges.push({ from: statement.from, to: statement.to });
    } else if (isEventStatement(statement)) {
      events.push({ agent: statement.agent, outcome: statement.outcome, to: statement.to });
    } else if (isStopStatement(statement)) {
      stops.push({ agent: statement.agent, outcome: statement.outcome });
    }
  }
  return {
    irVersion: IR_VERSION,
    kind: "workflow",
    id: workflow.name,
    mode: workflow.program !== undefined ? "programmatic" : "declarative",
    edges,
    events,
    stops,
    ...(workflow.program !== undefined
      ? { program: { language: workflow.program.language, entry: workflow.program.entry } }
      : {}),
  };
}

function lowerExecution(execution: ExecutionSpec | undefined): ExecutionIr {
  if (execution === undefined || !isProgrammaticExecution(execution)) {
    return { style: "tool-calling" };
  }
  return {
    style: "programmatic",
    language: execution.language,
    options: execution.options.map((option) => ({ key: option.key, value: option.value })),
  };
}

function lowerRuntime(runtime: RuntimeDeclaration): RuntimeIr {
  return {
    irVersion: IR_VERSION,
    kind: "runtime",
    id: runtime.name,
    adapter: runtime.adapter,
    execution: lowerExecution(runtime.execution),
  };
}

function lowerHarness(harness: HarnessDeclaration): HarnessSpecIr {
  return {
    irVersion: IR_VERSION,
    kind: "harness-spec",
    id: harness.name,
    workflow: harness.workflow.$refText,
    agents: harness.agents.map(lowerAgent),
    settings: harness.settings.map((entry) => ({
      key: entry.key,
      value: lowerConfigValue(entry.value),
    })),
  };
}

function lowerAgent(agent: AgentDeclaration): HarnessSpecIr["agents"][number] {
  return {
    id: agent.name,
    requirements: agent.requirements.map((requirement) => ({
      capabilityId: requirement.capability,
      capabilityKind: VERB_KIND[requirement.verb],
      ...(requirement.preferred !== undefined
        ? { preferred: requirement.preferred as Strength }
        : {}),
      minimum: (requirement.minimum ?? DEFAULT_STRENGTH) as Strength,
      onDegrade: requirement.onDegrade ?? "report",
    })),
  };
}

function lowerTarget(target: TargetDeclaration): TargetIr {
  return {
    runtime: target.runtime,
    ...(target.adapter !== undefined ? { adapter: target.adapter } : {}),
  };
}

function lowerBinding(binding: CapabilityBinding): CapabilityBindingIr[] {
  return binding.runtimes.map((runtime) => ({
    irVersion: IR_VERSION,
    kind: "capability-binding",
    capabilityId: binding.capability,
    runtime,
    mechanism: binding.mechanism ?? DEFAULT_MECHANISM,
    strength: (binding.strength ?? DEFAULT_STRENGTH) as Strength,
    ...(binding.notes !== undefined ? { notes: binding.notes } : {}),
  }));
}

function lowerConfigValue(value: ConfigValue): ConfigValueIr {
  switch (value.$type) {
    case "IntLiteral":
      return { type: "int", value: value.value };
    case "DurationLiteral": {
      const match = /^([0-9]+)(ms|s|m|h)$/.exec(value.value);
      if (!match) {
        throw new Error(`Invalid duration literal: ${value.value}`);
      }
      return {
        type: "duration",
        value: value.value,
        ms: Number(match[1]) * DURATION_FACTORS[match[2]],
      };
    }
    case "StringLiteral":
      return { type: "string", value: value.value };
    case "BooleanLiteral":
      return { type: "boolean", value: value.value };
  }
}
