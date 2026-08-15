# Harness as Code v0.1 contract

Use this reference as the authoring contract. The grammar and runtime remain
owned by `packages/harness/src/`; this file is a compact generation guide.

- [Document model](#document-model)
- [Component](#component)
- [Host binding](#host-binding)
- [Plugin](#plugin)
- [Composition](#composition)
- [Semantic checklist](#semantic-checklist)

## Document model

The smallest useful document is a component plus a composition that requires it:

```harness
component require-tests {
  kind policy
  description "Do not report the task complete until tests prove it."
}

composition my-agent {
  target qoder
  require require-tests
}
```

A bare `require` with no plugin or binding materializes the component as
advisory prompt guidance — the v0.1 floor. Reach for the fuller model below only
when you need distribution boundaries or a stronger declared mechanism:

1. `component`: a host-independent capability contract.
2. `binding` (optional): how one host declares that it can realize a component.
   Omit it to accept the advisory floor; write it to declare a stronger future
   mechanism or an explicit `unsupported`.
3. `plugin` (optional): an exact-version distribution that provides components.
   Omit it when a composition `require`s the component directly.
4. `composition`: the target host, optional plugin ranges, requirements, and
   settings.

Comments use `//` or `/* ... */`. Whitespace is insignificant. Identifiers must
match `[_a-zA-Z][\w-]*`; prefer descriptive kebab-case identifiers and avoid
language keywords such as `component`, `binding`, `plugin`, `composition`,
`report`, `fail`, `true`, and `false`.

Strings use double quotes and do not support embedded escaped double quotes.
Rephrase descriptions that would otherwise require one.

## Component

```harness
component repository-analysis {
  kind skill
  description "Map affected modules before editing."
  input { changed-files }
  output { impact-summary }
  permissions {
    workspace read
    network deny
  }
}
```

Kinds are `skill`, `tool`, `program`, `workflow`, `hook`, `policy`, `observer`,
or `ui`. Permission domains are `workspace`, `process`, `network`, and `model`;
access values are `read`, `write`, `allow`, and `deny`. Do not use commas inside
`input`, `output`, or `permissions` blocks.

## Host binding

```harness
binding repository-analysis for qoder {
  mechanism skill-routing
  strength advisory
  notes "Injected as prompt guidance in v0.1."
}
```

The host and mechanism are identifiers. Strength is `unsupported`, `advisory`,
`wired`, or `enforced`. Declare at most one binding per component and host.

`mechanism` and `strength` are optional and default to `prompt-preamble` at
`advisory` — an empty `binding x for pi {}` is the advisory floor. Bind several
hosts with the same declaration using a list:

```harness
binding repository-analysis for [pi, qoder] { strength advisory }
```

A binding strength states the strongest host capability being modeled. It does
not prove that the current executor materialized that capability. In v0.1, a
supported binding resolves through `prompt-preamble` at `advisory`; a missing or
`unsupported` binding realizes as `unsupported`.

## Plugin

```harness
plugin repository-tools {
  version "1.2.0"
  provides [ component.repository-analysis ]
}
```

Use a full, valid semantic version such as `1.2.0`. Separate multiple provided
components with commas. Every provided component must be declared.

## Composition

```harness
composition repository-change {
  target qoder

  include [ plugin.repository-tools@^1 ]

  require repository-analysis {
    preferred advisory
    minimum advisory
    on-degrade fail
  }

  configure {
    shell.timeout = 60s
    tool-call-budget = 80
    explain-degradation = true
    review-label = "repository change"
  }
}
```

Include ranges accept a numeric version optionally prefixed by `^` or `~`, for
example `@1`, `@^1`, `@~1.2`, or `@1.2.0`. Do not include the same plugin twice.

`include` is optional: a composition may `require` a component declared in the
document directly, with no plugin wrapper. `target` is required unless inherited
through `extends`.

A requirement block is optional. A bare `require component` asks for the
component at `minimum advisory` with `on-degrade report`. Add the block to raise
`minimum`, state a `preferred` ceiling, or set `on-degrade fail`. Resolution
behaves as follows:

- realized below minimum: fail;
- realized below preferred with `on-degrade fail`: fail;
- realized below preferred with `on-degrade report`: resolve as degraded;
- realized at or above preferred: satisfy.

Configuration keys are dotted or hyphenated identifiers. Values may be
non-negative integers, booleans, strings, or integer durations ending in
`ms`, `s`, `m`, or `h`.

Reuse one assembly across hosts with `extends` instead of copying it. The child
inherits the base target, includes, requirements, and settings, and overrides
`target` (and any member sharing a plugin id, component id, or setting key):

```harness
composition on-qoder extends repository-change {
  target qoder
}
```

The `extends` chain must be acyclic, and every composition must end up with a
`target`, its own or inherited.

## Semantic checklist

- Declare every referenced component. Declare a plugin only when you need a
  distribution boundary; a directly `require`d component needs none.
- Give every plugin declaration an exact semantic version.
- Keep declaration ids, bindings, includes, requirements, inputs, outputs, and
  configuration keys unique within their applicable scope.
- Bind required components for the composition target only to declare a stronger
  mechanism or an explicit `unsupported`; the advisory floor needs no binding.
- Give every composition a `target`, directly or through `extends`, with no
  `extends` cycle.
- Set minimum and degradation policy against v0.1's actual advisory ceiling.
- Keep secrets out of source and descriptions.
- Run `scripts/validate.mjs` and inspect every realization, not only the exit
  code.
