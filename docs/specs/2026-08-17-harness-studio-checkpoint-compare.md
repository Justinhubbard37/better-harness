# Checkpoint-anchored multi-lane harness experiments

## Traceability

- Spec ID: harness-studio-checkpoint-compare
- ADR: [Harness Checkpoint Experiment Compare](../adrs/harness-checkpoint-experiment-compare.md)
- Status: Slices 1 and 3 implemented; Slice 2 clean-tree path implemented, dirty-state replay pending

## Intent

Let a Studio user pick one Git checkpoint, replay the observed historical
trajectory beside two freshly executed lanes from that same checkpoint, and read
one attribution verdict per comparison instead of a single global verdict.

The `.harness` grammar and the `session-execution-plan-v1` checkpoint contract do
not change. A sandbox stays a per-lane materialization of the one checkpoint. The
new surface is an experiment manifest that references a checkpoint, declares N
lanes of mixed origin, and lets the runner *derive* what each comparison is
allowed to conclude.

This spec covers three slices. Slice 1 is the evidence semantics: the manifest
contract, derived treatment axes, observed-lane degradation, and per-contrast
decisions. Slices 2 and 3 add checkpoint materialization and the Studio
experiment lifecycle on top of the same contract.

## Acceptance Scenarios

### Slice 1 — experiment contract and evidence semantics

- AC-1: `harness-experiment.v1` validates a manifest holding a `checkpointRef`
  (plan path plus digest) and never a copy of checkpoint fields. Loading resolves
  manifest-owned relative paths, rejects absolute, backslash, and `..` paths, and
  rejects any path escaping the manifest directory.
- AC-2: a lane is either `origin: "observed"` (trajectory path plus the
  checkpoint digest it started from, and optional identity evidence) or
  `origin: "execute"` (harness id, trial count, and per-lane runtime profile and
  model). Host, visible tools, and the run policy stay shared across lanes, so a
  lane cannot silently move the host.
- AC-3: a contrast declares only its `id` and the lane ids it compares. A
  manifest that declares `axis` or `mode` on a contrast is rejected, because the
  axis is a derived fact about lane configuration, not an author's claim.
- AC-4: `deriveContrastAttribution` computes the moved axes by diffing the
  contrast lanes' harness id, runtime profile, and model. Exactly one moved axis
  over exactly two execute lanes yields `attributable` with that axis. Zero moved
  axes, more than one moved axis, more than two lanes, or an unmatched observed
  lane yields `descriptive` with a named reason and the full moved-axis list.
- AC-5: an observed lane is matched baseline evidence only when every identity
  fact is present and equal to the fresh lanes — harness id, revision id, runtime
  profile, model, environment receipt — its prompt hash equals the experiment task
  prompt hash, and the checkpoint completeness receipt is not `unverified`.
  Otherwise it is contextual evidence and the contrast is descriptive.
  `evaluateObservedLane` names each missing fact so a reader can see why.
- AC-6: an attributable contrast is decided by the existing
  `harness-compare.v1` ladder — `aggregateVariant`, `summarizeMatchedPairs`, and
  `decideVerdict` under `normalizeDecisionPolicy` — so the two-matched-pair floor
  still applies. A contrast whose lanes ran once each therefore reports
  `insufficient_evidence`, never `accept`. A descriptive contrast reports status
  `descriptive` and can never report `accept` or `reject`.
- AC-7: `buildExperimentCompareSet` emits `harness-compare-set.v2` with one
  aggregate per lane, one result per contrast, the shared checkpoint digest and
  completeness receipt, the task prompt and grader hashes, and the decision
  policy the contrasts were judged under. Observed lanes may carry no grade, so
  they aggregate as observed rows without inventing a score.
- AC-8: focused tests cover manifest acceptance and each rejection reason, axis
  derivation for the harness, runtime-profile, model, multi-axis, and no-axis
  cases, observed-lane degradation per missing fact, single-run contrasts
  reporting insufficient evidence, and descriptive contrasts never carrying a
  promotion status.

### Slice 2 — checkpoint materialization and parallel lanes

