# View AI-generated artifacts inside Harness Studio

## Traceability

- Spec ID: harness-studio-artifact-view
- Status: Draft

## Intent

Harness Studio can observe sessions, runs, and frozen evidence, but it cannot
show what a run actually produced. A session that generates a patch, an SVG
diagram, or a slide deck leaves those outputs unreadable inside Studio; a
reviewer must leave the workbench and open files by hand.

This change adds an Artifact surface that renders run-produced artifacts in
place. It reuses the renderers Studio already ships for code and diffs, and
delegates rich document formats to already-built Qoder Canvas viewers instead of
adding a second document-parsing stack to this repository.

It also removes a correctness problem: `ArtifactsInspector` in
`packages/harness-studio/src/app/RunView.tsx` currently renders hardcoded sample
rows (`acp-debugger-reference.png`, `session-debugger-state.json`) that look like
real retained evidence. Fabricated evidence rows in an evidence workbench are
worse than an empty state.

## Decisions

Two decisions were made by the maintainer before drafting and are treated as
settled input, not open questions:

- **D-1**: Office formats (`pptx`, `xlsx`, `docx`) are in scope. Studio may run
  the Canvas viewer Node sidecar server-side to parse them.
- **D-2**: Canvas-SDK-absent handling is out of scope. No `artifactViewerEnabled`
  capability flag, no foundation-state degradation UI. Studio takes a hard
  dependency on a discoverable Qoder Canvas runtime for Tier C.

D-2 has a consequence a reviewer should see explicitly: it puts Studio's Tier C
surface in tension with `docs/specs/2026-07-17-canvas-preview-distribution.md`,
which lists bundling the Canvas SDK as a non-goal. This spec does not bundle the
SDK; it discovers one. But an installed-package user without a Qoder runtime
loses Tier C with no in-product explanation beyond an error. Revisiting this is
deferred, not resolved.

## Increment 1: compiled-module tier (implemented)

A first increment landed ahead of the rest of this spec to retire the two
unknowns that shaped it: whether a plain Node host can compile TSX on request
without a second build system, and whether a sandboxed frame without
`allow-same-origin` can still load a compiled module. Both are now answered by
running code rather than by reasoning.

It adds a `module` tier absent from the tier table above: an artifact that *is* a
React component, compiled server-side and mounted in the sandbox. It depends on
no Canvas SDK component, so it is orthogonal to Tier C.

- `src/server/artifact-catalog.ts` — directory indexing, opaque ids, root
  confinement independent of `serveStatic`.
- `src/server/artifact-compile.ts` — `esbuild-wasm` `transformSync`, mtime-and-size
  cache, located compile-error formatting.
- `src/app/artifact-host.ts` + `artifact-host.html` — the in-sandbox runtime.
- `scripts/build-app.mjs` — one added IIFE entry point; no new bundler.
- `src/server/server.ts`, `src/server/cli.ts` — `GET /api/artifacts`,
  `GET /api/artifacts/:id/module.js`, `GET /api/artifacts/:id/module.js.map`, and
  `--artifacts <dir>`.
- `src/app/App.tsx`, `studio-shell-model.ts`, `styles/workbench.css` — an
  `artifacts` destination and a row-list-plus-preview pane, so the tier is
  reachable from the shell rather than only by a hand-typed host URL.

### Verified findings

- `esbuild-wasm@0.28.1` `transformSync()` compiles TSX in a plain Node process
  with no `initialize()` call and no spawned helper, so no second build system
  and no fallback transformer are needed.
- The sandboxed host frame has an opaque origin, which splits subresource
  loading in two: the host bundle must be a **classic** script (CORS-exempt),
  while the compiled artifact module is a **module** script and therefore needs
  `Access-Control-Allow-Origin` on its route. Getting either half wrong fails
  only at runtime, in the browser.
- `esbuild-wasm` had to move from `devDependency` to `dependency`, since the
  published `files` list is `dist/` only and compilation now happens at request
  time.
- Both artifact routes must guard directory reads themselves. `createHarnessStudioServer`
  dispatches with `void route(...)`, so a rejection from a route handler is an
  unhandled rejection that ends the Studio process; an artifact directory removed
  after startup reaches that path through `readdir`.

### Increment 1 acceptance

- **AC-15**: A `.tsx` artifact is compiled on request and mounted in the host
  frame. Verification asserts a value computed at runtime (`12 + 5 + 3`), which
  is absent from the source text, so a merely-loaded module cannot pass.
