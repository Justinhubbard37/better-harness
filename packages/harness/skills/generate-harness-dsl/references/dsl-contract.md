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
}

target prime
target qoder uses adapter.qoder
```

A runtime is a concrete host with its adapter package. Programmatic language
support belongs to the adapter descriptor registry. A `target` deploys the
document's harnesses to a runtime; without a runtime block it synthesizes a runtime whose adapter is
`@harness/adapter-<id>` (using the `uses adapter.<id>` shorthand when given).
Do not add `uses adapter` to a target whose runtime block already declares an
adapter.

## Adapter binding

```harness
binding repository-analysis for qoder {
  unsupported
}
```

Bindings are veto-only: `unsupported` prevents a capability from being
materialized on the named runtime. Mechanism, strength, and execution support
belong to the adapter descriptor. Declare at most one binding per capability
and runtime. Bind several runtimes with one declaration using a list:

```harness
binding repository-analysis for [pi, qoder] { unsupported }
```

A descriptor states what an adapter can provide; the run receipt records what
was actually materialized. Materialization is per capability
kind: a skill is *delivered* as guidance (`prompt-preamble` at `advisory`), a
tool must be *exposed* as a callable host tool, an MCP server must be
*connected*. A capability the target adapter cannot back fails resolution — in
v0.2 that means `connect mcp` never resolves, and `require tool` resolves only
on an adapter that exposes a matching host tool (Qoder does, Pi does not). An
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
- Set minimum and degradation policy against what the target adapter really
  realizes per kind, not against the strength a binding declares.
- Keep secrets out of source and descriptions; reference MCP endpoints via
  `env.VARIABLE`.
- Run `scripts/validate.mjs` and inspect every realization, not only the exit
  code.