- AC-9: every lane clears preflight (checkpoint digest, base commit and tree,
  session digest and entry) before any lane starts executing.
- AC-10: materialization records a checkpoint completeness receipt: a clean-tree
  assertion or a captured dirty-state patch applied identically to every fresh
  lane. An `unverified` receipt keeps observed lanes contextual.
- AC-11: worktree creation is serialized to avoid Git lock contention; lane
  execution then runs in parallel and one lane's failure preserves the other
  lanes' evidence.
- AC-12: every emitted event carries `experimentId`, `laneId`, and `runId`; each
  lane persists its own revision, runtime and sandbox receipts, trajectory,
  patch, and grade under a per-lane evidence directory. Results stay on
  namespaced refs and no user branch is switched.

### Slice 3 — Studio experiment lifecycle

- AC-13: Studio creates an experiment, streams per-lane events, and supports
  cancellation, instead of the single stateless `/agui` run.
- AC-14: the configuration surface shows which axes the current lane setup moves
  and marks a comparison descriptive before it runs.
- AC-15: the three-column view synchronizes turn, tool call, file, and patch
  selection, pins the shared checkpoint and task identity, and renders one
  verdict per contrast with no global aggregate verdict.
- AC-16: live ACP-derived tool events are normalized into an inspectable
  cross-lane key (tool name, resource target, and canonical arguments). Selecting
  a tool call in any lane locates its best one-to-one match in the other lanes
  and labels the relation `exact`, `same-resource`, `same-tool`, or `none`; a
  numeric similarity score alone is never presented as provenance.
- AC-17: Studio visualizes the local tool chain around the selection — previous,
  selected, and next call — so a reviewer can distinguish “both read the same
  file” from “both followed the same read → edit → test path.” Matching remains
  monotonic within a lane, preventing one repeated `Read` call from being reused
  as the apparent counterpart of several calls.
- AC-18: the experiment view defaults to monitoring-console density. At a
  1200×900 viewport the shared identity, attribution preview, all three lane
  headers, and at least six tool rows are visible without page-level horizontal
  scrolling. At narrower widths, horizontal scrolling is contained by the trace
  matrix rather than widening the document. Shared identity and lane runtime
  facts are each rendered once; the selected local chain is an inline inspector,
  not a second full-size comparison board.
- AC-19: Studio may replay a real imported trajectory whose starting Git
  checkpoint was not recorded. Such a lane omits `startCheckpointDigest`, is
  labelled `checkpoint unknown`, and is always contextual evidence with a named
  `startCheckpointDigest` gap. A recorded digest that differs from the shared
  checkpoint remains a manifest error. The UI must never turn an absent digest
  into a claim that history and fresh lanes share a start.
- AC-20: the experiment surface adopts the Inspector Workbench information
  architecture rather than stacking independently floating cards: a fixed or
  collapsible context rail owns checkpoint, task, lane, and contrast setup; a
  42 px workspace header owns navigation and aggregate metrics; and one
  continuous workbench owns the selected call, three adjacent lanes, local
  chain, and contrast results. At 1024×576, the workbench begins within 12 px of
  the workspace header, lane rows are at most 30 px high, adjacent lanes have no
  card gap or separate shadow, and the document does not scroll horizontally.
  At narrow widths, the context rail collapses and horizontal scrolling remains
  inside the lane board.

## Non-goals

- Extending `harness-compare.v1`. It stays the frozen-fixture, two-variant path,
  and its persisted `harness-compare-result.v1` consumers are untouched.
- Changing the `.harness` grammar, the IR, or the checkpoint contract.
- A `host` treatment axis. A single experiment runs one host; cross-host
  comparison needs its own confounding analysis.
- Reconstructing environment state the historical trajectory depended on beyond
  what the completeness receipt can capture as a patch.
- Promoting or adopting any lane's result commit. Adoption stays an explicit
  later user action against the namespaced ref.
- Grading observed trajectories that predate the grader contract.

## Plan and Tasks

