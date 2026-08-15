# @qoder-ai/harness

Harness as Code, v0.1: a parseable, lockable, explainable **assembly language**
for coding-agent harnesses. It is deliberately *not* a unified execution
language across agent runtimes — v0.1 answers one bounded question:

> What did the composition request, what strength did its binding declare, and
> what did the selected v0.1 executor actually materialize?

## Pipeline

```text
.harness sources ──parse──▶ Langium AST ──lower──▶ versioned JSON IR (TypeBox)
                                                        │
                                             resolveComposition()
                                                        │
                                   ┌────────────────────┴───────────────────┐
                             HarnessRevision                        ResolutionReport
                        (immutable run fact, hr_*)          (requested vs realized strength)
                                    │
                     ┌──────────────┴──────────────┐
               PiSdkExecutor                 QoderSdkExecutor
        (@earendil-works/pi-coding-agent)   (@qoder-ai/qoder-agent-sdk)
```

## The v0.1 entities

| Entity | Role |
| --- | --- |
| `ComponentContract` | What a capability is, needs, and produces — host-independent |
| `TargetBinding` | The strongest mechanism a host binding declares (`unsupported` / `advisory` / `wired` / `enforced`) |
| `PluginManifest` | Distribution boundary: contracts plus their bindings |
| `CompositionSpec` | Desired assembly for a run target, with strength floors and `on-degrade` policy |
| `HarnessRevision` | Immutable resolution fact: exact versions, hashes, declared and materialized strengths, and permissions |
| `ResolutionReport` | Requested, declared, and materialized strength for every requirement |

All IR documents carry `irVersion` and a `kind` discriminator and are defined
as TypeBox schemas in
[`src/ir/index.ts`](https://github.com/QoderAI/better-harness/blob/main/packages/harness/src/ir/index.ts).

## Quick start

```ts
import {
  compileHarness,
  resolveComposition,
  QoderSdkExecutor,
  highlightHarness,
} from "@qoder-ai/harness";

const compiled = await compileHarness(source);
if (!compiled.bundle) {
  throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
}

const { revision, report } = resolveComposition(
  compiled.bundle,
  "standard-coding-qoder",
);

if (!revision) {
  throw new Error(report.errors.join("\n"));
}

// Defaults to the locally signed-in qodercli identity. Production and CI
// callers should inject a PAT or service-account auth factory instead.
const executor = new QoderSdkExecutor();
const result = await executor.execute(revision, compiled.bundle, {
  prompt: "Explain the repository in one sentence.",
  cwd: process.cwd(),
});

const html = await highlightHarness(source); // Shiki, lang: "harness"
```

See [`examples/standard-coding.harness`](examples/standard-coding.harness) for
the full surface syntax.

## AI authoring skill

The package includes
[`skills/generate-harness-dsl/SKILL.md`](skills/generate-harness-dsl/SKILL.md),
which teaches compatible coding agents to generate complete v0.1 documents and
validate every composition with the same compiler and resolver exported by this
package. Its validator is also available directly after the package is built:

```sh
node skills/generate-harness-dsl/scripts/validate.mjs workflow.harness
```

## Executor honesty rules

v0.1 executors materialize components as prompt guidance, so effective strength
is capped at `advisory`. A binding can declare a future `wired` or `enforced`
mechanism, but resolution compares the composition's minimum and preferred
strength against the advisory materialization. Below-minimum assemblies fail
before execution; allowed degradation is visible in the report and run warnings.

Executors reject revisions targeting another host. `materializePiPackage()`
emits an installable Pi package only for advisory, skill-kind components and
stamps every generated skill with revision provenance.

The Qoder executor uses `@qoder-ai/qoder-agent-sdk` and defaults to
`qodercliAuth()` for local development. Automated environments should inject a
PAT or service-account auth factory without placing credentials in source or
logs. The Qoder SDK install script materializes its worker runtime; environments
that disable dependency scripts must approve that postinstall (or run
`npm rebuild @qoder-ai/qoder-agent-sdk`) before using `QoderSdkExecutor`. The Pi
SDK (`@earendil-works/pi-coding-agent`, supported `^0.84.2`) is an optional peer
dependency; its executor loads it lazily and reports install guidance when
missing.

Native hooks and extensions are declaration-only in v0.1. Until a native
materialization receipt exists, they do not upgrade effective strength beyond
`advisory`.

## Development

```sh
npm install
npm run harness:generated  # regenerate and reject stale Langium output
npm run harness:build
npm run harness:test
```

The package supports the repository's Node range (`>=22.20.0 <25`). See the
[v0.1 production-readiness spec](https://github.com/QoderAI/better-harness/blob/main/docs/specs/2026-08-14-harness-as-code-v0.1.md)
for acceptance scenarios, non-goals, and validation evidence.
