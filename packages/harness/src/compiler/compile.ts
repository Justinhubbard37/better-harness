import { URI, type LangiumDocument } from "langium";
import semver from "semver";
import { createHarnessServices } from "../language/harness-module.js";
import {
  type CapabilityRequirement,
  type ComponentContract,
  type CompositionDeclaration,
  type ConfigEntry,
  type ConfigValue,
  type HarnessDocument,
  type PluginDeclaration,
  type PluginRequirement,
  type TargetBinding,
  isComponentContract,
  isCompositionDeclaration,
  isPluginDeclaration,
  isTargetBinding,
} from "../language/generated/ast.js";
import {
  type ComponentContractIr,
  type CompositionSpecIr,
  type ConfigValue as ConfigValueIr,
  type HarnessIrBundle,
  IR_VERSION,
  type PluginManifestIr,
  type Strength,
  type TargetBindingIr,
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

/** Default mechanism for a binding that omits one: prompt guidance. */
const DEFAULT_MECHANISM = "prompt-preamble";
/** Default strength for a binding or requirement that omits one. */
const DEFAULT_STRENGTH: Strength = "advisory";

/**
 * Flattened, `extends`-resolved view of a composition. The child overrides the
 * base's `target` and, per member key, its includes/requirements/settings.
 */
interface MergedComposition {
  name: string;
  target: string | undefined;
  includes: PluginRequirement[];
  requirements: CapabilityRequirement[];
  settings: ConfigEntry[];
}

/** Whether following `extends` from this composition revisits a node. */
function hasExtendsCycle(composition: CompositionDeclaration): boolean {
  const seen = new Set<CompositionDeclaration>();
  let current: CompositionDeclaration | undefined = composition;
  while (current) {
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    current = current.base?.ref;
  }
  return false;
}

/**
 * Walk the `extends` chain base-first and merge members. Later (more derived)
 * declarations override earlier ones by key: plugin id, required component id,
 * and configuration key. A cycle is broken defensively and reported separately
 * by {@link collectBundleDiagnostics}.
 */
function mergeExtends(composition: CompositionDeclaration): MergedComposition {
  const chain: CompositionDeclaration[] = [];
  const seen = new Set<CompositionDeclaration>();
  let current: CompositionDeclaration | undefined = composition;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.base?.ref;
  }
  chain.reverse();

  const includes = new Map<string, PluginRequirement>();
  const requirements = new Map<string, CapabilityRequirement>();
  const settings = new Map<string, ConfigEntry>();
  let target: string | undefined;
  for (const node of chain) {
    if (node.target !== undefined) {
      target = node.target;
    }
    for (const include of node.includes) {
      includes.set(include.plugin.$refText, include);
    }
    for (const requirement of node.requirements) {
      requirements.set(requirement.component.$refText, requirement);
    }
    for (const setting of node.settings) {
      settings.set(setting.key, setting);
    }
  }
  return {
    name: composition.name,
    target,
    includes: [...includes.values()],
    requirements: [...requirements.values()],
    settings: [...settings.values()],
  };
}

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
  diagnostics.push(...collectBundleDiagnostics(documents));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }

  const components: ComponentContractIr[] = [];
  const bindings: TargetBindingIr[] = [];
  const plugins: PluginManifestIr[] = [];
  const compositions: CompositionSpecIr[] = [];
  for (const document of documents) {
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      if (isComponentContract(element)) {
        components.push(lowerComponent(element));
      } else if (isTargetBinding(element)) {
        bindings.push(...lowerBinding(element));
      } else if (isCompositionDeclaration(element)) {
        compositions.push(lowerComposition(element));
      }
    }
  }
  // Plugins are lowered last so provided components can be joined with their
  // declared bindings into the plugin manifest.
  for (const document of documents) {
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      if (isPluginDeclaration(element)) {
        plugins.push(lowerPlugin(element, bindings));
      }
    }
  }

  return {
    bundle: {
      irVersion: IR_VERSION,
      kind: "harness-ir-bundle",
      components,
      bindings,
      plugins,
      compositions,
    },
    diagnostics,
  };
}

