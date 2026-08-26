# Simple live ACP comparison

## Traceability

- Spec ID: studio-simple-acp-compare
- Status: Implemented

## Intent

Make Compare understandable as one task: choose the currently bound project,
write one user prompt, run two configured AI lanes, and watch both message
streams. Preserve the existing checkpoint, trace, and verdict evidence as an
advanced view without letting it compete with the primary flow.

## Acceptance Scenarios

- AC-1: Opening Compare shows one project control, one editable user Prompt,
  the two configured AI lanes, and one primary Run action without requiring a
  Builder or workbench-opening step.
- AC-2: The exact submitted Prompt is passed to every fresh lane, retained in
  the experiment output, and used for the compare-set Prompt hash.
- AC-3: Each lane streams assistant text, tool activity, run state, errors, and
  permission requests as the run progresses; raw provider payloads do not cross
  the browser boundary.
- AC-4: The project control names the checkpoint-bound project honestly. It
  does not imply arbitrary workspace rebinding when only one project is
  available.
- AC-5: Checkpoints, protocol counts, traces, and verdict tables remain
  available through one secondary Advanced evidence action and retain existing
  evidence-sufficiency semantics.
- AC-6: The default surface has visible keyboard focus, no document-level
  horizontal overflow, and keeps Prompt plus Run visible at wide, compact, and
  narrow layouts without browser console or page errors.

## Non-goals

- Add arbitrary filesystem or remote-project discovery.
- Change the configured lane count, models, ACP Agent command, grader, or
  checkpoint materialization contract from the browser.
- Replace evidence-sufficiency rules with a conversational judgement.
- Remove the existing evidence workbench or checkpoint history adapter.

## Plan and Tasks

- Add a small default Compare surface owned by `ExperimentView` and retain the
  existing workbench behind progressive disclosure.
- Add a bounded Prompt override to the Studio run endpoint and Harness
  experiment runner, then persist the submitted bytes beside run evidence.
- Project host-neutral message framing into a browser-safe assistant-message
  vocabulary and fold it into lane activity in event order.
- Render the configured lanes as two docked conversation panes with inline ACP
  permission decisions and responsive stacking.
- Update behavior tests and browser checks around the new default path.

## Test and Review Evidence

- AC-2: Harness runner test proves the override reaches both lane executors,
  the retained Prompt bytes match, and the compare-set hash changes with it.
- AC-2/AC-3: Studio server tests prove bounded Prompt validation, runner
  forwarding, assistant-event projection, and provider-payload omission.
- AC-3: comparison-model tests prove assistant deltas and tool calls preserve
  lane activity order.
- AC-1/AC-4/AC-5: component/browser checks prove the default labels and the
  Advanced evidence escape hatch.
- AC-6: Playwright checks at 1440x900, 1024x768, and 390x844; inspect focus,
  overflow, console/page errors, and screenshots.
- Risk: a cosmetic Prompt field would create false evidence. Review the actual
  runner input, persisted bytes, and compare-set hash together.
- Risk: streaming raw ACP frames could expose provider payloads. Keep the
  browser contract allow-listed and test that arbitrary payload fields are
  absent.

Observed locally on 2026-08-26: both real `codex-acp` lanes reached `finished`;
the simple surface retained 9 assistant messages and 9 tool activities with no
browser console warnings or errors. Harness tests passed 172/172, Studio tests
passed 277/277, doc-link tests passed 8/8, and the focused Compare browser
regression passed 2/2 across its responsive layouts.
