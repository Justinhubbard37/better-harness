# Unify artifact revisions, adapters, and renderers in Studio

## Traceability

- Spec ID: studio-artifact-view-model
- Status: Implemented

## Intent

Refactor Harness Studio's flat preview descriptor into a data-backed Artifact
View lifecycle with explicit content revisions, data adapters, immutable
snapshots, renderer providers, and user-facing browsing. Use that lifecycle to
render PPTX files in Studio without treating Canvas as the universal Artifact
abstraction or executing presentation bytes as code.

Canvas remains the name of the existing Qoder Canvas Viewer integration only.
The Studio-owned abstraction is Artifact View:

```text
Artifact Revision -> Data Adapter -> Data Snapshot -> Renderer -> View Host
```

This increment implements the data-backed half of that model. Code project
compilation, build snapshots, preview execution, cross-revision comparison, and
Session trace addressing remain future work.

## Decisions

### D-1: Catalog V2 owns file identity and presentation references

`HarnessStudioArtifactCatalogV2` remains a read-only, browser-safe catalog. Each
descriptor contains:

- a stable catalog-local thread id;
- an exact revision id and SHA-256 digest;
- the bounded content reference;
- a data-backed family and format;
- the selected adapter id/version/schema and snapshot URI;
- the selected renderer id/provider/type/status;
- renderer capabilities and an optional unavailable reason.

The catalog does not inline parsed Office payloads, absolute paths, runtime
code, UI state, or Session claims. V1 is superseded rather than extended with a
parallel optional-field vocabulary.

### D-2: ArtifactDataSnapshotV1 is immutable and format-specific

Every snapshot is bound to one artifact id and revision id. Its common envelope
contains adapter provenance, summary, structure, semantic addresses, resources,
diagnostics, and a discriminated payload. The first payloads are:

- `artifact/raw-v1`: exact content reference for direct text/image/SVG/JSON
  renderers;
- `pptx/v1`: deck size, ordered slides, shapes, text runs, images, notes,
  addresses, and unsupported-feature diagnostics.

Snapshot generation is bounded by compressed input, expanded entry, entry
count, text, media, and response limits. Artifact bytes never choose an adapter
or local executable path.

### D-3: The plugin registry chooses Adapter and Renderer separately

The trusted registry resolves one data adapter and one renderer for each file.
Resolution order is:

1. an operator-provisioned Qoder Canvas viewer with `overrideBuiltIn`;
2. a Studio-native data-backed plugin;
3. a matching non-overriding Qoder Canvas viewer;
4. the raw adapter plus an honest unavailable renderer.

Qoder viewer `scripts/index.mjs` is wrapped as a
`QoderViewerSidecarAdapter`; `index.canvas.tsx` is wrapped as a
`QoderCanvasRenderer`. The existing opaque-origin iframe and runtime discovery
remain the bridge implementation.

The current `esbuild-wasm` transform is a `TrustedRendererCompiler`. It compiles
only provisioned renderer code and is not an Artifact compiler.

### D-4: PPTX has a cross-platform native baseline

`PptxArtifactDataAdapter` parses untrusted OOXML with pure JavaScript libraries
inside the Studio server. It reads slide order, slide dimensions, positioned
shapes, text runs, fills, images, and speaker-note presence into `pptx/v1`.

`NativePptxRenderer` renders the snapshot as a slide rail plus DOM stage. It
supports navigation, zoom-to-fit, and semantic slide/shape addresses. Unsupported
OOXML is reported in diagnostics; the baseline is observable coverage, not
PowerPoint or Walnut pixel parity.

An installed ChatGPT Walnut runtime remains an explicit, Studio-private,
experimental provider receipt. `harness-studio walnut probe|install|verify|remove`
may provision reviewed assets only after consent, but no private ChatGPT API is
treated as a parser contract. The native PPTX adapter is therefore the default
portable fallback. A future reviewed Walnut adapter can implement the same
snapshot schema without changing the catalog or renderer host.