- **AC-16**: The artifact frame carries `sandbox="allow-scripts"` without
  `allow-same-origin`, and the embedding page cannot reach
  `iframe.contentDocument`.
- **AC-17**: `GET /api/artifacts/:id/module.js` sets `Access-Control-Allow-Origin`
  and `X-Content-Type-Options: nosniff`.
- **AC-18**: A compile failure renders a readable in-frame error instead of a
  blank frame, and reports the failing line and column.
- **AC-19**: The host refuses a `module` query that does not match the artifact
  module route, so a query string cannot point it at another origin.
- **AC-20**: A traversal id is rejected with 400 before any filesystem access,
  and the catalog response contains no filesystem path.
- **AC-21**: Compilation happens once for repeated views of an unchanged file and
  again once its mtime moves.
- **AC-22**: The `artifacts` destination reports `ready` only with a configured
  directory, and an artifact directory alone never implies retained Inspector
  evidence or a Compare input.
- **AC-23**: Opening the Artifacts pane compiles nothing. No preview frame
  exists until the reader selects a row.
- **AC-24**: The served module's `sourceMappingURL` resolves to a route that
  returns a `version: 3` map, so the compiled module carries no dangling map
  reference.
- **AC-25**: An artifact directory that becomes unreadable after startup answers
  with a status and a message naming no filesystem path, and the server keeps
  serving other routes.

### Increment 1 evidence

- AC-18/AC-20/AC-21/AC-24 and kind resolution:
  `npx vitest run packages/harness-studio/test/artifact-poc.test.ts` — 20 passed
- AC-22: `npx vitest run packages/harness-studio/test/studio-shell-model.test.ts`
- AC-24/AC-25: `npx vitest run packages/harness-studio/test/server.test.ts`
- AC-15/AC-16/AC-17/AC-18/AC-19/AC-20/AC-23:
  `npx playwright test packages/harness-studio/test/browser/artifact-host.spec.mjs`
  — 13 passed, no console or page errors, screenshots saved for wide, compact,
  and narrow with no horizontal overflow for both the host frame and the shell
  pane
- Regression: `npx vitest run` in `packages/harness-studio` (111 passed) and
  `npm test` at the repository root (1412 passed)

### Increment 1 surface scope

The increment ships the `artifacts` destination and a pane, so Plan step 6 and
the matching non-goal below are narrower than they read: what stays deferred is a
`StudioSourceKind` for artifacts and their promotion to a switchable Studio
input, not shell reachability. A compiled-module pipeline nobody can navigate to
is indistinguishable from an unshipped one, and the row list plus sandboxed
preview is the smallest surface that makes the tier observable.

Still deferred: Tier A and Tier B renderers. A non-`module` selection states that
plainly instead of rendering a guess, so the pane never implies coverage it does
not have.

## Renderer Tiers

Artifacts are model-generated content, so isolation strength is driven by trust
and cost, not by file format.

| Tier | Kinds | Mechanism | New runtime deps |
| --- | --- | --- | --- |
| A | `code`, `diff`, `json`, `text` | In-DOM, existing renderers | none |
| B | `svg`, `image`, `html` | Sandboxed iframe, no script privileges | none |
| C | `pptx`, `xlsx`, `docx` | Canvas viewer: Node sidecar + TSX compile + iframe | discovered Canvas runtime |

Tier A reuses `HighlightedCode` (Shiki, lazily loaded grammars), `StudioDiff`
(`@pierre/diffs`), `studioCodeLanguage()`, and `fixedVirtualWindow()`. Tier B
must not inline SVG into the Studio DOM: SVG carries `<script>` and
`foreignObject`, and inlining also leaks Studio's CSS custom properties into
untrusted markup.

## Acceptance Scenarios

- **AC-1**: `resolveArtifactKind(path, mimeType)` returns a declared
  `ArtifactKind` for each supported extension, and `"unknown"` for anything
  unrecognized. An `"unknown"` artifact renders as escaped plain text with its
  byte size and path, never as a blank pane and never through a viewer.
- **AC-2**: Tier A artifacts render through the existing renderers. A `diff`
  artifact shows a real split patch with line numbers and word-level changes; a
  `code` artifact shows language-aware tokens; neither tokenizes until its pane
  is mounted.
