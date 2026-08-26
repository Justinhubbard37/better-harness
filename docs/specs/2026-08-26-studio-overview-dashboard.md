# Make Studio Overview an operational home

## Traceability

- Spec ID: studio-overview-dashboard
- Status: Implemented

## Intent

Make Harness Studio's Overview answer what context is active, what work is
available now, and what the user should do next. The page should behave as an
operational dashboard without becoming a card grid or duplicating the primary
navigation.

The current Overview always describes workspace selection when no workspace is
connected, even when the running server cannot discover a workspace. Its
**Open workspace** control then navigates to whichever configured surface wins
an internal priority check instead of opening the native directory chooser.
This change replaces that false affordance with explicit, state-derived copy
and commands.

## Acceptance Scenarios

- **AC-1:** When workspace discovery is available and no workspace is open, the
  existing modal workspace gate remains the only dominant action. Its
  **Choose workspace** command invokes the native picker and the inert Overview
  does not expose a competing action.
- **AC-2:** When workspace discovery is unavailable, Overview never asks the
  user to open a workspace. It describes the configured evidence or execution
  surfaces and, when an interactive destination is available, labels its
  primary command for the destination it actually opens, such as
  **Open Compare**, **Open Debugger**, or **Open Artifacts**.
- **AC-3:** When a workspace is connected, Overview leads with the workspace
  label, renders factual Inputs, Sessions, Artifacts, and repository summaries,
  and lists the newest retained Sessions. Opening a recent Session goes to the
  Sessions workbench; no inferred activity, success, or freshness is shown.
- **AC-4:** Overview no longer renders the eight-row startup-input inventory or
  `ready / partial / foundation` totals. Supporting rows contain only currently
  available work or retained workspace evidence and do not duplicate every
  navigation destination.
- **AC-5:** Wide, compact, and narrow layouts keep the primary context and action
  visible, have no document-level horizontal overflow, preserve keyboard focus,
  and produce no browser console or page errors.
- **AC-6:** Focused model tests prove the three Overview modes and their explicit
  commands. Browser coverage proves the source-only CTA label and destination,
  plus the connected-workspace summary and recent Session behavior.

## Non-goals

- Reorganizing or renaming the primary navigation groups.
- Adding analytics, trend charts, inferred alerts, repository write actions, or
  a new aggregate server endpoint.
- Changing Session, Compare, Inspector, Debugger, Artifact, or customization
  data contracts.
- Editing release notes, version files, or roadmap/status documents.

## Plan and Tasks

1. Add a pure Overview model beside the Studio shell model. Derive mode,
   context, summary facts, primary command, and configured work from the
   existing `StudioConfig` contract.
2. Replace the capability inventory in `App.tsx` with state-specific Overview
   panes. Fetch the existing workspace and Session summaries only after a
   workspace is connected; keep failures local to the supporting pane.
3. Replace the existing Overview CSS with docked summary, recent-Session, and
   available-work rows using only shared tokens. Adapt the layout at the
   existing 1080 px and 760 px boundaries.
4. Add focused model and browser tests without changing feature contracts or
   relying on raw source-pattern assertions.

## Test and Review Evidence

- AC-1/AC-2/AC-4/AC-6: `cd packages/harness-studio && npx vitest run test/studio-shell-model.test.ts`.
- AC-2/AC-3/AC-5/AC-6: focused Playwright Overview scenarios against built
  Studio fixtures at 1440x900, 1024x768, and 390x844.
- AC-1/AC-3: existing workspace server and browser tests remain green.
- AC-5: `npm run typecheck -w @qoder-ai/harness-studio`, built preview visual
  inspection, browser console/page-error inspection, keyboard focus check, and
  screenshots at all three layout modes.
- Risk: Overview can imply data that the server does not retain. Mitigation:
  render only config counts, the existing `/api/workspace` label, and existing
  `/api/sessions` summaries; use neutral unavailable copy when a request fails.
- Risk: a new Overview fetch can race workspace replacement. Mitigation: cancel
  stale effects and key/refetch the view from the existing workspace revision.

### Implementation evidence

- `npm run typecheck -w @qoder-ai/harness-studio` and the package build passed.
- `npm test -w @qoder-ai/harness-studio` passed 46 files / 280 tests.
- `npx playwright test test/browser/overview.spec.mjs` passed both focused
  scenarios, including three screenshots and zero document overflow at
  1440x900, 1024x768, and 390x844.
- Live inspection of `http://127.0.0.1:3311/#/overview` showed
  **Comparison setup is ready**, **Open Compare**, and no console warnings or
  errors; the command opened `#/compare`.
- The full Studio browser run passed 40 of 42 scenarios. The two failures are
  in the concurrently modified Simple Compare flow: existing assertions still
  seek the removed **Lock and compare** setup and the prior Evidence results
  navigation timing. Neither failure touches the new Overview spec or test.
- The documentation link graph passed 8 tests after regeneration, and
  `git diff --check` passed.
