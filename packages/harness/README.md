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
  and its adapter package.
- `target` — deployment statement selecting a runtime.
- `binding` — an optional deployment veto marking a capability unsupported on
  one or more runtimes.

There is **no generic `plugin`** in the core DSL. Host mechanisms, realization
strength, and programmatic language support are facts owned by the pure-data
adapter descriptor registry, not by harness authors.

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
| A programmatic controller | `workflow x { program deno "./flows/loop.ts" }` plus an adapter descriptor that lists `deno` |
| Atomic callables | `require tool workspace.read` (undeclared tools become implicit contracts) |
| External capability servers | `mcp registry { transport http url env.REGISTRY_MCP }` + `connect mcp registry` |
| An explicit deployment veto | `binding x for qoder { unsupported }` |
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
| `RuntimeIr` | A concrete host and adapter package; execution support comes from the descriptor registry |
| `HarnessSpecIr` | The assembly: workflow reference, agent roles with capability requirements, settings |
| `TargetIr` | Deployment statement selecting a runtime (adapter synthesized when omitted) |
| `CapabilityBindingIr` | Deployment overlay: capability × runtime, with `unsupported` as the only author-owned strength |
| `HarnessRevision` | Frozen execution closure: content hashes, adapter contract/version, runtime execution, per-(agent, capability) strengths, requested permissions, source locks |
| `ResolutionReport` | Requested, declared, and materialized strength for every requirement |

All IR documents carry `irVersion` and a `kind` discriminator and are defined
as TypeBox schemas in
[`src/ir/index.ts`](https://github.com/QoderAI/better-harness/blob/main/packages/harness/src/ir/index.ts).

## Quick start

```ts
import {
  compileHarness,
  describeBuiltInAdapter,
  resolveHarness,
} from "@qoder-ai/harness";
import { QoderSdkExecutor } from "@qoder-ai/harness/exec";
import { highlightHarness } from "@qoder-ai/harness/highlight";

const compiled = await compileHarness(source);
if (!compiled.bundle) {
  throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
}

// Resolve against the realization facts of the adapter that will run the
// revision. Without them a harness is measured against prompt-only facts, so
// anything a prompt cannot deliver (a tool, an MCP server) fails closed.
const { revision, report } = resolveHarness(
  compiled.bundle,
  "standard-coding",
  "qoder",
  { adapter: describeBuiltInAdapter },
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
import { QoderSdkAdapter } from "@qoder-ai/harness/exec";

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
transport, workflow mode, permission, deployment veto, degradation policy, and
configuration value type.

## Workflow and execution are independent dimensions

How a workflow is implemented (declarative graph vs `program`) is independent
of how a runtime exposes capabilities. Declarative workflows deploy to any
runtime. A programmatic workflow only resolves when the selected adapter
descriptor lists the same language:

```harness
runtime prime {
  adapter "@harness/adapter-prime"
}
```

An arbitrary Deno workflow is never silently treated as executable;
resolution fails unless the adapter registry proves Deno support. The caller
can select a supporting target or drive the runtime externally over
[ACP](https://agentclientprotocol.com/get-started/introduction).

## Compare real coding outcomes

The DSL describes an assembled agent harness; it does not make a successful SDK
response equivalent to a successful coding task. The companion
`harness-compare.v1` manifest freezes the task repository, two harness ids,
runtime policy, trial count, and deterministic grader. Each variant/trial runs
in a separate temporary Git repository and retains the resulting patch,
redacted SDK trace, runtime receipt, permission decisions, validation details,
metrics, sandbox receipt, and aggregate verdict. The trusted-fixture sandbox
uses an environment allowlist for every subprocess. Direct Node probes retain
permission-model filesystem bounds; package tests can spawn arbitrary scripts,
so their receipt is honestly labeled **trusted-fixture only — network not
denied**.

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

Materialization is decided by the adapter, not by the author's optimism, and the
capability kinds are not realized along the same dimension:

| Kind | Realized when the adapter… | v0.2 shipped adapters |
| --- | --- | --- |
| `skill` | *delivers* the guidance | prompt preamble at `advisory`; a `source` skill's `SKILL.md` text is read and inlined |
| `tool` | *exposes* a callable host tool | Qoder maps standard tool ids onto host tools (`workspace.read` → `Read`) at `wired`; Pi exposes none |
| `mcp` | *connects* and discovers its tools | none — `connect mcp` fails resolution |
| `workflow` | *orchestrates* the control flow | declarative only; a `program` controller fails resolution |

A `require tool` that no adapter exposes fails resolution instead of degrading
into a prompt line, because prompt text is not a callable tool. A declared
`binding` still bounds the outcome — `strength unsupported` keeps a capability
off a runtime — but it cannot raise what the adapter actually does.

Every run carries a `HarnessMaterializationReceipt` on
`HarnessRunResult.materialization`: per capability the realized dimension,
state (`materialized | degraded | unsupported`) and mechanism, the workflow
state, requested versus enforced permissions, and consumed versus ignored
settings. A multi-agent harness on a single-session adapter is recorded as an
explicit degradation with a run warning, not as satisfied orchestration.

A `source` skill is delivered, not referenced. The executor reads the declared
`SKILL.md` under the run's `sourceRoot` and inlines its text into the preamble,
listing the remaining files in the tree as further reading; oversized bodies are
truncated with an explicit run warning, and a source that cannot be read fails
the run. Naming the path alone would let a revision record `delivered` guidance
the model never saw, which is exactly the claim the source lock exists to make
falsifiable.

Resolution measures a harness against the descriptor of the adapter the runtime
actually selected. Passing a descriptor whose `adapterId` differs from the
runtime's `adapter` fails resolution rather than minting a revision that names
one adapter package while every realization in it came from another.

Before any host SDK loads, an executor validates that the revision is the one it
claims to be: host, adapter package/version/descriptor match, the revision still
hashes to its own `revisionId`, the supplied bundle is the bundle it was resolved
from, and every source-backed skill has a `sourceLock` that still matches the
explicit `sourceRoot` supplied for execution. The source root is separate from
the task `cwd`, so changing the agent's working directory cannot retarget a lock.
`materializePiPackage()` runs the same preflight and emits an
installable Pi package only for delivered skill capabilities, copying a
source-backed skill's real files rather than a generated stub, and stamps every
generated skill with revision provenance.

The Qoder executor uses the optional peer `@qoder-ai/qoder-agent-sdk` and defaults to
`qodercliAuth()` for local development. A session is one `query()` whose prompt is
a live stream of user messages, so turn 2 reaches the context turn 1 created;
`persistSession` controls only whether the host transcript survives the query and
can be resumed by id. Automated environments should inject a
PAT or service-account auth factory without placing credentials in source or
logs. The Qoder SDK install script materializes its worker runtime; environments
that disable dependency scripts must approve that postinstall (or run
`npm rebuild @qoder-ai/qoder-agent-sdk`) before using `QoderSdkExecutor`. The Pi
SDK (`@earendil-works/pi-coding-agent`, supported `^0.84.2`) is also optional.
Both executors load their host SDK lazily and report install guidance when the
selected peer is missing; compile and resolve users need neither host SDK.

Native plugins and extensions remain declaration-only in v0.2: no shipped
adapter installs them, so they do not raise effective strength above the
adapter's own facts.

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
