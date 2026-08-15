---
name: generate-harness-dsl
description: Generate, revise, or review complete Harness as Code `.harness` files for coding-agent compositions. Use when a user asks to describe components, host bindings, plugins, composition requirements, permissions, degradation policy, or typed settings in the `@qoder-ai/harness` DSL, or when existing Harness DSL must be made compiler-valid and resolvable.
---

# Generate Harness DSL

Create a complete, standalone Harness as Code v0.1 document and prove it with
the package compiler and resolver. Keep declared host capability separate from
what the v0.1 runtime actually materializes.

## Workflow

1. Establish the requested coding-agent host, capabilities, permissions,
   minimum and preferred strengths, degradation behavior, and configuration.
   Infer low-risk details from context; ask only when a missing choice changes
   the safety or meaning of the composition.
2. Read [the DSL contract](references/dsl-contract.md) before authoring. Start
   from the smallest form that expresses the intent — often a component plus a
   composition with a bare `require`, as in
   [the minimal example](../../examples/minimal.harness). Open
   [the complete example](../../examples/standard-coding.harness) only when
   plugins, explicit bindings, or degradation policy are actually needed.
3. Generate one self-contained `.harness` document unless the user explicitly
   requests a fragment. Declare each referenced component and plugin in the
   same document.
4. Validate the result with `scripts/validate.mjs`. Fix every compiler or
   resolution error, rerun validation, and inspect degraded realizations before
   presenting the result.
5. Return the DSL or saved file plus a short summary of the target,
   composition id, included plugins, resolution status, and any degradation.

## Authoring Rules

- Prefer the least syntax that expresses the intent. Add a `binding`, `plugin`,
  or a `require` block only when the default advisory floor is insufficient;
  reuse an assembly across hosts with `extends` rather than copying it.
- Use descriptive, stable identifiers and exact semantic versions for plugin
  declarations. Use a compatible version range in each composition include.
- Declare every component referenced by a binding, plugin, or requirement.
  Do not duplicate ids, bindings, plugin includes, requirements, inputs,
  outputs, or configuration keys.
- Request only permissions the component needs. Never place credentials,
  tokens, private keys, or secret values in DSL source.
- Treat `wired` and `enforced` as binding declarations, not observed runtime
  guarantees. Harness v0.1 materializes supported bindings as
  `prompt-preamble` at no more than `advisory` strength.
- Use `on-degrade fail` when falling below the preferred strength must stop
  resolution. Use `report` only when the weaker materialization is acceptable
  and make that degradation visible to the user.
- Do not invoke Qoder or Pi SDKs, install host integrations, or claim native
  enforcement while generating or validating DSL.

## Validate

Run from this skill directory, substituting the output file and optionally one
or more composition ids:

```sh
node scripts/validate.mjs /path/to/workflow.harness [composition-id ...]
```

The command prints JSON and exits non-zero when compilation or any selected
composition resolution fails. If no composition id is supplied, it resolves
every composition in the file. A successful exit is required before calling
generated DSL valid.

When editing this skill itself, build the package first so `dist/` reflects the
current compiler:

```sh
npm run harness:build
```
