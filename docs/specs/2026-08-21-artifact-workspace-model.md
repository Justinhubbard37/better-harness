# Shared Artifact Workspace Model

## Traceability

- Spec ID: artifact-workspace-model
- Story: unavailable (direct workspace request)
- Status: Implemented

## Intent

Make Harness Studio the canonical open-source owner of a small, domain-neutral
artifact programming model so the public Studio package and current product
integrations can share the same revision, proposal, planning, execution,
verification, and artifact contracts.

The model must remain neutral to Lottie, PPTX, mobile automation, and any one
renderer. Harness Studio's existing read-only Artifact View should project its
catalog through the shared snapshot and artifact-reference vocabulary without
claiming mutation support.

## Acceptance Scenarios

- AC-1: `@qoder-ai/harness-studio/artifact-workspace` exports the common domain
  type family, revision-bound proposal, transaction/scenario plans, execution
  receipt, verification, artifact-reference, driver, and guarded runtime.
- AC-2: The runtime rejects a wrong domain/workspace, stale named revision
  clocks, invalid plan execution mode, and any plan carrying error diagnostics
  before delegating execution.
- AC-3: Harness Studio's artifact catalog response includes an opaque workspace
  descriptor and snapshot revision derived from exact artifact bytes; public
  descriptors retain no filesystem paths and use the shared artifact-reference
  digest vocabulary.
- AC-4: Existing direct and provisioned Canvas renderer selection, content
  confinement, sandboxing, and sidecar behavior remain unchanged.
- AC-5: Focused model/catalog/server tests and the Harness Studio package build
  pass on the repository's supported Node and TypeScript toolchain.

## Non-goals

- Implement Lottie, PPTX, or mobile-simulator authoring adapters in Better
  Harness.
- Add artifact editing controls or change Harness Studio visual design.
- Turn Artifact View's read-only presentation into a fake transaction.
- Publish packages, change package versions, or alter release metadata.
- Make Canvas viewer compilation alone count as format or visual fidelity proof.

## Plan and Tasks

1. Add a browser-safe `src/artifact-workspace/` public contract/runtime boundary
   and expose it through a package subpath.
2. Add behavioral tests for transaction/scenario execution and fail-closed
   revision/mode/diagnostic guards.
3. Give artifact catalog entries exact-byte digests and build an opaque catalog
   snapshot using the shared `SnapshotRef`, `WorkspaceDescriptor`, and
   `ArtifactRef` vocabulary.
4. Return that descriptor/snapshot from `/api/artifacts` while preserving the
   existing `artifacts[]` projection consumed by the Studio UI.
5. Run focused tests, Harness Studio package tests/build, and a local diff scope
   check that preserves unrelated Studio visual work.

## Test and Review Evidence

- AC-1 through AC-4: from `packages/harness-studio`, `npx vitest run
  test/artifact-workspace.test.ts test/artifact-poc.test.ts
  test/artifact-viewers.test.ts test/server.test.ts` passed 63 tests in 4 files.
- AC-5: `npm run harness-studio:test` rebuilt the package and passed 127
  tests in 19 files.
- Public package boundary: package-local `npm pack --dry-run --json
  --ignore-scripts` included all `dist/artifact-workspace/*.js` and `*.d.ts`
  files, and a workspace import of
  `@qoder-ai/harness-studio/artifact-workspace` succeeded.
- Diff hygiene: `git diff --check` passed. Pre-existing Studio visual changes
  remain unstaged and outside this implementation boundary.
- Risk: hashing adds catalog I/O proportional to exact artifact bytes. The
  catalog already bounds imported artifacts, but configured external directories
  remain operator-controlled; hashing must stream rather than buffer files.
- Risk: the package subpath is a new public contract. Keep the first version
  small, dependency-free, browser-safe, and explicit about unsupported plans.
- Review boundary: do not stage or rewrite the pre-existing Studio visual spec,
  UI files, CSS, browser tool-call test, or `.agents/skills/ui-ux-pro-max/`.