- **AC-3**: Tier B artifacts render inside an iframe whose `sandbox` attribute
  grants neither `allow-scripts` nor `allow-same-origin`. An SVG artifact
  containing a `<script>` element renders its vector content without executing
  that script, verified by asserting the script's side effect is absent.
- **AC-4**: The artifact catalog exposes only opaque ids matching
  `/^[A-Za-z0-9_-]+$/`. `GET /api/artifacts/:id/bytes` resolves the id through
  the catalog; a client-supplied path, an absolute path, or a `..` traversal is
  rejected with 400 and never reaches the filesystem.
- **AC-5**: Artifact bytes are served by a route rooted at the artifact
  directory, independent of `serveStatic`'s `appDir` confinement. An artifact
  path that escapes the configured artifact root is rejected with 403.
- **AC-6**: For a Tier C artifact, Studio runs the viewer sidecar
  (`node <viewerRoot>/scripts/index.mjs`) with `QODER_CANVAS_SCRIPT_ARGS` set to
  `{"targetFilePath":"<absolute artifact path>"}` and `QODER_CANVAS_DATA` set to
  a per-request working file, then reads the payload under the manifest's
  `dataKey`.
- **AC-7**: Sidecar failure is detected from the payload, not the exit code. The
  sidecar exits 0 even when parsing fails and reports the failure as
  `payload.error` plus `payload.diagnostics[].level === "error"`. A corrupt
  `.pptx` surfaces that message in the Studio UI as a viewer error state, and
  Studio does not treat exit code 0 as success.
- **AC-8**: The sidecar runs with a bounded wall-clock timeout, in a per-request
  working directory, and is killed on client disconnect or timeout. A sidecar
  that exceeds the timeout produces an error state and leaves no orphan process
  and no temp directory.
- **AC-9**: Artifacts larger than 32 MiB are refused before the sidecar starts,
  matching the viewer runtime's own `maxSourceBytes` ceiling, with a message
  naming the limit rather than a generic parse failure.
- **AC-10**: The viewer's `index.canvas.tsx` is compiled through the shared
  esbuild-wasm transform and served as an ES module. Compilation is cached on
  the source's mtime and size, so repeated views of one artifact compile once.
- **AC-11**: The viewer HTML is derived from the Canvas runtime's
  `index-canvas.html`, with the sidecar payload injected at the template's
  `data: new Map(),` seam keyed by the manifest `dataKey`, and with the import
  map resolving `react` and `qoder/canvas` to the single served
  `/canvas-sdk.js`. A Tier C pane renders viewer output with no page or console
  errors.
- **AC-12**: `ArtifactsInspector` in `RunView.tsx` lists artifacts resolved from
  the active run instead of hardcoded sample rows. With no artifacts, it renders
  an empty state; it never renders a placeholder filename.
- **AC-13**: The Artifact surface uses panes, rows, tabs, and a toolbar per
  `DESIGN.md`, maps every color, size, and radius to existing semantic tokens,
  and keeps the primary decision obvious at wide, compact, and narrow layouts
  with visible keyboard focus and bounded overflow.
- **AC-14**: Focused unit tests assert returned values from
  `resolveArtifactKind()`, catalog parsing, id validation, path-escape
  rejection, and sidecar payload error extraction. No test asserts a regex
  against source text to stand in for behavior.

## Non-goals

- Editing, regenerating, or re-running artifacts. The surface is read-only.
- Adding a document-parsing stack to this repository. Office parsing stays in
  the Canvas viewer packages.
- Bundling or vendoring `@ali/qoder-canvas-sdk` or any `viewer-*` package.
- A general plugin or dynamic-code-loading system for Studio. Viewer discovery
  is manifest-driven configuration, not third-party code loaded into the Studio
  bundle.
- Promoting Artifacts to a switchable Studio input with its own
  `StudioSourceKind`. Deferred until artifacts have a retained source kind; see
  Plan step 6 and Increment 1's surface scope.
- Capability gating or degraded UI when no Canvas runtime is present (D-2).
- Remote or authenticated artifact sharing. The server stays local-only.

## Plan and Tasks

### 1. Extract the shared TSX transform

`scripts/harness-analysis/canvas-preview/transform.mjs` already implements the
mechanism this surface needs: `transformCanvasSource()` runs esbuild-wasm
`transformSync` with `loader: "tsx"`, `jsx: "transform"`, `jsxFactory:
"React.createElement"`, `format: "esm"`, external sourcemaps, and
`stripCanvasRuntimeImports()` to drop `react` and `qoder/canvas` imports that
the import map and runtime globals satisfy instead.