1. Split the contract by runtime need. `packages/harness/src/experiment/contract.ts`
   owns the `harness-experiment.v1` TypeBox schema, lane types, and pure lane
   predicates with no Node imports;
   `packages/harness/src/experiment/manifest.ts` owns
   `loadHarnessExperimentManifest` and the validation that needs real paths —
   unique lane and contrast ids, contrast lane references, at least one execute
   lane, observed lanes starting from the referenced checkpoint, and portable
   manifest-owned paths.
2. Add `packages/harness/src/experiment/axis.ts` with the derived
   `ExperimentTreatmentAxis`, `deriveContrastAttribution`, and
   `evaluateObservedLane`. Keep the axis derived from lane configuration so a
   manifest cannot label a multi-axis comparison as single-axis.
3. Add `packages/harness/src/experiment/compare-set.ts` with
   `ExperimentTrialResult`, per-lane aggregation, contrast projection onto the
   existing baseline/candidate pair shape, `decideContrast`, and
   `buildExperimentCompareSet`. Reuse the `compare/aggregate.ts` ladder rather
   than restating thresholds, so the matched-pair floor cannot drift.
4. Add `packages/harness/src/experiment/checkpoint.ts` with the
   `CheckpointCompleteness` receipt union that slice 2 will produce and slice 1
   already consumes in the observed-lane rule.
5. Export two entries: `@qoder-ai/harness/experiment/evidence` for the
   browser-safe semantics Studio will render, and `@qoder-ai/harness/experiment`
   for the same surface plus the Node loader. Mirror the boundary
   `compare/verdict` already draws, and extend `test/module-graph.test.ts` to
   enforce it. Ship an example manifest under
   `packages/harness/examples/checkpoint-experiment/`.
6. Add `packages/harness/test/experiment.test.ts` covering AC-1 through AC-8 by
   calling the exported functions and asserting returned shapes and statuses.
7. Add a Studio experiment stream with lane-scoped lifecycle and ACP events.
   Normalize tool calls in a pure browser module, align calls monotonically, and
   render the selected cross-lane relation and local chain in a three-column
   trace matrix before showing per-contrast result cards.
8. Add a Node experiment runner that verifies the referenced plan bytes and
   `session-execution-plan-v1` contents before materialization, creates detached
   worktrees serially, executes prepared jobs through an injectable executor in
   parallel, and persists lane-scoped evidence and namespaced refs. The current
   implementation records a dirty source workspace as `unverified`; applying a
   captured dirty-state patch identically to every fresh lane remains open.
9. Tighten the Studio information hierarchy into one compact experiment bar,
   one three-lane trace matrix, an inline selection inspector, and compact
   per-contrast result rows. Add viewport measurements to the browser test so
   “compact” is a behaviour contract rather than a screenshot impression.
10. Permit checkpoint provenance to be absent on imported observed lanes,
    propagate that absence into observed-lane eligibility, and exercise the UI
    with a real Better Harness Qoder transcript. Keep external transcript paths
    as demo/runtime input rather than shipping user history in the repository.
11. Recompose the experiment view from the Inspector Workbench primitives: one
    collapsible context rail, one 42 px workspace header, and one continuous
    lane board with divider-separated columns and an integrated evidence
    footer. Verify the source and implementation at the same 1024×576 viewport.

## Test and Review Evidence

- AC-1 through AC-8 and AC-19: `npm test -w @qoder-ai/harness` — 17 files and
  179 tests pass. The 25 experiment tests load real manifest fixtures from a temporary
  directory and assert loader results, derived attribution objects,
  observed-lane missing-fact lists, and contrast statuses. AC-6 is proved by a
  counterfactual: one set of trial rows judged twice, reaching `accept` when the
  lanes move one axis and `descriptive` when they move two.
- Repository suite: `npm test` — 95 files and 1325 tests pass, so the new
  subpath exports do not disturb CLI, governance, or doc-link checks.
- Module boundary: `test/module-graph.test.ts` asserts the emitted
  `dist/experiment/evidence.js` graph reaches neither `node:` builtins nor the
  manifest loader, so slice 3 can import the evidence semantics into Studio's
  browser bundle. It asserts the built artifact deliberately, because `import
  type` is indistinguishable from a real import when lexing TypeScript source.
