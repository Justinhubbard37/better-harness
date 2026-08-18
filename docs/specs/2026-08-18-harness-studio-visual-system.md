# Harness Studio visual system

## Traceability

- Spec ID: `2026-08-18-harness-studio-visual-system`
- Status: Draft

## Intent

Harness Studio has grown Bench, Live trial, and Evidence results as independently
dense surfaces. The current implementation contains useful evidence semantics,
but visual hierarchy is inconsistent: navigation and status repeat, small type
and broad readability overrides flatten semantic roles, nested borders compete
with the current task, and some constrained regions truncate or fracture
decision copy.

Establish [the root visual contract](../../DESIGN.md) as the target source of
truth, then migrate Studio without changing evidence meaning, runtime behavior,
or product capability claims. A user should identify the surface's primary
question, current state, and next action before reading supporting metadata.

## Acceptance Scenarios

- **AC-1 (one visual authority):** root `DESIGN.md` defines semantic colors,
  typography, spacing, radius, component roles, layout modes, accessibility,
  and do/don't rules; `AGENTS.md` routes UI work to it without duplicating the
  complete contract.
- **AC-2 (stable hierarchy):** Bench, Live trial, and Evidence results each
  render one page-level context, one primary state/task, and at most one dominant
  action. Sibling-surface navigation appears once per viewport and repeated
  status copy is removed unless it enables a distinct action.
- **AC-3 (readable type):** shipped UI uses the documented system font stack,
  keeps meaningful text at or above 12px/16px, and applies semantic typography
  roles without a global `!important` selector flattening `strong`, code,
  buttons, labels, and body text to one size.
- **AC-4 (bounded density):** the central work surface retains visual priority;
  secondary trees and inspectors collapse before content fractures. No prose or
  state summary collapses into character-wide columns, and wide data scrolls in
  a labelled bounded region without increasing document width.
- **AC-5 (decision-first results):** Evidence results leads with verdict,
  evidence sufficiency, quality delta, and cost guardrail before aggregate and
  trial tables. Tables preserve role labels and use aligned numeric columns.
- **AC-6 (semantic and accessible states):** action, selection, success,
  waiting, failure, and Candidate identity use the documented semantic roles,
  paired with text or icons. Keyboard focus, accessible names, live status, and
  reduced-motion behavior are verified.
- **AC-7 (visual evidence):** built Studio passes browser checks at 1440×900,
  1024×768, and 390×844 for non-loading Bench, Live trial, and Evidence results
  states with no page/console errors or document-level horizontal overflow.

## Non-goals

- Changing experiment, checkpoint, trace, runtime, verdict, or evidence
  semantics.
- Adding unsupported Harness, Task Suite, Registry, replay, promotion, or remote
  collaboration capability.
- Replacing Phosphor icons, adding dark mode, or introducing a third-party
  component framework during the first migration.
- Claiming WCAG conformance from screenshots alone.
- Rewriting every Studio component in one change.

## Plan and Tasks

1. Land the root design contract and the short `AGENTS.md` routing rules.
2. Extract shared semantic tokens and typography from the inline application
   document into owned Studio styles; remove the unbundled `Inter` assumption
   and broad readability override.
3. Fix shell ownership so experiment surface navigation renders once, then
   normalize page headers and primary actions across the three surfaces.
4. Recompose Bench around setup → run → outcome, keeping checkpoint and trace
   details secondary and preventing fractured comparison copy.
5. Recompose Live trial around the active event stream, with collapsible
   execution/state panes and one clear explanation for unavailable controls.
6. Add a decision summary to Evidence results and normalize table alignment,
   overflow, and hierarchy.
7. Verify accessibility behavior and capture the three layout modes before
   marking this spec Implemented.

## Test and Review Evidence

- **AC-1:** `npx -p @google/design.md designmd lint DESIGN.md`; review the root
  `AGENTS.md` link and run the document link graph test.
- **AC-2/AC-5:** Playwright assertions target semantic landmarks, current
  navigation, primary actions, verdict summary fields, and duplicate controls by
  role rather than matching component source text.
- **AC-3:** browser computed-style checks on representative body, metadata,
  label, heading, code, and action elements on macOS/Linux CI; Windows remains a
  required code-path review and CI target where browser infrastructure permits.
- **AC-4/AC-7:** built-page measurements at 1440×900, 1024×768, and 390×844;
  inspect document and bounded-region widths and save screenshots for all three
  Studio surfaces.
- **AC-6:** keyboard traversal, visible focus, accessible-name checks, state
  text/icon assertions, live-region inspection, and `prefers-reduced-motion`
  verification.
- **Risk:** a visual refactor can accidentally change evidence meaning.
  Mitigation: preserve view models and state contracts; review copy/status
  changes against existing specs and focused model tests.
- **Risk:** token extraction can create a large mixed diff. Mitigation: migrate
  shell/type foundations first, then one complete surface per reviewable change.
- **Risk:** increasing type size can reduce data density. Mitigation: collapse
  secondary panes, reduce decorative labels and borders, and use bounded virtual
  lists before reducing the typography floor.