Extract it as a shared module consumed by both the existing canvas-preview
server and the Studio server. Keep `loadEsbuildWasm()`'s resolution order
(local → `vendor/esbuild-wasm` → SDK root) unchanged.

**Sucrase is deliberately not adopted.** A pure-JS fallback transformer is only
worth carrying where esbuild-wasm cannot start at all — chiefly Electron-hosted
processes that hide the `node` binary `esbuild.initialize()` expects to spawn.
The Studio server is a plain Node process, and `esbuild-wasm@0.28.1`
`transformSync()` was verified to compile TSX there with no `initialize()` call
and no spawned helper. Adding sucrase would import a fallback for a failure mode
this host cannot reach.

**No new build system is introduced.** `scripts/build-app.mjs` already drives
esbuild-wasm at build time; this change adds one extra entry point to it rather
than a second bundler. The one packaging consequence is real, though:
`esbuild-wasm` is currently a `devDependency` of `@qoder-ai/harness-studio` and
the published `files` list is `dist/` only, so a server that compiles at request
time requires promoting `esbuild-wasm` to a runtime `dependency`.

### 2. Add the artifact catalog (server)

New `packages/harness-studio/src/server/artifact-catalog.ts`, mirroring the
proven shape of `source-catalog.ts`: JSON catalog parsing, opaque ids validated
against a pattern, paths resolved against the catalog's own directory, and an
assertion helper for client input. Reuse that file's exact posture — the client
names an id, never a path.

New `packages/harness-studio/src/server/query/artifact-query.ts` returns artifact
metadata (id, kind, label, byte size) and deliberately omits absolute paths from
responses.

### 3. Add the viewer catalog (server)

Viewer resources are self-contained per format. Verified against
`viewer-pptx`: the provisioned root holds 13 files — `manifest.json`,
`index.canvas.tsx`, `scripts/index.mjs`, `runtime/office-reader.zip`, and
third-party notices. `index.canvas.tsx` is pre-bundled and its only external
imports are `react` and `qoder/canvas`, so the existing import-map plus
`stripCanvasRuntimeImports()` is sufficient; no sibling module tree needs
serving.

Manifest schema, taken from the shipped `pptx` manifest:

```json
{
  "id": "pptx",
  "label": "PowerPoint Presentation",
  "extensions": ["pptx"],
  "pathGlobs": ["**/*.pptx"],
  "dataKey": "officePresentation"
}
```

Resolution order for viewer roots, most explicit first:

1. `--artifact-viewers <catalog.json>` — the supported, testable contract.
2. Provisioned `~/.qoder/canvases/<id>/` (or `$QODER_HOME/canvases/<id>/`).

Auto-discovery is a convenience only. This machine has no `~/.qoder/canvases/`,
so tests and CI must drive the explicit flag rather than depend on a provisioned
IDE.

### 4. Run the Office sidecar (server)

The sidecar contract, decoded from the shipped `pptx` `scripts/index.mjs`:

- **Invocation**: `node <viewerRoot>/scripts/index.mjs`; ESM with top-level
  await.
- **Input**: `QODER_CANVAS_SCRIPT_ARGS` as a JSON string carrying
  `targetFilePath` (`AICODING_CANVAS_SCRIPT_ARGS` is an accepted alias);
  `QODER_CANVAS_TARGET_FILE` is an alternative single-path form.
- **Output**: `QODER_CANVAS_DATA` names a JSON file; the sidecar merges
  `{ [dataKey]: payload }` into it via temp-file-plus-rename. Default is
  `<cwd>/index.canvas.data.json`, so `cwd` must be a per-request directory.
- **Error channel**: the sidecar exits 0 on failure and encodes the problem as
  `payload.error` and `payload.diagnostics[]`. Reading the exit code alone
  reports corrupt input as success (AC-7).
- **Reader runtime**: `runtime/office-reader.zip` is unpacked into a
  sha256-keyed cache under `$QODER_CANVAS_CACHE_DIR`,
  `$QODER_HOME/canvas/runtime-cache/office-reader`, or
  `~/.qoder/canvas/runtime-cache/office-reader`, validated by the presence of
  `main.js` and `_framework/dotnet.js`. It is a .NET WASM reader, so first use
  pays a materialization cost; `VIEWER_OFFICE_READER_DIR` can point at a
  prepared directory.
