# Develop Harness Studio with live reload

## Traceability

- Spec ID: studio-development-live-reload
- Status: Implemented

## Intent

Give Studio contributors one repository-owned development command that starts
the real local Studio server and shortens the browser feedback loop. Successful
frontend source rebuilds should refresh the open page automatically, while a
temporary build error should leave the server available and recover after the
source is corrected.

## Acceptance Scenarios

- **AC-1:** Running `npm run harness-studio:dev` from the repository root builds
  the Studio server and browser application, starts the existing loopback local
  workspace launcher with Session discovery, prints its URL, and forwards its
  launcher arguments supplied after `--`.
- **AC-2:** Changing a Studio browser dependency, stylesheet, or HTML entrypoint
  triggers an incremental rebuild and automatically reloads an open Studio page
  only after that rebuild succeeds.
- **AC-3:** A failed browser rebuild reports the error without publishing a new
  reload revision or stopping the Studio server; a later valid edit rebuilds and
  reloads normally.
- **AC-4:** Production `build`, package contents, and the Studio HTTP/API surface
  remain unchanged; live-reload code exists only in development output.
- **AC-5:** The development watcher and child-process orchestration use Node APIs
  and argv arrays and can run on Windows, macOS, and Linux.

## Non-goals

- React state-preserving HMR or Fast Refresh.
- Automatic recompilation or restart for Studio server source changes.
- Replacing the existing esbuild-wasm production bundle with Vite or another
  development-server dependency.
- Changing artifact-directory live updates or any public Studio endpoint.
- Expanding the packaged generic CLI with repository-local Session providers.

## Plan and Tasks

1. Extract the shared Studio browser/runtime build configuration so production
   and development builds cannot silently diverge.
2. Add a development orchestrator that performs the initial server build,
   incrementally rebuilds browser dependencies and static assets, starts the
   existing CLI with forwarded argv, and cleans up watchers and the child process.
3. Inject a development-only reload poller and revision asset into the copied
   `index.html`; advance the revision only after a successful build.
4. Add root/package scripts, concise contributor documentation, and focused
   behavior tests for injection, revision publication, argument forwarding, and
   recovery semantics.

## Test and Review Evidence

- **AC-1/AC-5:** focused tests for workspace-launcher argv forwarding plus a
  real `npm run harness-studio:dev -- --port 0` process lifecycle smoke; verify
  `/api/config` reports
  `workspaceDiscoveryEnabled: true`.
- **AC-2/AC-3:** focused build-controller tests plus a browser smoke that edits
  and restores a Studio static source, observes the revision advance and page
  reload, then checks browser console and page errors.
- **AC-4:** `npm run harness-studio:build`, package tests, and inspection of the
  production `dist/app/index.html` for absence of the development reload client.
- Review the final staged/local diff with the change-traceability Review
  Readiness Check, including generated-output and staged/unstaged boundaries.
- Main risks: duplicate or missed filesystem events, reload publication after a
  failed build, orphaned server processes, and platform-specific signal or path
  handling.

### Implementation evidence — 2026-08-24

- `npm run harness-studio:dev -- --port 0` started the repository workspace
  launcher with `workspaceDiscoveryEnabled: true`; interrupting it closed the
  loopback server cleanly.
- Browser smoke observed the page title change and return without a manual
  refresh, kept `Choose workspace` enabled, reported no console/page errors, and
  did not show the generic-launcher discovery error.
- An intentional temporary TSX syntax error left `/api/config` available with
  HTTP 200 and kept reload revision 4; restoring the source published revision
  5 and resumed automatic reload.
- `npm run harness-studio:test` passed 42 files and 259 tests. The full
  `npm run harness-studio:test:browser` suite passed 40 tests.
- Production `npm run harness-studio:build` succeeded and its generated
  `dist/app/index.html` contained no development reload client. The focused
  development build tests passed 4 tests, and the doc-link graph passed 8 tests.
