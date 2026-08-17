# @qoder-ai/harness-studio

A local React studio for [`@qoder-ai/harness`](../harness/README.md): one UI
over the two evidence surfaces the DSL toolchain produces.

- **Run view** — drives a live harness run over the AG-UI protocol served by
  [`@qoder-ai/harness-ui`](../harness-ui/README.md) (embedded under `/agui`),
  rendering streamed assistant messages, warnings, and workbench-style
  expandable tool cards with arguments, retained results, execution state,
  failed/result-unavailable states, bounded-result truncation evidence, and the
  final run result.
- **Compare view** — loads a `harness-compare.v1` evidence directory and
  renders the frozen `verdict.json`: per-variant pass rate, mean score, cost,
  and per-trial outcomes.

The existing static outputs (the zero-dependency harness inspector HTML and
the compare `verdict.html`) stay authoritative and offline-friendly; the
studio reads the same evidence and adds interactivity on top.

## Usage

```sh
# Compare evidence only
npx @qoder-ai/harness-studio --evidence ./harness-readme-compare-evidence

# Live runs only
npx @qoder-ai/harness-studio --harness my-agent.harness

# Both surfaces on one port
npx @qoder-ai/harness-studio --harness my-agent.harness --evidence ./evidence

# Discover project history, resolve a checkpoint, and lock it before Run
npx @qoder-ai/harness-studio \
  --experiment ./experiment.json \
  --history-catalog ./checkpoint-history.json \
  --experiment-locks ./.harness-studio-locks
```

Then open the printed URL (default `http://127.0.0.1:3311`). The server binds
to loopback; live runs execute through the same v0.2 executors and redaction
rules as the core package. The embedded run endpoint accepts same-origin JSON
browser requests only; use the standalone `@qoder-ai/harness-ui` server with
an explicit `--allow-origin` when the frontend is hosted on another origin.

A `source`-backed skill is locked and read from `--source-root`, which
defaults to the directory containing `--harness`. Pass it explicitly when the
harness's skills live somewhere else.

The optional `checkpoint-history.v1` catalog is the first file-backed history
adapter. Studio exposes only opaque item ids and display projections to the
browser. Resolving an item verifies its checkpoint, prompt, and trajectory but
does not create a worktree or sandbox. `Lock selected history` writes a
content-addressed experiment definition and makes it active only after the
existing experiment loader accepts it; isolated lane copies are still created
only by Run. Other providers, including versioned document or presentation
systems, can inject the same server adapter interface without adopting the
catalog's storage format.

## Architecture

```text
dist/app/        esbuild-bundled React app (index.html + assets/app.js)
src/app/         components plus pure state modules:
                   agui-store.ts     AG-UI event → run view state reducer
                   compare-model.ts  verdict.json → table model
                   sse-client.ts     incremental SSE frame parser
src/server/      static host + /api/config + /api/evidence + embedded /agui
                 checkpoint history list/resolve + durable experiment lock
```

The pure modules are the tested seam; the React components are direct renders
of their outputs.

## Development

```sh
npm run harness-studio:build   # tsc + esbuild-wasm bundle
npm run harness-studio:test
npm run harness-studio:test:browser   # built-app Playwright interaction
```

Publication is repository-owned: select `harness-studio` in the protected
GitHub Actions `Publish npm` workflow. Local commands only build, test, pack,
or dry-run; do not publish this workspace from a developer machine.

See the spec:
[Harness UI and Studio](https://github.com/QoderAI/better-harness/blob/main/docs/specs/2026-08-15-harness-ui-studio.md).