- **Payload size**: media is inlined as base64 data URLs, so payloads grow well
  beyond the source file. Enforce the 32 MiB source ceiling from AC-9 before
  spawning.

Wrap this in an abortable helper with the timeout, per-request `cwd`, and
cleanup required by AC-8.

### 5. Serve and render (server + app)

Server routes, all namespaced so `serveStatic` keeps its `appDir` root:

- `GET /api/artifacts` — catalog listing.
- `GET /api/artifacts/:id/bytes` — Tier A/B content, `X-Content-Type-Options:
  nosniff`, plus a `Content-Security-Policy` restricting the response.
- `GET /api/artifacts/:id/viewer/` — viewer HTML from the runtime's
  `index-canvas.html`, with the payload injected at the `data: new Map(),` seam.
- `GET /api/artifacts/:id/viewer/canvas-module.js` — compiled viewer module,
  mtime-and-size cached per AC-10.
- `GET /api/artifacts/:id/viewer/canvas-sdk.js` — the discovered runtime bundle.

App side: new `artifact-view-model.ts` holding `resolveArtifactKind()` and a
`ArtifactKind -> () => import(...)` lazy renderer table, so heavy renderers stay
separate browser chunks; new `ArtifactView.tsx` for the pane/tab/toolbar
surface; and `RunView.tsx` updated so `ArtifactsInspector` consumes real data
(AC-12).

Tier C iframes get `sandbox="allow-scripts"` and no `allow-same-origin`. Note
this is deliberately stricter than the SDK's own `CanvasFormatViewer`, which
uses `allow-scripts allow-same-origin`; that pairing is defensible in an IDE
where both viewer and target are first-party, but here the artifact data is
untrusted.

### 6. Defer the artifact source kind

`docs/specs/2026-08-18-harness-studio-information-architecture.md` defines
`StudioArea` entries as durable product objects and warns against presenting
roadmap capability as implemented. Increment 1 adds the `artifacts` destination
because a directory of run outputs is a durable object with an honest
`foundation` state, but leaves `StudioSourceKind` and the switchable-source
machinery unchanged: artifacts are not yet a retained, switchable Studio input.

## Test and Review Evidence

- AC-1/AC-2/AC-14: `npx vitest run packages/harness-studio/test/artifact-view-model.test.ts`
- AC-4/AC-5/AC-14: `npx vitest run packages/harness-studio/test/artifact-catalog.test.ts`
- AC-6/AC-7/AC-8/AC-9: `npx vitest run packages/harness-studio/test/artifact-viewer-sidecar.test.ts`,
  including a corrupt-`.pptx` fixture that asserts the error surfaces from the
  payload while the process exits 0, and an oversized fixture that asserts no
  spawn occurs
- AC-3/AC-11/AC-13: `npx playwright test packages/harness-studio/test/browser/artifact-view.spec.mjs`
  at wide, compact, and narrow widths, asserting absent console and page errors,
  visible keyboard focus, absent document-level horizontal overflow, the SVG
  script's side effect absent, and saved screenshots per layout
- AC-10: assert two sequential viewer-module requests for one unchanged
  artifact produce one transform call
- AC-12: assert `ArtifactsInspector` output for a run with no artifacts contains
  no filename
- Repo gates: `npm test`, plus
  `npx vitest run test/skills-docs/doc-link-graph.test.mjs` for this spec's links

### Risks

- **Server-side execution of SDK-provided scripts.** Tier C runs
  `scripts/index.mjs` from a discovered viewer root. That root is trusted input;
  a catalog pointing at an untrusted directory is a code-execution path. The
  catalog is operator-supplied, never client-supplied, and AC-4 keeps client
  input to opaque ids.
- **Hard Canvas runtime dependency** (D-2). Tier C fails with an error rather
  than degrading. Tier A and B remain functional because the tier split makes
  them runtime-independent by construction.
- **First-run cost.** Materializing the .NET WASM Office reader is a
  multi-megabyte, one-time unpack that will make the first Office artifact
  noticeably slow.
- **Payload size.** Base64-inlined media means a modest `.pptx` can yield a much
  larger payload; AC-9's ceiling bounds it but does not eliminate memory
  pressure.
- **Internal registry coupling.** The viewer packages publish to an internal
  registry, so Tier C cannot be exercised in a public CI environment. Tier C
  tests must be skippable on a documented condition rather than silently green.
