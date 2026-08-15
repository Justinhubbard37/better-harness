# @qoder-ai/harness

Harness as Code, v0.2: a parseable, lockable, explainable **assembly language**
for coding-agent harnesses. It is deliberately *not* a unified execution
language across agent runtimes — v0.2 answers one bounded question:

> What working style did the harness assemble — workflow, agent roles, and
> capability requirements — what strength did each adapter binding declare,
> and what did the selected v0.2 executor actually materialize?

## The core resource model

The core DSL has host-neutral semantics only:

- `harness` — the complete assembly: workflow, agent roles, capability
  requirements, and configuration.
- `workflow` — control flow, part of a harness, not the harness itself.
- `agent` — a logical role (`author`, `verifier`). Qoder and Pi are not
  agents; they are runtimes.
- `skill` / `tool` / `mcp` — the three capability kinds: progressive
  knowledge ([Agent Skills](https://agentskills.io/specification)), atomic
  callables, and capability connections.
- `runtime` — a concrete host (Qoder, Pi, DeepSeek Harness, Prime Agent)
  with an adapter and an execution style (`tool-calling` or
  `programmatic.<language>`).
- `target` — deployment statement selecting a runtime.
- `binding` — the adapter layer mapping one capability onto one runtime.

There is **no generic `plugin`** in the core DSL. Host plugin and extension
concepts stay in the host's own namespace as binding mechanisms —
`qoder.plugin`, `pi.extension`, `deepseek.plugin`, `prime.python-skill` —
behind the runtime's adapter.

## The smallest harness

You do not need the full model to start. The smallest useful document is one
inline skill, one workflow, one agent, and one target — no runtime, binding,
or strength boilerplate ([`examples/minimal.harness`](examples/minimal.harness)):

```harness
skill require-tests {
  description "Do not report the task complete until tests or a diff review prove it."
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

A bare `use skill` materializes as advisory prompt guidance — the v0.2
floor — and a bare `target` synthesizes a tool-calling runtime with the
conventional `@harness/adapter-<id>` package. The rest of the language is
*progressive disclosure*: reach for it only when you need more.

| When you need… | Add… |
| --- | --- |
| Multi-role control flow | `workflow` edges: `author -> verifier`, `on verifier.failed -> author`, `stop when verifier.passed` |
| A programmatic controller | `workflow x { program deno "./flows/loop.ts" }` plus a runtime with matching `execution programmatic.<language>` |
| Atomic callables | `require tool workspace.read` (undeclared tools become implicit contracts) |
| External capability servers | `mcp registry { transport http url env.REGISTRY_MCP }` + `connect mcp registry` |
| A stronger declared mechanism, or an explicit `unsupported` | a `binding` with a host-namespaced mechanism (`qoder.plugin`, `pi.extension`) |
| The same binding on several runtimes | `binding x for [pi, qoder] { … }` |
| A stricter floor or fatal degradation | `use skill x { minimum … on-degrade fail }` |
| The same assembly on another runtime | another `target` — deployment is a target choice, not a harness rewrite |

Authors who want the whole surface at once should read
[`examples/standard-coding.harness`](examples/standard-coding.harness); the
sections below document the resolved IR those forms lower into.

## Pipeline

```text
.harness sources ──parse──▶ Langium AST ──lower──▶ versioned JSON IR (TypeBox)
                                                        │
                                          resolveHarness(bundle, id, runtime)
                                                        │
                                   ┌────────────────────┴───────────────────┐
                             HarnessRevision                        ResolutionReport
                        (immutable run fact, hr_*)          (requested vs realized strength)
                                    │
                     ┌──────────────┴──────────────┐
               PiSdkExecutor                 QoderSdkExecutor
        (@earendil-works/pi-coding-agent)   (@qoder-ai/qoder-agent-sdk)
```

## The v0.2 entities

| Entity | Role |
| --- | --- |
| `SkillIr` / `ToolIr` / `McpIr` | The three capability kinds — host-independent contracts |
| `WorkflowIr` | Declarative graph (edges, events, stops) or programmatic controller (`program`) |
| `RuntimeIr` | A concrete host: adapter package plus `tool-calling` or `programmatic.<language>` execution |
| `HarnessSpecIr` | The assembly: workflow reference, agent roles with capability requirements, settings |
| `TargetIr` | Deployment statement selecting a runtime (adapter synthesized when omitted) |
| `CapabilityBindingIr` | Adapter mapping: capability × runtime × mechanism × declared strength |
| `HarnessRevision` | Immutable resolution fact: hashes, runtime execution, per-(agent, capability) strengths, permissions |
| `ResolutionReport` | Requested, declared, and materialized strength for every requirement |

All IR documents carry `irVersion` and a `kind` discriminator and are defined
as TypeBox schemas in
[`src/ir/index.ts`](https://github.com/QoderAI/better-harness/blob/main/packages/harness/src/ir/index.ts).

## Quick start

```ts
import {
  compileHarness,
  resolveHarness,
  QoderSdkExecutor,
  highlightHarness,
} from "@qoder-ai/harness";

const compiled = await compileHarness(source);
if (!compiled.bundle) {
  throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
}

const { revision, report } = resolveHarness(
  compiled.bundle,
  "standard-coding",
  "qoder",
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

### Streaming run events

Executors accept an `onRunEvent` listener and emit host-neutral
`HarnessRunEvent` values while a run is in flight, guarded by
`HarnessRunEmitter`: exactly one `run-started` first and one `run-finished`
last, text framed as `message-started` / `text-delta` / `message-finished`,
paired `tool-call-started` / `tool-call-finished`, and `run-error` only on
failure. Payloads pass the same redaction as the trace. The companion
`@qoder-ai/harness-ui` package maps this lifecycle onto the AG-UI protocol
over SSE, and `@qoder-ai/harness-studio` renders it in a local React UI.

### Adapter sessions (experimental)

`execute` is a one-turn convenience built on the `harness-adapter-v1`
contract: `QoderSdkAdapter` and `PiSdkAdapter` implement `HarnessAdapterV1`
(`specificationVersion: "harness-adapter-v1"`), whose `doStart` binds a
resolved revision to a live host session for multiple sequential prompt
turns. Each turn emits its own complete run-event sequence and resolves to
the same `HarnessRunResult` shape as a batch execution.

```ts
import { QoderSdkAdapter } from "@qoder-ai/harness";

const adapter = new QoderSdkAdapter();
const session = await adapter.doStart({ revision, bundle, workDir: process.cwd() });
const first = await session.doPromptTurn({ prompt: "Explain the repository." });
const second = await session.doPromptTurn({ prompt: "Now list its packages." });
await session.doStop();
```

Optional behaviors degrade with a typed signal instead of silence: an
adapter that cannot honour a request (for example a turn `abortSignal` on
the Pi SDK, which exposes no abort surface) throws
`HarnessCapabilityUnsupportedError`, and the batch wrapper `runOnce` maps an
unsupported graceful stop to a `doDestroy` fallback plus a result warning.
The surface is experimental until `@qoder-ai/harness-studio` adopts it.

[`examples/full-surface.harness`](examples/full-surface.harness) is the compiler
conformance fixture: it deliberately exercises every v0.2 capability kind,
transport, execution style, permission, strength, degradation policy, and
configuration value type.

## Workflow and execution are independent dimensions

How a workflow is *implemented* (declarative graph vs `program`) is
independent of how a runtime *exposes capabilities* (tool calling vs
programmatic calling). Declarative workflows deploy to any runtime. A
programmatic workflow only resolves against a runtime whose execution is
`programmatic` in the same language:

```harness
runtime prime {
  adapter "@harness/adapter-prime"
  execution programmatic.python {
    repl persistent
  }
}
```

An arbitrary Deno workflow is never silently translated into Prime's Python;
resolution fails with instructions to author in the runtime's native language,
restrict deployment targets, or drive the runtime externally over
[ACP](https://agentclientprotocol.com/get-started/introduction).

## Compare real coding outcomes

The DSL describes an assembled agent harness; it does not make a successful SDK
response equivalent to a successful coding task. The companion
`harness-compare.v1` manifest freezes the task repository, two harness ids,
runtime policy, trial count, and deterministic grader. Each variant/trial runs
in a separate temporary Git repository and retains the resulting patch,
redacted SDK trace, runtime receipt, permission decisions, validation details,
metrics, and aggregate verdict.

The included benchmark asks both harnesses to create a repository-grounded
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
command, the executable Quick Start — lives in the candidate harness's
skills, which the executor materializes as harness guidance. Keeping that
expectation out of the prompt is what makes the measured difference attributable
to the harness, so the baseline is expected to score lower. The runtime
profile experiment below is the opposite case: its two arms share one
harness, so its prompt states the task in full and only the runtime profile
varies.

To isolate runtime-tool effects from harness-policy effects, the companion
profile experiment holds the grounded harness and task constant. Its
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
which teaches compatible coding agents to generate complete v0.2 documents and
validate every harness with the same compiler and resolver exported by this
package. Its validator is also available directly after the package is built:

```sh
node skills/generate-harness-dsl/scripts/validate.mjs workflow.harness
```

## Executor honesty rules

v0.2 executors materialize capabilities as prompt guidance, so effective
strength is capped at `advisory`. A binding can declare a future `wired` or
`enforced` host-native mechanism (`qoder.plugin`, `pi.extension`), but
resolution compares the requirement's minimum and preferred strength against
the advisory materialization. Below-minimum assemblies fail before execution;
allowed degradation is visible in the report and run warnings.

Executors reject revisions targeting another runtime. `materializePiPackage()`
emits an installable Pi package only for advisory skill capabilities and
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

Native plugins, extensions, and MCP connections are declaration-only in v0.2.
Until a native materialization receipt exists, they do not upgrade effective
strength beyond `advisory`.

## Development

```sh
npm install
npm run harness:generated  # regenerate and reject stale Langium output
npm run harness:build
npm run harness:test
```

Publication is repository-owned: select `harness` in the protected GitHub
Actions `Publish npm` workflow. Local commands only build, test, pack, or
dry-run; do not publish this workspace from a developer machine.

The package supports the repository's Node range (`>=22.20.0 <25`). See the
[v0.2 resource-model spec](https://github.com/QoderAI/better-harness/blob/main/docs/specs/2026-08-15-harness-dsl-v0.2-resource-model.md)
and the
[v0.1 production-readiness spec](https://github.com/QoderAI/better-harness/blob/main/docs/specs/2026-08-14-harness-as-code-v0.1.md)
for acceptance scenarios, non-goals, and validation evidence.
The named minimal profile and its isolated comparison are specified in
[`docs/specs/2026-08-15-qoder-minimal-runtime-profile.md`](../../docs/specs/2026-08-15-qoder-minimal-runtime-profile.md).
