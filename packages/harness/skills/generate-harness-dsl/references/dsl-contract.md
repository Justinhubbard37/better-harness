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

A complete document normally declares, in dependency order:

1. `component`: a host-independent capability contract.
2. `binding`: how one host declares that it can realize a component.
3. `plugin`: an exact-version distribution that provides components.
4. `composition`: the target host, plugin ranges, requirements, and settings.

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

Each requirement needs `minimum`. `preferred` and `on-degrade` are optional;
the degradation policy defaults to `report`. Resolution behaves as follows:

- realized below minimum: fail;
- realized below preferred with `on-degrade fail`: fail;
- realized below preferred with `on-degrade report`: resolve as degraded;
- realized at or above preferred: satisfy.

Configuration keys are dotted or hyphenated identifiers. Values may be
non-negative integers, booleans, strings, or integer durations ending in
`ms`, `s`, `m`, or `h`.

## Semantic checklist

- Declare every referenced component and plugin.
- Give every plugin declaration an exact semantic version.
- Keep declaration ids, bindings, includes, requirements, inputs, outputs, and
  configuration keys unique within their applicable scope.
- Include a plugin that provides each required component.
- Bind required components for the composition target.
- Set minimum and degradation policy against v0.1's actual advisory ceiling.
- Keep secrets out of source and descriptions.
- Run `scripts/validate.mjs` and inspect every realization, not only the exit
  code.