### D-5: Artifact View uses a grouped Explorer

The left pane defaults to collapsible format families:

1. Documents;
2. Images & diagrams;
3. Data;
4. Source & text;
5. Other.

It provides filename search and a `Grouped | Flat` presentation switch. This is
not a filesystem tree: the current catalog has no relative paths or directory
nodes. Folder Tree becomes eligible only after a future catalog owns confined
path hierarchy and recursive indexing.

Rows show a format icon, filename, human format, size, and an accessible
unavailable indicator. The preview owns the selected filename, revision,
adapter/renderer metadata, snapshot diagnostics, and document navigation.

At narrow width, Explorer and Preview become two view tabs so a long list cannot
push the selected document below the fold.

## Acceptance Scenarios

- **AC-1:** `/api/artifacts` returns only a valid
  `HarnessStudioArtifactCatalogV2`; each artifact has an exact revision and
  content digest, adapter reference, snapshot URI, renderer reference, family,
  and capabilities. Absolute filesystem paths never reach the browser.
- **AC-2:** `/api/artifacts/:id/snapshot` returns a valid
  `ArtifactDataSnapshotV1` bound to the descriptor revision. A changed source
  digest cannot reuse the prior snapshot.
- **AC-3:** Direct code, diff, JSON, text, image, and SVG behavior remains inert
  and readable through native renderers. Arbitrary artifact TSX/JSX is never
  executed.
- **AC-4:** A real PPTX produces ordered slides, dimensions, positioned text
  shapes, embedded images, notes presence, semantic addresses, and explicit
  diagnostics. Corrupt, oversized, path-traversing, or expansion-heavy OOXML
  fails closed without stopping other Studio routes.
- **AC-5:** The native PPTX renderer opens the repository's
  `Better-Harness-one-page.pptx` in Studio, visibly renders its first slide,
  exposes slide navigation and adapter/renderer identity, and has no page or
  console errors.
- **AC-6:** An overriding Qoder viewer still wins. A non-overriding viewer is a
  fallback when no native plugin exists. Qoder sidecar adaptation and renderer
  compilation retain timeout, size, temp cleanup, path scrubbing, CORS, CSP,
  and opaque-origin iframe boundaries.
- **AC-7:** Walnut bootstrap remains explicit, content-addressed,
  receipt-verified, Studio-private, and absent from normal startup, npm package
  bytes, source control, and release claims. Missing or unreviewed Walnut builds
  do not disable native PPTX rendering.
- **AC-8:** Grouped and Flat explorer modes preserve the selected revision;
  search matches filenames only; empty groups disappear; PPTX belongs to
  Documents regardless of renderer provider.
- **AC-9:** At 1440x900, 1024x768, and 390x844, the explorer and PPTX stage have
  no document-level horizontal overflow, keyboard focus is visible, the preview
  remains reachable, and dark/light contrast remains accessible.
- **AC-10:** Debugger and other catalog consumers use V2 descriptors without
  inventing retained artifacts or reconstructing content/snapshot URLs from
  ids.
- **AC-11:** Package typecheck/build/tests, root tests, package audit, Markdown
  link graph, and preview health/runtime smoke checks pass or report an exact
  external Canvas-runtime prerequisite separately.

## Non-goals

- ArtifactThread persistence across renamed files or independent Sessions.
- Parent revision chains, replay storage, compare mode, annotations, mutation,
  save-back, or Office round-trip editing.
- XLSX, DOCX, PDF, GLB, Lottie, or Mermaid native adapters in this increment;
  the registry and snapshot contract make them additive follow-ups.
- ArtifactCompileRuntime, project bundling, virtual filesystems, incremental
  rebuilds, WebContainer, Sandpack, or executable React artifacts.
- Copying or distributing Walnut, ChatGPT hashed chunks, private protobufs,
  application IPC, or full `ArtifactTabContent` UI.
