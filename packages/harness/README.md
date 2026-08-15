# @qoder-ai/harness

Harness as Code, v0.1: a parseable, lockable, explainable **assembly language**
for coding-agent harnesses. It is deliberately *not* a unified execution
language across agent runtimes — v0.1 answers one bounded question:

> What did the composition request, what strength did its binding declare, and
> what did the selected v0.1 executor actually materialize?

## The five-line harness

You do not need the full assembly model to start. The smallest useful document
is one capability plus a composition that requires it — no plugin, binding, or
strength boilerplate ([`examples/minimal.harness`](examples/minimal.harness)):

```harness
component require-tests {
  kind policy
  description "Do not report the task complete until tests or a diff review prove it."
}

composition my-agent {
  target qoder
  require require-tests
}
```

A bare `require` materializes the component as advisory prompt guidance — the
v0.1 floor — so this resolves and runs as-is. The rest of the language is
*progressive disclosure*: reach for it only when you need more.

| When you need… | Add… |
| --- | --- |
| A stronger declared mechanism, or an explicit `unsupported` | a `binding` (its `mechanism`/`strength` default to advisory prompt guidance) |
| The same binding on several hosts | `binding x for [pi, qoder] { … }` |
| A distribution boundary / versioned bundle | a `plugin` with `include [ plugin.x@^1 ]` |
| A stricter floor or fatal degradation | a `require x { minimum … on-degrade fail }` block |
| The same assembly on another host | `composition y extends x { target … }` |

Authors who want the whole surface at once should read
[`examples/standard-coding.harness`](examples/standard-coding.harness); the
sections below document the resolved IR those forms lower into.

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

[`examples/full-surface.harness`](examples/full-surface.harness) is the compiler
conformance fixture: it deliberately exercises every v0.1 component kind,
permission, strength, degradation policy, and configuration value type.

## Compare real coding outcomes

The DSL describes an assembled agent harness; it does not make a successful SDK
response equivalent to a successful coding task. The companion
`harness-compare.v1` manifest freezes the task repository, two composition ids,
runtime policy, trial count, and deterministic grader. Each variant/trial runs
in a separate temporary Git repository and retains the resulting patch,
redacted SDK trace, runtime receipt, permission decisions, validation details,
metrics, and aggregate verdict.

The included benchmark asks both compositions to create a repository-grounded
`README.md` and validates the changed-file scope, Markdown structure, local
links, package exports, documented behavior, executable ESM Quick Start, stale
or invented claims, and the package's existing tests:

```sh
npm run harness:build
node packages/harness/dist/compare/cli.js run packages/harness/examples/readme-compare/experiment.json --out ./harness-readme-compare-evidence --trials 1
```

The command uses the official Qoder Agent SDK and the locally signed-in
`qodercli` identity. `--trials` may reduce the frozen maximum for a development
smoke; use all five trials before treating the result as comparative evidence.
The README task is one benchmark, not proof of general coding performance.

The shared task prompt states only the goal and the runtime tool policy. What a
good README contains — required sections, grounding rules, the consumer install
command, the executable Quick Start — lives in the candidate composition's
components, which the executor materializes as harness guidance. Keeping that
expectation out of the prompt is what makes the measured difference attributable
to the composition, so the baseline is expected to score lower. The runtime
profile experiment below is the opposite case: its two arms share one
composition, so its prompt states the task in full and only the runtime profile
varies.

To isolate runtime-tool effects from harness-policy effects, the companion
profile experiment holds the grounded composition and task constant. Its
baseline uses the manifest's six bounded coding tools; its candidate uses the
named `qoder-minimal-v1` profile:

```sh
node packages/harness/dist/compare/cli.js run packages/harness/examples/readme-compare/minimal-profile-experiment.json --out ./harness-qoder-profile-evidence --trials 1
```

`qoder-minimal-v1` exposes exactly `Read`, `Write`, `Edit`, and `Bash`, replaces
the runtime system prompt with a short coding contract, skips filesystem setting
sources, passes empty SDK selections for skills/plugins/extensions, configures
no MCP servers, enables strict MCP isolation, and keeps the session ephemeral.
The runtime may still report installed skill metadata during initialization;
the model-visible tool list is the stronger observation and contains only the
four named tools. The receipt records the profile and non-secret isolation
options without storing the prompt body.
One trial is a runtime smoke only; use the frozen five trials, and additional
coding tasks, before drawing comparative quality or cost conclusions.

Coding trials expose only `Read`, `Glob`, `Grep`, `Edit`, `Write`, and `Bash`.
No tool is auto-approved: a permission callback confines file operations to the
isolated trial, restricts writes to the manifest's expected files, and permits
only a small validation-command allowlist. Web tools,
network commands, command chaining, repository escapes, and unknown tools fail
closed. Credentials are supplied by the SDK authentication adapter and are not
written to manifests, receipts, traces, or fixtures. Generated Quick Start code
is screened for host capabilities, receives a secret-free environment, and runs
in a separate Node permission-model process with read-only fixture access. The
graded package's own entry point is read the same way, so agent-modified code
never loads inside the grader. Validation commands run without a shell, and a
timed-out command is stopped together with the processes it started.

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
The named minimal profile and its isolated comparison are specified in
[`docs/specs/2026-08-15-qoder-minimal-runtime-profile.md`](../../docs/specs/2026-08-15-qoder-minimal-runtime-profile.md).