function collectBundleDiagnostics(documents: LangiumDocument[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const components = new Map<string, string>();
  const compositions = new Map<string, string>();
  const pluginVersions = new Map<string, string>();
  const bindings = new Map<string, string>();

  for (const document of documents) {
    const source = document.uri.toString();
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      if (isComponentContract(element)) {
        recordUnique(components, element.name, "component", source, element.$cstNode?.range.start.line);
        recordRepeatedValues(element.inputs, "component input", source, element.$cstNode?.range.start.line);
        recordRepeatedValues(element.outputs, "component output", source, element.$cstNode?.range.start.line);
      } else if (isCompositionDeclaration(element)) {
        recordUnique(compositions, element.name, "composition", source, element.$cstNode?.range.start.line);
        recordCompositionMembers(element, source);
      } else if (isPluginDeclaration(element)) {
        recordUnique(
          pluginVersions,
          `${element.name}@${element.version}`,
          "plugin version",
          source,
          element.$cstNode?.range.start.line,
        );
        recordRepeatedValues(
          element.provides.map((provided) => provided.component.$refText),
          "provided component",
          source,
          element.$cstNode?.range.start.line,
        );
        if (semver.valid(element.version) === null) {
          diagnostics.push(
            semanticDiagnostic(
              `Plugin '${element.name}' declares invalid semantic version '${element.version}'.`,
              source,
              element.$cstNode?.range.start.line,
            ),
          );
        }
      } else if (isTargetBinding(element)) {
        for (const host of element.hosts) {
          recordUnique(
            bindings,
            `${element.component.$refText}::${host}`,
            "component/host binding",
            source,
            element.$cstNode?.range.start.line,
          );
        }
      }
    }
  }

  // `extends` is resolved after the parser links references, so cycles and
  // missing targets are semantic errors detected here rather than by the
  // grammar.
  for (const document of documents) {
    const source = document.uri.toString();
    const root = document.parseResult.value as HarnessDocument;
    for (const element of root.elements) {
      if (!isCompositionDeclaration(element)) {
        continue;
      }
      const line = element.$cstNode?.range.start.line;
      if (hasExtendsCycle(element)) {
        diagnostics.push(
          semanticDiagnostic(
            `Composition '${element.name}' has a circular 'extends' chain.`,
            source,
            line,
          ),
        );
        continue;
      }
      if (mergeExtends(element).target === undefined) {
        diagnostics.push(
          semanticDiagnostic(
            `Composition '${element.name}' has no target; declare 'target' or 'extends' a composition that does.`,
            source,
            line,
          ),
        );
      }
    }
  }
  return diagnostics;

  function recordCompositionMembers(composition: CompositionDeclaration, source: string): void {
    const line = composition.$cstNode?.range.start.line;
    recordRepeatedValues(
      composition.includes.map((include) => include.plugin.$refText),
      "included plugin",
      source,
      line,
    );
    for (const include of composition.includes) {
      const range = include.range.replace(/^@/, "");
      if (semver.validRange(range) === null) {
        diagnostics.push(
          semanticDiagnostic(
            `Plugin '${include.plugin.$refText}' uses invalid semantic version range '${range}'.`,
            source,
            line,
          ),
        );
      }
    }
    recordRepeatedValues(
      composition.requirements.map((requirement) => requirement.component.$refText),
      "composition requirement",
      source,
      line,
    );
    recordRepeatedValues(
      composition.settings.map((setting) => setting.key),
      "configuration key",
      source,
      line,
    );
  }

  function recordRepeatedValues(values: string[], kind: string, source: string, zeroBasedLine?: number): void {
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

function lowerComponent(contract: ComponentContract): ComponentContractIr {
  return {
    irVersion: IR_VERSION,
    kind: "component-contract",
    id: contract.name,
    componentKind: contract.kind,
    ...(contract.description !== undefined ? { description: contract.description } : {}),
    inputs: [...contract.inputs],
    outputs: [...contract.outputs],
    permissions: contract.permissions.map((rule) => ({ domain: rule.domain, access: rule.access })),
  };
}

function lowerBinding(binding: TargetBinding): TargetBindingIr[] {
  return binding.hosts.map((host) => ({
    irVersion: IR_VERSION,
    kind: "target-binding",
    componentId: binding.component.$refText,
    host,
    mechanism: binding.mechanism ?? DEFAULT_MECHANISM,
    strength: (binding.strength ?? DEFAULT_STRENGTH) as Strength,
    ...(binding.notes !== undefined ? { notes: binding.notes } : {}),
  }));
}

function lowerPlugin(plugin: PluginDeclaration, bindings: TargetBindingIr[]): PluginManifestIr {
  const provides = plugin.provides.map((ref) => ref.component.$refText);
  const provided = new Set(provides);
  return {
    irVersion: IR_VERSION,
    kind: "plugin-manifest",
    id: plugin.name,
    version: plugin.version,
    provides,
    bindings: bindings
      .filter((binding) => provided.has(binding.componentId))
      .map((binding) => ({
        componentId: binding.componentId,
        host: binding.host,
        mechanism: binding.mechanism,
        strength: binding.strength,
      })),
  };
}

function lowerComposition(composition: CompositionDeclaration): CompositionSpecIr {
  const merged = mergeExtends(composition);
  return {
    irVersion: IR_VERSION,
    kind: "composition-spec",
    id: merged.name,
    // A missing target is rejected by collectBundleDiagnostics before lowering.
    target: merged.target ?? "",
    includes: merged.includes.map((include) => ({
      pluginId: include.plugin.$refText,
      range: include.range.replace(/^@/, ""),
    })),
    requirements: merged.requirements.map((requirement) => ({
      componentId: requirement.component.$refText,
      ...(requirement.preferred !== undefined
        ? { preferred: requirement.preferred as Strength }
        : {}),
      minimum: (requirement.minimum ?? DEFAULT_STRENGTH) as Strength,
      onDegrade: requirement.onDegrade ?? "report",
    })),
    settings: merged.settings.map((entry) => ({
      key: entry.key,
      value: lowerConfigValue(entry.value),
    })),
  };
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
