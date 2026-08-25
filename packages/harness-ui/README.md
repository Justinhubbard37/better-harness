# @qoder-ai/harness-ui

The reusable live-run bridge between [`@qoder-ai/harness`](../harness/README.md)
and browser-facing [AG-UI](https://docs.ag-ui.com/) clients.

Despite the historical package name, this package does **not** contain visual
components or an end-user application. It owns the bounded protocol boundary
that compiles and resolves one Harness run, projects neutral `HarnessRunEvent`
values into AG-UI events, and optionally serves them over local HTTP/SSE.

Most users should start with
[`@qoder-ai/harness-studio`](../harness-studio/README.md), the actual React
control plane. Studio embeds this bridge under `/agui` and adds the Debugger,
run timeline, Tool Call inspection, permissions, cancellation, evidence, and
workspace experience. Use `@qoder-ai/harness-ui` directly when building a
custom AG-UI client or embedding the run bridge in another local server.

## How it fits

```text
.harness ── @qoder-ai/harness ── HarnessRunEvent (neutral lifecycle)
                                        │
                   @qoder-ai/harness-ui: AG-UI projection + SSE
                                        │
              custom AG-UI client ◄─────┴─────► Harness Studio
```

The executor's `HarnessRunEmitter` already guarantees a well-formed
lifecycle — one `run-started`, framed messages, paired tool-call argument
events, correlated retained tool results, and one terminal `run-finished` —
so the AG-UI mapping is nearly 1:1. The adapter emits `TOOL_CALL_RESULT` when
the host exposes execution output and enforces the AG-UI termination rule: a
run ends with either `RUN_FINISHED` or `RUN_ERROR`, never both.

Retained tool output is bounded to 64 KiB. Failed or truncated results emit a
namespaced `harness.tool-result-meta` custom event after `TOOL_CALL_RESULT`;
bounded runtime-protocol evidence uses `harness.protocol-event`. Browser
clients can import both constants and their value types from the browser-safe
`@qoder-ai/harness-ui/protocol` entrypoint.

This package implements the AG-UI **wire format** with local types instead of
depending on the pre-stable `@ag-ui/core`; conformance is asserted by tests
on the emitted JSON.

## Scope

This package owns:

- deterministic `HarnessRunEvent` to AG-UI event translation;
- a browser-safe AG-UI wire contract and Harness custom-event types;
- SSE encoding and incremental decoding;
- compile, source-lock, resolve, execute, and terminal-event orchestration with
  an injected executor factory;
- a local `POST /agui` handler with bounded requests, origin checks, and
  fail-closed remote-bind policy.

It does not own React components, Studio state or layout, persisted sessions,
multi-turn conversation state, Agent discovery, remote authentication, or a
production gateway. `RunAgentInput` is intentionally used as a bounded one-run
request: the latest user message supplies the prompt, while Studio or another
embedding host owns the surrounding workspace and interaction lifecycle.

## Use Harness Studio

For the supported visual workflow, run Studio with a Harness file:

```sh
npx @qoder-ai/harness-studio --harness my-agent.harness
```

Studio serves its own UI and embeds this package's handler on the same local
origin. See the [Harness Studio README](../harness-studio/README.md) for its
Debugger, evidence, workspace, and ACP Agent routes.

## Serve the bridge directly

The standalone command is an advanced integration surface for a custom
AG-UI-compatible frontend; it is not a separate Better Harness UI:

```sh
npx @qoder-ai/harness-ui serve my-agent.harness --port 3210
```

- `POST /agui` — AG-UI `RunAgentInput` in, SSE stream of AG-UI events out.
  The prompt is the latest user message.
- `GET /healthz` — liveness probe.

The server binds to `127.0.0.1` and is a local integration surface. Its CLI
selects the same v0.3 Qoder or Pi executors as the core package, so the executor
honesty rules and redaction guarantees apply unchanged.

A skill declared with `source "./skills/x"` is delivered from disk, not
merely referenced: the server locks and reads it against `--source-root`,
which defaults to the directory containing `<file.harness>` (skills are
conventionally authored relative to their harness file). A harness whose
`source` cannot be resolved there fails the run instead of silently sending
the model a path it cannot open.

Browser POSTs are same-origin by default and must use
`Content-Type: application/json`. To connect a separately hosted local UI,
allow its exact origin explicitly (the option is repeatable):

```sh
npx @qoder-ai/harness-ui serve my-agent.harness \
  --allow-origin http://127.0.0.1:5173
```

The server echoes an allowed origin; it never enables wildcard CORS or trusts
a non-loopback Host just because the Origin matches it. Keep the default
loopback bind unless a trusted gateway supplies authentication and transport
security.

## Embed the run bridge

```ts
import { runHarnessAgui } from "@qoder-ai/harness-ui";
import { QoderSdkExecutor } from "@qoder-ai/harness/exec";

await runHarnessAgui({
  source,               // .harness source text
  prompt: "Explain the repository in one sentence.",
  threadId: "thread-1",
  runId: "run-1",
  onEvent: (event) => console.log(event.type),
  executorFactory: ({ onRunEvent }) =>
    new QoderSdkExecutor({ onRunEvent }),
});
```

The library entrypoint never selects a concrete host executor implicitly.
`executorFactory` keeps host wiring with the embedding application and also
allows deterministic scripted executors in tests. Server embedders can mount
`handleAguiRun` on an existing Node HTTP server instead of opening a second
listener.

## Development

```sh
npm run harness-ui:build
npm run harness-ui:test
```

Publication is repository-owned: select `harness-ui` in the protected GitHub
Actions `Publish npm` workflow. Local commands only build, test, pack, or
dry-run; do not publish this workspace from a developer machine.

See the spec:
[Harness UI and Studio](https://github.com/QoderAI/better-harness/blob/main/docs/specs/2026-08-15-harness-ui-studio.md).