- Packaging: `npm pack --dry-run --ignore-scripts -w @qoder-ai/harness --json`
  includes `dist/experiment/*` with declarations and the
  `examples/checkpoint-experiment/` manifest.
- Risk: a second manifest schema invites drift from `harness-compare.v1`. The
  mitigation is that slice 1 owns no thresholds of its own; every promotion
  decision is delegated to `decideVerdict` under `normalizeDecisionPolicy`.
- Risk: an experiment with one run per lane looks like a comparison but is a
  smoke test. The mitigation is structural rather than documentary: the shared
  ladder returns `insufficient_evidence` below two matched pairs.
- Risk: an observed trajectory is easy to mistake for a matched baseline. The
  mitigation is that eligibility requires every identity fact including prompt
  hash equality, which historical sessions almost never satisfy, and the missing
  facts are reported rather than silently ignored.
- Risk: slice 1 validates the `checkpointRef` digest and path but does not open
  the referenced plan, so a manifest can name a checkpoint that no longer
  resolves. Slice 2's preflight (AC-9) is where that becomes an error; until
  then the reference is a recorded claim, not a verified one.
- Risk: fuzzy matching can look like causal proof. Studio therefore exposes the
  matching basis (`tool`, `resource`, canonical arguments, and neighbouring
  calls), reserves `exact` for identical normalized inputs, and renders `none`
  rather than forcing every call into a pair.
- AC-9, AC-11, and the clean-tree portion of AC-10/AC-12:
  `packages/harness/test/experiment-runner.test.ts` creates a real temporary Git
  repository and Pi checkpoint plan, proves two prepared lanes overlap in
  execution, reads the persisted compare set, checks namespaced result refs, and
  confirms temporary worktrees were removed. The dirty-state-patch branch of
  AC-10 remains pending; dirty workspaces deliberately produce `unverified`.
- AC-13, AC-14, AC-16, and AC-17: Studio tests cover preview, same-origin SSE,
  lane identity fields, cancellation, exact/same-resource/same-tool/none
  normalization, one-to-one monotonic alignment, and local chain projection.
  The Playwright flow starts a scripted two-lane executor, correlates both fresh
  traces against the recorded history trace, inspects per-contrast results, and
  asserts no console or page errors at 1200 px. AC-15 is complete for tool and
  resource synchronization; turn and patch-detail synchronization remain open.
- AC-18 and AC-20: `npm test -w @qoder-ai/harness-studio` passes 5 files and 39
  tests; `npm run test:browser -w @qoder-ai/harness-studio` passes three flows.
  The 1024×576 flow measures the 230 px context rail, 42 px workspace header,
  workbench at y=52, adjacent lane gap at most 1 px, 29 px tool row, and
  six-row viewport capacity. The 390 px flow crosses the responsive breakpoint,
  proves the rail collapses to 46 px, and keeps the 730 px lane board inside the
  workspace scroller without widening the document. A successful run also
  proves that completion metadata is not rendered as an error detail.
- Real-project runtime smoke: `test/fixtures/real-project-experiment-server.mjs`
  built a checkpoint plan at Better Harness commit
  `1a6b0a134f229a786e0338d86de440fc50dc05a0`, imported 84 real Qoder Tool Calls
  with unknown checkpoint provenance, and executed the default and minimal
  Qoder profiles in parallel detached worktrees. The final visual-QA run
  finished with 26 and 33 Tool Calls. The one-pair profile contrast correctly returned
  `insufficient_evidence`; the historical contrast remained `descriptive`.
  This live smoke supplements rather than replaces the credential-independent
  deterministic browser test.
- Visual QA: `design-qa.md` records the source-to-implementation comparison. At
  the same 1024×576 viewport, the Inspector source and Studio both use the fixed
  context rail, 42 px header, and one workbench beginning at y=52. The real run
  additionally exercised streaming status/count updates, a selected shared
  resource and its local chain, collapse behavior, and completed verdicts.
