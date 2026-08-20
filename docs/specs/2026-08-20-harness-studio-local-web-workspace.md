# Browse and compare local sessions in Harness Studio

## Traceability

- Spec ID: harness-studio-local-web-workspace
- Status: Implemented

## Intent

Harness Studio is a local Web application, not a collection of views enabled by
startup flags. Launching the server should open an empty workbench. The user
then chooses a local directory in the browser, Studio discovers the supported
sessions inside that directory, and the user can inspect one session or compare
two sessions without restarting the process.

The product hierarchy is `Workspace -> Sessions -> Session detail / Compare ->
Session artifacts`. CLI arguments may preload data for compatibility and
automation, but they do not own the interactive workflow or determine whether a
surface exists.

## Decisions

- **D-1: the Web workspace is the root aggregate.** A selected directory creates
  one replaceable, server-managed workspace session. Session, compare, and
  artifact routes resolve through that workspace.
- **D-2: directory selection stays browser-native.** The browser uses a directory
  picker and sends relative paths plus bounded file bytes. It never claims that
  a browser file picker exposes a portable server-readable absolute path.
- **D-3: adapters own session formats.** The first adapter accepts retained
  Harness Studio `run_*.json` records. Additional Qoder, Codex, Claude, or
  harness-run layouts must be added through a format adapter, not UI branching.
- **D-4: Session Compare is observational.** Comparing two selected sessions
  shows retained status, duration boundary, tool calls, messages, and semantic
  phase differences. It does not emit a winner or reuse the frozen
  `harness-compare` verdict contract without evaluation evidence.
- **D-5: artifacts are session-scoped.** Artifact View is reached from the
  current session and resolves only that session's artifact set. A loose
  artifact directory is a compatibility preload, not the primary information
  architecture.
- **D-6: `better-harness web` is a launcher only.** The future public command
  locates and starts the packaged Studio application. Selecting or switching a
  workspace remains entirely inside the Web UI.

## Acceptance Scenarios

- **AC-1:** Studio starts with no data arguments and presents an enabled
  **Open session folder** action on Overview and Sessions.
- **AC-2:** Choosing a directory creates a same-origin, opaque, bounded import
  session. Relative paths are portable and confined; the active workspace
  changes only after all selected files are accepted and indexed.
- **AC-3:** A directory containing valid retained `run_*.json` records produces
  a newest-first Session list with prompt, status, saved time, and tool-call
  count. Unsupported and malformed files are reported as omitted and do not
  break the workspace.
- **AC-4:** Selecting a Session opens its real retained Session Debugger
  projection. No sample session is substituted when the workspace has data.
- **AC-5:** The user can select exactly two sessions from the current workspace
  and open Compare without supplying an experiment manifest or evidence path.
- **AC-6:** Session Compare names both sessions and shows observed differences
  for status, retained event count, tool-call count, message count, and tool
  sequence. It labels missing evidence and makes no winner claim.
- **AC-7:** Replacing or disconnecting the workspace clears the prior Session,
  Compare, and Artifact selection and removes Studio-owned temporary data. It
  never writes into the source directory.
- **AC-8:** Empty-state UI copy does not instruct the user to restart with
  `--inspector`, `--evidence`, `--harness`, or `--artifacts` for browsing and
  comparing retained sessions.
- **AC-9:** Workspace and Session navigation remain keyboard usable with no
  document-level horizontal overflow at 1440x900, 1024x768, and 390x844.
- **AC-10:** The root CLI contract can later expose `better-harness web` as a
  workflow command that starts the same empty Studio server; it does not add
  directory-selection flags to the primary Web workflow.

## Non-goals

- Treating observational Session Compare as an experiment verdict.
- Uploading an entire repository or agent home without a bounded adapter plan.
- Supporting every host transcript layout in the first adapter.
- Editing, replaying, or writing back into imported sessions.
- Shipping the public `better-harness web` package boundary in this first UI
  migration; the server and packaged-app ownership must be resolved first.

## Plan and Tasks

### 1. Introduce the workspace session contract

Add bounded create/upload/commit/disconnect routes. Preserve relative paths in
a confined temporary root, index supported records through a format adapter,
and make the committed workspace the dynamic owner for Session routes.

### 2. Make Sessions the primary observed-data surface

Replace startup-flag-driven empty states with an Open session folder action,
render the committed Session catalog, and open real retained Session Debugger
data from the selected row.

### 3. Add observational Session Compare

Allow two Session selections, derive a compact comparison model from retained
records, and render a docked two-session comparison without a winner verdict.
Keep frozen harness-compare evidence as a separate surface.

### 4. Scope Artifact View below Session

Resolve artifacts from the selected Session workspace when the adapter exposes
them. Until then, show an honest session-scoped empty state rather than a loose
global artifact picker.

### 5. Prepare the launcher boundary

Keep Studio's server start independent of data arguments. In a follow-up,
package the built Studio runtime so the root command registry can dispatch
`better-harness web` without repository-only paths.

## Test and Review Evidence

Implementation evidence captured on 2026-08-20:

- `npm test` in `packages/harness-studio`: 17 files, 115 tests passed.
- `npm run test:browser` in `packages/harness-studio`: 15 Playwright tests
  passed, including the folder-to-Session-to-Compare flow and the provisioned
  PPTX viewer regression.
- `npx vitest run test/skills-docs/doc-link-graph.test.mjs`: 6 tests passed
  after regenerating `docs/better-harness-doc-links.mmd`.
- Wide, compact, and narrow screenshots were captured for workspace intake,
  Session browsing, and Session Compare with browser console/page-error and
  horizontal-overflow assertions.

- AC-1/AC-8: empty-start model and Playwright assertions for UI copy and actions.
- AC-2/AC-3/AC-7: HTTP tests for transactionality, traversal, limits,
  replacement, disconnect, malformed files, and source immutability.
- AC-4: browser test that selects a retained session and verifies its prompt and
  real tool-call projection.
- AC-5/AC-6: model and browser tests selecting two sessions and rendering an
  observational comparison with no winner language.
- AC-9: Playwright screenshots, keyboard focus, horizontal overflow, browser
  console, and page-error checks at all three required widths.
- AC-10: CLI inventory/dispatch tests belong to the packaging follow-up.

### Risks

- Directory pickers expose relative paths and bytes, not portable absolute
  paths. The UI must not imply direct filesystem mounting.
- Session records may contain sensitive prompts or tool output. Imports remain
  loopback-only, temporary, bounded, and never leave the local server.
- Host transcript formats differ substantially. UI inference would create false
  compatibility; adapter detection must fail closed with omission reasons.
- Large histories can exhaust browser or server memory. The first slice limits
  files, per-file bytes, aggregate bytes, depth, and accepted record count.
