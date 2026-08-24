# Stop disconnected Git branches from sharing a visible lane

## Traceability

- Spec ID: studio-git-history-disconnected-branch-lanes
- Status: Implemented

## Intent

Make the Harness Studio commit graph distinguish a newly encountered branch
head from a commit already tracked by the preceding row. Independent branch
heads may reuse the same horizontal lane for compactness, but the graph must not
draw an incoming line that implies those heads belong to one continuous branch.

## Acceptance Scenarios

- **AC-1:** A newly encountered branch head has no incoming segment from the
  preceding row, while its node and outgoing edge to its parent remain visible.
- **AC-2:** A commit already tracked as a parent of a preceding row retains its
  incoming segment, including across paginated history loaded with cursor lanes.
- **AC-3:** Several independent branch heads with the same parent may reuse one
  lane without appearing as a continuous vertical branch.
- **AC-4:** The Commit history surface remains usable at wide, compact, and
  narrow widths, with no new console/page errors or document-level horizontal
  overflow.

## Non-goals

- Changing Git ref discovery, commit ordering, pagination limits, or colors.
- Changing the refs tree, commit selection, details, patches, or search.
- Replacing the compact lane allocator with a full Git topology renderer.

## Plan and Tasks

1. Define `activeLanes` as lanes entering the current row before any newly
   encountered branch head is allocated.
2. Add focused layout tests for disconnected heads, normal parent continuation,
   and paginated cursor continuation.
3. Run focused and package tests, then inspect the live Commit history surface
   in Chrome at wide, compact, and narrow widths.

## Test and Review Evidence

- AC-1/AC-2/AC-3: focused `layoutCommitGraphPage` behavior tests.
- AC-4: Chrome screenshots at 1440x900, 1024x768, and 390x844; document overflow,
  console errors, and page errors checked at each width.
- Regression gates: Harness Studio package tests, Git history browser test, and
  `git diff --check`.
- Risk: incorrect cursor-lane handling can introduce a false break at page
  boundaries, so the continuation test must begin with an explicit incoming
  lane rather than relying only on a single unpaged fixture.

Implementation evidence (2026-08-24):

- `npm test -w @qoder-ai/harness-studio -- --run test/git-history.test.ts`:
  1 file and 8 tests passed, including disconnected heads, normal parent
  continuation, and cursor-lane continuation.
- `npm test -w @qoder-ai/harness-studio`: 43 files and 265 tests passed.
- `npm run test:browser -w @qoder-ai/harness-studio -- git-history.spec.mjs`:
  the Git history Playwright flow passed.
- Chrome visual review of the real Better Harness history at 1440x900,
  1024x768, and 390x844 confirmed isolated branch heads, a continuous real
  parent lane, no document-level horizontal overflow, visible keyboard focus,
  and no console errors. Screenshots were retained under `/tmp` as
  `better-harness-git-lane-{wide,compact,narrow}.png`.
- `npx vitest run test/skills-docs/doc-link-graph.test.mjs`: 8 tests passed
  after regenerating the routing graph; `git diff --check` passed.
