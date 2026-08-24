# Complete retained Session review in Studio

## Traceability

- Spec ID: studio-inspector-session-parity
- Status: Implemented

## Intent

Finish the React-owned Session detail in Harness Studio so `#/sessions` preserves
the read-only review workflow already implemented by the standalone Harness
Inspector workbench. Studio continues to consume `HarnessInspectorReportV1` and
does not execute `workbench.js`; the standalone report remains the interaction
and visual contract.

## Acceptance Scenarios

- **AC-1:** Opening a retained Session renders the same notebook hierarchy as
  Inspector: numbered `In` and `Out` rows, an initially collapsed ordered
  Process trace, an evidence-bounded Outcome, unplaced evidence, commits outside
  observed Turn windows, and one overall Session activity summary.
- **AC-2:** The Session outline provides Turn/evidence navigation, expand and
  collapse controls, kind/tool/file filters, and observed Session facts. Tool
  steps resolve through the retained call ledger, adjacent calls keep observed
  order, and filters update the visible retained-call count.
- **AC-3:** Replay provides Events and Files indexes, previous/next and play/pause
  controls, 1x/2x/4x/8x speed selection, a sequence or observed-time rail, and
  keyboard J/L/Space navigation without executing or resuming the Session.
- **AC-4:** Opening Session detail creates a navigable Studio state. Close,
  Escape, and browser Back return to the workbench and restore focus to the
  initiating control; a copied Studio URL reopens the selected Session and
  Replay event when the report still contains them.
- **AC-5:** Wide, compact, and narrow layouts have no document-level horizontal
  overflow. At narrow width the outline remains reachable, controls retain
  visible keyboard focus, and the primary notebook decision path remains clear.
- **AC-6:** Focused model/component and browser tests exercise the behaviors
  above against retained ordered messages, tool calls, files, and Replay events.
  Browser verification checks console/page errors and screenshots.

## Non-goals

- Changing Inspector discovery, normalization, privacy filtering, correlation,
  or `HarnessInspectorReportV1` ownership.
- Executing Replay, resuming a native Session, mutating checkpoints, or writing
  back to host evidence stores.
- Removing the compact Catalog & Compare view or the standalone Inspector report.
- Claiming a patch, successful edit, verification result, or causal commit link
  when the retained report does not provide that evidence.

## Plan and Tasks

1. Add a pure retained-Session projection seam for ordered Turn calls, commit
   placement, unplaced evidence, filter counts, and Replay navigation.
2. Replace the simplified React Session detail with Inspector-compatible Trace,
   Outcome, outline, filtering, activity, and Replay components.
3. Synchronize Session/Replay selection with Studio navigation and restore focus
   on close without taking ownership from the outer Studio router.
4. Extend focused tests and the Sessions Playwright walkthrough, then run package,
   browser, link-graph, preview, and diff checks proportional to the change.

## Test and Review Evidence

- AC-1/AC-2/AC-3: focused model tests and Sessions browser assertions.
- AC-4: browser assertions for open, URL state, Back, Escape, and focus return.
- AC-5: 1440x900, 1024x768, and 390x844 screenshots plus overflow and focus
  checks.
- AC-6: console/page error collection, package tests, documentation link graph,
  preview health and Canvas module smoke, and `git diff --check`.
- Risk: Studio can accidentally overstate retained evidence. Copy and projections
  must preserve missing timestamps, unavailable responses, privacy redaction,
  and the read-only boundary used by the standalone workbench.

Implementation evidence (2026-08-24):

- `npm test -- --reporter=dot`: 103 files passed with 1,532 tests passed and one
  skipped repository-wide.
- `npm test -w @qoder-ai/harness-studio`: 43 files and 266 tests passed.
- `npm run test:browser -w @qoder-ai/harness-studio`: all 40 Playwright tests
  passed. The Sessions flow exercised ordered Process expansion, Outcome,
  filters, Replay, URL state, Escape/focus restoration, and 1440x900, 1024x768,
  and 390x844 screenshots without document overflow.
- The final focused Sessions Playwright run passed after Replay auto-follow,
  restart, legend, and tab-keyboard behavior were added.
- `npx vitest run test/skills-docs/doc-link-graph.test.mjs`: 8 tests passed after
  regenerating `docs/better-harness-doc-links.mmd`.
- Live in-app browser review used a 36-call retained Session, exercised Process
  expansion, tool filtering, Replay event navigation and URL state, and found no
  console warnings or errors. The repository Preview returned `ok` from
  `/health`, loaded `/canvas-module.js`, and `git diff --check` passed.
