# Resource-oriented ACP comparison

## Traceability

- Spec ID: studio-acp-resource-compare
- Status: Implemented

## Intent

Make a completed or running ACP comparison explain which project resources each
AI inspected, changed, or verified. Keep the simple project-and-Prompt entry
surface, but replace manual cross-reading of two transcripts with one
resource-oriented comparison that retains the originating tool calls and their
recorded results.

## Acceptance Scenarios

- AC-1: A canonical ACP tool call with multiple `parsed_cmd` entries projects
  into multiple observable operations without pretending that each operation
  was a separate provider call.
- AC-2: Reads, searches, edits, listings, verification commands, and generic
  commands are associated with normalized resource keys when the recorded input
  or result supplies one; trial-root absolute paths are not rendered in the UI.
- AC-3: Compare can show one row per resource with Baseline and Candidate
  operations aligned around that shared resource, including run-only resources
  and multiple operations from one call.
- AC-4: Selecting an operation exposes its recorded status and a bounded,
  browser-safe result summary while preserving access to the two original
  message streams.
- AC-5: The resource comparison updates from canonical tool-start and
  tool-result events during a live run and does not infer unobserved reads,
  edits, tests, or intent.
- AC-6: The resource view has visible keyboard focus, labelled controls, no
  document-level horizontal overflow, and a usable bounded horizontal layout at
  1440x900, 1024x768, and 390x844.

## Non-goals

- Build a free-form node graph, infer causal intent, or rank a model from a
  single matched trial.
- Add a new ACP provider payload to the browser contract.
- Replace patch receipts or grader results with tool-call claims.
- Implement an arbitrary repository file browser or editor.

## Plan and Tasks

- Add an operation projection beside the existing single-call normalization.
  Extract nested `parsed_cmd` operations, recorded changes, and narrow
  result-derived diff paths while retaining call identity.
- Reuse that projection in the existing resource ledger so Advanced evidence
  no longer reports zero resources for composite ACP calls.
- Add a default Resource map and a Messages switch to the simple Compare result
  area. Use docked rows and a bounded operation-result inspector rather than
  cards or a free-form graph.
- Add focused model and component/browser coverage, then verify the live page at
  the three Studio layout widths.

## Test and Review Evidence

- AC-1/AC-2: model tests cover a compound list/search/read call, an absolute
  edit path, a diff/status verification call, and result summarization.
- AC-3/AC-4: component/browser tests assert shared resource rows, lane-only
  operations, the Messages fallback, and an accessible operation inspector.
- AC-5: stream-fold tests prove a running call becomes a completed operation
  with the recorded result without changing call identity.
- AC-6: Playwright screenshots and console/page-error inspection at 1440x900,
  1024x768, and 390x844.
- Risk: treating command output as fact can create false reads. Result parsing
  is limited to changed-file/diff evidence and never promotes arbitrary stdout
  paths to reads.
- Risk: compound calls make raw call counts misleading. The UI labels operation
  rows with their parent call sequence instead of comparing operation count as
  a quality score.

Observed locally on 2026-08-26 with Node 24.15.0: Harness tests passed 172/172,
Studio tests passed 283/283, and the focused Compare browser checks passed 2/2.
The real `codex-acp` comparison projected five resources, four shared resources,
one edited resource, and a Candidate-only README verification without exposing
the temporary worktree path. Wide, compact, and narrow screenshots had no
document-level horizontal overflow or browser console/page errors.
