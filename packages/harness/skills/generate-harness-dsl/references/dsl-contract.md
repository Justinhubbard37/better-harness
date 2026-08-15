# Harness as Code v0.2 contract

Use this reference as the authoring contract. The grammar and runtime remain
owned by `packages/harness/src/`; this file is a compact generation guide.

- [Document model](#document-model)
- [Harness and agents](#harness-and-agents)
- [Workflow](#workflow)
- [Capabilities: skill, tool, mcp](#capabilities-skill-tool-mcp)
- [Runtime and target](#runtime-and-target)
- [Adapter binding](#adapter-binding)
- [Semantic checklist](#semantic-checklist)

## Document model

The smallest useful document is one inline skill, a single-agent workflow, a
harness, and a target:

```harness
skill require-tests {
  description "Do not report the task complete until tests prove it."
}

workflow single-pass {
  stop when coder.done
}

harness my-agent {
  workflow single-pass

  agent coder {
    use skill require-tests
  }
}

target qoder
```

A bare `use skill` with no binding materializes as advisory prompt guidance —
the v0.2 floor — and a bare `target` synthesizes a tool-calling runtime with
the conventional `@harness/adapter-<id>` package. Reach for the fuller model
below only when you need multi-role flow, host-native mechanisms, or
programmatic execution.

The core DSL defines **no generic plugin**. Host plugin and extension concepts
appear only as binding mechanisms in the host's own namespace
(`qoder.plugin`, `pi.extension`, `deepseek.plugin`, `prime.python-skill`).

Comments use `//` or `/* ... */`. Whitespace is insignificant. Identifiers
match `[_a-zA-Z][\w-]*`; tool ids, binding mechanisms, and configuration keys
may be dotted (`workspace.read`, `qoder.plugin`, `runtime.timeout`). Prefer
descriptive kebab-case identifiers.

Strings use double quotes and do not support embedded escaped double quotes.
Rephrase descriptions that would otherwise require one.

## Harness and agents

```harness
harness standard-coding {
  workflow coding-loop

  agent author {
    use skill impact-analysis
    require tool workspace.read
    connect mcp package-registry
  }

  agent verifier {
    require tool process.exec {
      preferred enforced
      minimum advisory
      on-degrade report
    }
  }

  configure {
    shell.timeout = 60s
    tool-call-budget = 80
  }
}
```

A harness names one workflow, declares its logical agent roles, and holds run
configuration. Agents are roles (`author`, `verifier`) — hosts like Qoder or
Pi are runtimes, never agents. The requirement verb states the capability
kind: `use skill`, `require tool`, `connect mcp`; the verb must match the
declared kind.

A requirement block is optional. A bare requirement asks for the capability at
`minimum advisory` with `on-degrade report`. Add the block to raise `minimum`,
state a `preferred` ceiling, or set `on-degrade fail`. Resolution behaves as
follows:

- realized below minimum: fail;
- realized below preferred with `on-degrade fail`: fail;
- realized below preferred with `on-degrade report`: resolve as degraded;
- realized at or above preferred: satisfy.

Configuration keys are dotted or hyphenated identifiers. Values may be
non-negative integers, booleans, strings, or integer durations ending in
`ms`, `s`, `m`, or `h`.

## Workflow

Declarative graph — agent-to-agent edges, event routes, and stop conditions:

```harness
workflow coding-loop {
  author -> verifier
  on verifier.failed -> author
  stop when verifier.passed
}
```

Programmatic controller — control flow lives in a program:

```harness
workflow scripted-loop {
  program deno "./flows/coding-loop.ts"
}
```

A workflow declares exactly one of the two forms. Every agent a workflow
references must be declared by each harness that uses it. A programmatic
workflow resolves only against a runtime whose execution is
`programmatic.<same-language>`; declarative workflows deploy anywhere.

## Capabilities: skill, tool, mcp

```harness
skill repository-analysis {
  source "./skills/repository-analysis"
  description "Map affected modules before editing."
  permissions {
    workspace read
    network deny
  }
}

tool workspace.read {
  description "Read files inside the workspace."
  input { path }
  output { contents }
  permissions { workspace read }
}

mcp package-registry {
  transport http
  url env.PACKAGE_REGISTRY_MCP
}
```

A skill needs `source`, `description`, or both. Tools referenced by
`require tool` without a declaration become implicit atomic contracts.
An MCP entry is a connection, not a tool: `transport` is `stdio` (requires
`command`), `http`, or `sse` (both require `url`, either a string or
`env.VARIABLE`). Permission domains are `workspace`, `process`, `network`,
and `model`; access values are `read`, `write`, `allow`, and `deny`. Do not
use commas inside `input`, `output`, or `permissions` blocks. MCP transports
imply their connection grant at resolution (`stdio` → process, `http`/`sse`
→ network).

## Runtime and target

```harness
runtime prime {
  adapter "@harness/adapter-prime"
  execution programmatic.python {
    repl persistent
  }
}

target prime
target qoder uses adapter.qoder
```

A runtime is a concrete host with its adapter package and capability-calling
style: `tool-calling` (default) or `programmatic.<language>` with optional
key/value options. A `target` deploys the document's harnesses to a runtime;
without a runtime block it synthesizes a tool-calling runtime whose adapter is
`@harness/adapter-<id>` (using the `uses adapter.<id>` shorthand when given).
Do not add `uses adapter` to a target whose runtime block already declares an
adapter.

## Adapter binding

```harness
binding repository-analysis for qoder {
  mechanism qoder.plugin
  strength wired
  notes "Realized natively once the adapter ships."
}
```

The runtime is an identifier; the mechanism is a dotted name so host-native
assets stay in the host's namespace. Strength is `unsupported`, `advisory`,
`wired`, or `enforced`. Declare at most one binding per capability and
runtime.

`mechanism` and `strength` are optional and default to `prompt-preamble` at
`advisory` — an empty `binding x for pi {}` is the advisory floor. Bind
several runtimes with one declaration using a list:

```harness
binding repository-analysis for [pi, qoder] { strength advisory }
```

A binding strength states the strongest adapter capability being modeled. It
does not prove that the current executor materialized that capability. In
v0.2, a supported binding resolves through `prompt-preamble` at `advisory`; an
`unsupported` binding realizes as `unsupported` and fails any requirement.

## Semantic checklist

- Declare every referenced skill, MCP entry, workflow, and runtime; only
  tools may stay implicit. Never declare a generic plugin.
- Match requirement verbs to capability kinds (`use skill`, `require tool`,
  `connect mcp`).
- Keep declaration ids, bindings, targets, agents, requirements, inputs,
  outputs, and configuration keys unique within their applicable scope.
- Ensure every agent named by a workflow exists in each harness using it.
- Pair programmatic workflows with a runtime declaring the same
  `programmatic.<language>` execution, or keep the workflow declarative.
- Bind capabilities for a runtime only to declare a stronger host-native
  mechanism or an explicit `unsupported`; the advisory floor needs no binding.
- Set minimum and degradation policy against v0.2's actual advisory ceiling.
- Keep secrets out of source and descriptions; reference MCP endpoints via
  `env.VARIABLE`.
- Run `scripts/validate.mjs` and inspect every realization, not only the exit
  code.
