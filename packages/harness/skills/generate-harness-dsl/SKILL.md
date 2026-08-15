---
name: generate-harness-dsl
description: Generate, revise, or review complete Harness as Code `.harness` files for coding-agent harnesses. Use when a user asks to describe workflows, agent roles, skills, tools, MCP connections, runtimes, adapter bindings, permissions, degradation policy, or typed settings in the `@qoder-ai/harness` DSL, or when existing Harness DSL must be made compiler-valid and resolvable.
---

# Generate Harness DSL

Create a complete, standalone Harness as Code v0.2 document and prove it with
the package compiler and resolver. Keep declared adapter capability separate
from what the v0.2 runtime actually materializes.

## Workflow

1. Establish the requested runtimes, workflow shape, agent roles, capabilities
   (skills, tools, MCP connections), permissions, minimum and preferred
   strengths, degradation behavior, and configuration. Infer low-risk details
   from context; ask only when a missing choice changes the safety or meaning
   of the harness.
2. Read [the DSL contract](references/dsl-contract.md) before authoring. Start
   from the smallest form that expresses the intent — often one inline skill,
   a single-agent workflow, and a bare `target`, as in
   [the minimal example](../../examples/minimal.harness). Open
   [the complete example](../../examples/standard-coding.harness) only when
   multi-role workflows, explicit bindings, or degradation policy are actually
   needed.
3. Generate one self-contained `.harness` document unless the user explicitly
   requests a fragment. Declare each referenced skill, MCP entry, workflow,
   and runtime in the same document; only tools may stay implicit.
4. Validate the result with `scripts/validate.mjs`. Fix every compiler or
   resolution error, rerun validation, and inspect degraded realizations before
   presenting the result.
5. Return the DSL or saved file plus a short summary of the harness id, target
   runtimes, resolution status, and any degradation.

## Authoring Rules

- Prefer the least syntax that expresses the intent. Add a `binding`,
  `runtime`, or a requirement block only when the default advisory floor is
  insufficient; deploy an assembly to another host with a second `target`
  rather than copying the harness.
- Never author adapter realization facts. Host-native mechanisms, strengths,
  and programmatic language support belong to the adapter descriptor registry.
- Match the requirement verb to the capability kind: `use skill`,
  `require tool`, `connect mcp`. Declare every skill and MCP entry; an
  undeclared `require tool` synthesizes an implicit atomic contract.
- A `program <language>` workflow resolves only when the selected adapter
  descriptor lists that language in `programmaticLanguages`.
- Request only permissions the capability needs. Never place credentials,
  tokens, private keys, or secret values in DSL source. Reference MCP
  endpoints through `env.VARIABLE` rather than embedding URLs with secrets.
- Use bindings only to veto deployment with `unsupported`; omit bindings for
  supported capabilities and let the adapter descriptor supply the facts.
- Use `on-degrade fail` when falling below the preferred strength must stop
  resolution. Use `report` only when the weaker materialization is acceptable
  and make that degradation visible to the user.
- Do not invoke Qoder or Pi SDKs, install host integrations, or claim native
  enforcement while generating or validating DSL.

## Validate

Run from this skill directory, substituting the output file and optionally one
or more harness ids:

```sh
node scripts/validate.mjs /path/to/workflow.harness [harness-id ...]
```

The command prints JSON and exits non-zero when compilation or any selected
harness resolution fails. If no harness id is supplied, it resolves every
harness in the file against every declared target (or runtime). A successful
exit is required before calling generated DSL valid.

When editing this skill itself, build the package first so `dist/` reflects the
current compiler:

```sh
npm run harness:build
```
