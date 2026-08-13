# Make test failures concise and directly actionable

## Traceability

- Spec ID: test-ci-diagnostics
- Status: Implemented

## Intent

Keep the dependency-free `node:test` suite while making GitHub Actions failures
easy to locate. Replace the unbounded default TAP stream with capability groups,
compact progress, file-and-line annotations, a job summary, and downloadable
JUnit results. Continue removing assertions that merely freeze private HTML/CSS
spelling when an executable validator already owns the behavior.

## Acceptance Scenarios

- AC-1: CI runs every discovered capability directory, continues after one
  category fails, and exits non-zero after reporting all failed categories.
- AC-2: Passing tests use compact console output; a failing test emits a GitHub
  annotation containing its name, repository-relative file, line, and useful
  error detail.
- AC-3: Every CI matrix job writes one JUnit XML result per capability and
  uploads the files even when tests fail.
- AC-4: GitHub's step summary lists category status, test-file count, and
  duration without requiring a third-party test framework or reporter action.
- AC-5: Local `npm test` remains the direct full-suite command, while
  `npm run test:ci` owns CI-only presentation and artifacts.
- AC-6: Remaining report renderer and task-loop projection tests retain data
  contracts, escaping, accessibility, validator failures, and self-contained
  artifact boundaries but stop pinning private CSS dimensions and redundant
  visible-copy spelling.

## Non-goals

- Migrating the existing suite to Vitest or Jest without a missing capability
  that Node 22 cannot provide.
- Publishing test infrastructure in the npm package.
- Adding coverage percentage gates or changing product behavior.
- Editing the concurrently modified Inspector and commit-session test slices.

## Plan and Tasks

1. Add test-only CI infrastructure under `test/support`: discover capability
   directories, run them sequentially with compact GitHub and JUnit reporters,
   and aggregate failures.
2. Add focused behavior tests for discovery, annotation escaping, and a real
   failing child test.
3. Use the CI runner in `.github/workflows/ci.yml` and upload `test-results` on
   every matrix job.
4. Remove renderer and task-loop projection assertions that duplicate
   validators or freeze layout/copy literals, leaving independent semantic and
   security oracles intact.
5. Verify focused tests, a successful CI-mode run, the full local suite, package
   contents, and staged/unstaged boundaries.

## Test and Review Evidence

- AC-1..AC-4: the CI reporting behavior tests pass 4/4 on local Node 24 and
  exact CI runtime Node 22.20.0, including a real failed-first/success-second
  capability run. `npm run test:ci` passes all 8 capability groups and writes 8
  JUnit XML files.
- AC-5: `npm test` passes 1,308/1,308.
- AC-6: the renderer tests pass 33/33 and the task-loop projection tests pass
  84/84. These files contain 60 fewer regex assertions: 48 private HTML/CSS or
  visible-copy checks and 12 redundant Markdown spelling checks.
- Documentation: the focused doc-link graph suite passes 6/6 after regenerating
  the canonical graph.
- Package: `npm run pack:verify` passes with 507 npm entries and 529 runtime zip
  entries. `git diff --check` is clean.
- Risk: concurrent full-suite runs can exhaust Git fixture resources and create
  unrelated timeout failures. Run final suites serially and distinguish an
  environment timeout from an assertion regression.