- Claiming PowerPoint, Walnut, or Qoder Canvas pixel parity.

## Plan and Tasks

1. Replace the V1 catalog contract with browser-safe V2 revision, adapter,
   renderer, family, capability, and snapshot contracts.
2. Introduce an Artifact plugin registry; adapt existing direct renderers and
   Qoder Canvas discovery behind separate adapter/renderer references.
3. Rename the trusted Canvas TSX transform boundary to
   `TrustedRendererCompiler` and the host boundary to
   `QoderCanvasViewerBridge`, retaining compatibility re-exports only where
   focused tests still need them.
4. Implement bounded OOXML ZIP/XML parsing, PPTX snapshots, snapshot/resource
   routes, cache identity by source digest plus adapter version, and behavioral
   malformed-input tests.
5. Implement the grouped Artifact Explorer and native PPTX renderer with shared
   Studio tokens, semantic slide addresses, diagnostics, and responsive tabs.
6. Keep and integrate the explicit Walnut bootstrap commands as provider
   capability evidence; do not make Studio startup mutate the cache.
7. Validate direct renderer regressions, Qoder override/fallback behavior, the
   real repository PPTX, browser layouts, package/root gates, package contents,
   and diff hygiene.

## Test and Review Evidence

- AC-1/AC-2/AC-4/AC-10: 137 Studio tests passed across 21 files. Focused PPTX
  tests cover exact revision and snapshot binding, leading-zero text, positioned
  shapes, embedded resources, notes path redaction, semantic addresses, corrupt
  archives, unsafe ZIP paths, oversized expanded entries, and cache invalidation.
- AC-3/AC-6: the V2 catalog, direct renderers, Qoder override/fallback registry,
  sidecar freshness, trusted renderer compilation, active-content CSP, SVG
  sandbox, and malformed route behavior all remain covered in that package run.
- AC-5/AC-8/AC-9: all 17 Playwright scenarios passed. Native PPTX rendering,
  Grouped Explorer, wide 1440x900, compact 1024x768, narrow 390x844, automatic
  Preview navigation, keyboard focus, horizontal overflow, theme contrast, and
  browser errors are verified with screenshots. The live in-app browser also
  rendered `Better-Harness-one-page.pptx`: 19 shapes, one complete 1280x950
  image, preserved `01` text, no page overflow, and no console/page errors.
- AC-7: eight focused Walnut bootstrap tests cover explicit consent,
  content-addressed install, verification, tamper detection, app-change
  invalidation, symlink rejection, removal, and cross-platform cache roots. A
  read-only real probe found ChatGPT 26.818.22352 and 34 reviewed assets for
  DOCX/PPTX/XLSX. Package dry-run contained 926 files and no ASAR/WASM or
  extracted ChatGPT asset.
- AC-11: Studio typecheck/build/tests, full browser suite, 1,435 root tests,
  six Markdown link-graph tests, package dry-run, and `git diff --check` passed.
  The optional root Canvas preview smoke was not runnable because no Canvas SDK
  runtime was configured; native PPTX rendering does not use that runtime.

### Risks

- **Model overreach:** the attachment describes a larger future runtime. This
  increment freezes only data-backed contracts exercised by current consumers.
- **PPTX fidelity:** fonts, themes, layout inheritance, charts, SmartArt,
  animation, cropping, and grouped transforms are complex. Diagnostics must
  preserve uncertainty rather than imply parity.
- **Archive expansion:** OOXML is a ZIP container. Enforce compressed,
  expanded, entry-count, path, media, and snapshot limits independently.
- **Plugin trust:** artifact bytes may select a format but never a plugin path.
  Only the operator-controlled registry and provisioned viewer roots execute.
- **Cache staleness:** cache keys include artifact digest, adapter id/version,
  and schema id; mutable file metadata alone is not sufficient identity.
- **UI density:** format groups improve findability only if search, selection,
  disclosure, and narrow Preview navigation remain distinct and keyboard-safe.
