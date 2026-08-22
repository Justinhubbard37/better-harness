# Browse workspace commit history

## Traceability

- Spec ID: studio-commit-view
- Status: Implemented

## Intent

Better Harness Studio organizes evidence around Intent, Session, Commit, and
Artifact. Add a read-only Commit workbench for the currently opened local
workspace so a reviewer can trace Session activity and produced Artifacts back
to repository history without leaving Studio.

The interaction is based on the Git Log panel in `/Users/phodal/ai/routa-js`:

- `git-log-panel.tsx` owns the docked refs, log, and detail layout;
- `refs-tree.tsx` exposes HEAD, local branches, remote branches grouped by
  remote, and tags as reachability filters;
- `commit-list.tsx` exposes a graph, ref labels, summary, author, date, hash,
  selection, and incremental loading;
- `commit-detail-panel.tsx` exposes the full message, author, timestamp,
  parents, changed-file states, and line totals;
- `use-git-log.ts` owns refresh, search debounce, branch-filter state,
  selection, detail loading, and pagination;
- `/api/git/refs`, `/api/git/log`, and `/api/git/commit` provide the real Git
  adapter contract.

Routa's April 2026 incident record also establishes required failure guards:
commit records must not be split by multiline messages, workspace/ref changes
must not create reload loops, and local/remote branch filters must use the same
contract. Better Harness retains those behaviors but binds every Git read to
the server-owned open workspace instead of accepting an arbitrary client path.

## Acceptance Scenarios

- AC-1: When the opened local workspace is a Git repository, Studio navigation
  presents a Commit workbench and identifies the current branch without
  exposing the absolute repository path.
- AC-2: The refs pane lists current HEAD, local branches, remote branches
  grouped by remote, and tags. Selecting any combination filters the log to
  commits reachable from those exact refs; clearing filters restores all refs.
- AC-3: The commit table renders date-ordered history with a stable topology
  graph, ref labels, summary, author, relative date, and short hash. It loads a
  bounded first page and can request later pages without duplicates.
- AC-4: Search matches commit hash, subject, author name, or author email and is
  safe for multiline commit bodies. Empty repositories and zero matches render
  an explicit empty state instead of an indefinite loader.
- AC-5: Selecting a commit renders its full message, immutable author/time/hash
  metadata, parents, changed-file status, rename origin, additions, and
  deletions. Selecting a changed text file renders that commit's patch; binary
  or unavailable patches retain an honest no-diff state.
- AC-6: All Git operations are read-only, workspace-scoped, argv-based, bounded,
  and work on Windows, macOS, and Linux. Invalid refs, revisions, limits, or
  unavailable repositories return stable client errors without leaking the
  workspace's absolute path or raw Git stderr.
- AC-7: The wide layout uses refs, log, and detail panes; compact and narrow
  layouts preserve the log as the primary decision surface and expose refs and
  detail through bounded responsive panes. Keyboard focus, selection semantics,
  overflow, and loading/error states remain usable.
- AC-8: Opening another workspace invalidates Commit state and reloads refs and
  history for the new repository without carrying prior filters or selection.

## Non-goals

- Checking out, creating, renaming, merging, rebasing, resetting, deleting, or
  pushing branches.
- Staging files, editing the working tree, creating commits, or resolving merge
  conflicts.
- Fetching from remotes or claiming that locally cached remote refs are current.
- Multi-repository selection inside one Studio workspace. Studio's existing
  workspace chooser remains the repository boundary.
- Mapping individual Session events to commits without explicit retained
  evidence that establishes that relation.
- Reproducing Routa's Tailwind styling or its simplified two-lane merge graph.

## Plan and Tasks

1. Define a versioned, browser-safe Git history model for refs, paged commits,
   graph edges, commit details, changed files, and per-file patches.
2. Add one capability-owned server module that executes `git` with argv arrays,
   parses NUL/unit-separated records, validates refs and SHAs, applies bounded
   pagination/search, and computes graph lanes from parent topology.
3. Mount workspace-scoped read routes for repository status, refs, log, commit
   detail, and file patch. The server resolves the repository from its own
   selected-workspace state; browser requests never send a filesystem path.
4. Add a Commit destination and workbench to the existing Studio shell. Keep
   the central log primary, use Phosphor icons and shared semantic tokens, and
   preserve current Artifact Preview worktree changes.
5. Add behavior tests for Git parsing, ref filtering, pagination, multiline
   messages, rename/binary stats, invalid input, workspace switching, shell
   availability, and UI-visible model helpers.
6. Run focused type/build/tests, the repository's preview smoke checks, and
   Playwright review at wide, compact, and narrow widths with console/page-error
   inspection and screenshots outside tracked source.

## Test and Review Evidence

- AC-1, AC-6, AC-8: server tests using temporary Git repositories and two
  independently initialized workspaces; assert response shapes, redaction, and
  workspace rebinding.
- AC-2, AC-3, AC-4: Git history unit tests with local branches, a bare remote,
  tags, a merge, multiline bodies, search, and page boundaries.
- AC-5: server/model tests for modified, added, deleted, renamed, and binary
  files plus exact file-patch selection.
- AC-1, AC-7: Studio shell model tests and Playwright navigation, keyboard,
  responsive-overflow, console, and screenshot evidence.
- Focused commands:
  - `npm run build --workspace @qoder-ai/harness-studio`
  - `npm exec --workspace @qoder-ai/harness-studio -- vitest run test/git-history.test.ts test/git-history-server.test.ts test/studio-shell-model.test.ts`
  - `npm exec --workspace @qoder-ai/harness-studio -- playwright test test/browser/git-history.spec.mjs`
  - `npm run preview`, then request `http://localhost:58575/health` and
    `http://localhost:58575/canvas-module.js`
- Risk: Git output is adversarial structured data. Delimiter-safe parsing,
  exact ref allowlisting, bounded buffers/results, revision validation, and
  stderr redaction are required before the route can be considered implemented.
- Risk: the worktree already contains Artifact Preview edits in Studio shell,
  server, CSS, and tests. Review and stage the Commit View paths separately;
  do not treat adjacent changes as this spec's evidence.

## Implementation Evidence

- AC-1 through AC-6 and AC-8: `git-history.test.ts`,
  `git-history-server.test.ts`, and the full Harness Studio Vitest suite pass
  with real temporary Git repositories (`24` files, `148` tests).
- AC-2 through AC-5 and AC-7: `git-history.spec.mjs` passes a real browser flow
  for ref filtering, author search, commit selection, file selection, and patch
  rendering at `1440x960`, `900x760`, and `390x844` with no console or page
  errors. The full Studio Playwright suite passes (`21` tests).
- `npm run typecheck --workspace @qoder-ai/harness-studio` and
  `npm test --workspace @qoder-ai/harness-studio` pass.
- `git diff --check` passes.
- The repository preview smoke command is blocked before startup because this
  checkout has no Canvas SDK runtime configured. `npm run preview` reports
  `Missing Canvas SDK runtime`; therefore `/health` and `/canvas-module.js`
  could not be probed in this environment.
