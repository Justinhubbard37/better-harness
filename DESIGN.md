---
version: alpha
name: Better Harness Studio
description: Visual design contract for Studio, interactive reports, and other Better Harness product surfaces.
colors:
  primary: "#245CC8"
  primary-hover: "#1D4FAF"
  primary-soft: "#EEF4FF"
  on-primary: "#FFFFFF"
  text: "#263244"
  text-muted: "#5F6D82"
  text-subtle: "#667085"
  canvas: "#F4F6F8"
  titlebar: "#F4F6F8"
  sidebar: "#F8FAFC"
  workspace: "#FFFFFF"
  panel: "#FFFFFF"
  surface: "#FFFFFF"
  surface-subtle: "#F8FAFC"
  surface-hover: "#EEF1F5"
  surface-selected: "#E7EFFB"
  border: "#D7DEE8"
  border-strong: "#B8C3D1"
  focus: "#1769D2"
  success: "#16794E"
  success-surface: "#E9F7F0"
  warning: "#8A520F"
  warning-surface: "#FFF3DF"
  danger: "#A63D45"
  danger-surface: "#FDEBED"
  candidate: "#6D46B5"
  candidate-surface: "#F5F1FB"

typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 40px
    letterSpacing: -0.6px
  page-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.2px
  section-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 26px
    letterSpacing: 0px
  pane-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0px
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0px
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 18px
    letterSpacing: 0px
  metadata:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0px
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0px

rounded:
  none: 0px
  xs: 2px
  sm: 3px
  md: 4px
  lg: 6px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  xxxl: 48px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "{spacing.xs} {spacing.md}"
    height: 30px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "{spacing.xs} {spacing.md}"
    height: 30px
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
  segmented-control:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0"
    height: 30px
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "{spacing.xs} {spacing.sm}"
    height: 30px
  status-inline:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.metadata}"
    rounded: "{rounded.none}"
    padding: "0"
  data-table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm} {spacing.md}"
  pane-header:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.pane-title}"
    rounded: "{rounded.none}"
    padding: "0 {spacing.sm}"
    height: 32px
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.xs} {spacing.sm}"
    minHeight: 28px
  list-row-selected:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.text}"
  focus-indicator:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.xs}"
    width: 2px
  application-canvas:
    backgroundColor: "{colors.workspace}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  navigation-selected:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "{spacing.xs} {spacing.sm}"
  helper-text:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-subtle}"
    typography: "{typography.metadata}"
    rounded: "{rounded.xs}"
    padding: "{spacing.xs} {spacing.sm}"
  divider:
    backgroundColor: "{colors.border}"
    textColor: "{colors.text}"
    height: 1px
  control-outline:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    width: 1px
  status-success:
    backgroundColor: "transparent"
    textColor: "{colors.success}"
    typography: "{typography.metadata}"
    rounded: "{rounded.none}"
    padding: "0"
  status-warning:
    backgroundColor: "transparent"
    textColor: "{colors.warning}"
    typography: "{typography.metadata}"
    rounded: "{rounded.none}"
    padding: "0"
  status-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.metadata}"
    rounded: "{rounded.none}"
    padding: "0"
  candidate-lane:
    backgroundColor: "{colors.candidate-surface}"
    textColor: "{colors.candidate}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "{spacing.xs} {spacing.sm}"
---

# Better Harness Studio

## Overview

Better Harness Studio is a technical evidence workbench. It should feel like a
calm, precise control room: the current decision and next action are obvious,
while traces, checkpoints, costs, and runtime metadata remain available without
competing for attention.

This file is the visual source of truth for `packages/harness-studio` and for
interactive Better Harness reports that do not have a narrower approved design
contract. Product semantics and information architecture remain owned by the
relevant spec and implementation. This contract governs hierarchy, typography,
color, density, component appearance, interaction states, and visual review.

The current code predates this contract. Treat values in this file as the
migration target, not as proof that every existing surface is already aligned.

## Reference model: a docked VS Code workbench

Use the structure of the classic, docked VS Code workbench as the reference:
an application title bar, a primary sidebar, one main editor/workspace, an
optional secondary sidebar or bottom panel, and a status bar. These are
edge-to-edge regions separated by 1px rules or resize sashes, not cards placed
on a page canvas.

This is a structural reference, not a request to copy VS Code branding or every
current experiment. VS Code's source now also contains optional floating-panel
and shadow treatments. Better Harness deliberately follows the docked,
no-shadow branch: fixed work regions stay flat; elevation is reserved for
transient UI that actually floats above them.

Primary references:

- [VS Code user interface](https://code.visualstudio.com/docs/editing/userinterface)
- [VS Code UX Guidelines: containers and items](https://code.visualstudio.com/api/ux-guidelines/overview)
- [VS Code theme color roles](https://code.visualstudio.com/api/references/theme-color)
- [VS Code workbench layout source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/layout.ts)
- [VS Code accessibility and keyboard navigation](https://code.visualstudio.com/docs/configure/accessibility/accessibility)

## Product character

- Prefer restrained, technical, and legible over decorative, playful, or
  dashboard-like.
- Prefer panes, rows, tabs, toolbars, and editor views over cards. A card is an
  exception for an independent object that must move, compare, or stand alone;
  it is never the default content wrapper.
- Let evidence carry the visual interest. Chrome and containers should stay
  neutral so status, diffs, and comparison lanes remain meaningful.
- Use ordinary product language. Avoid invented scientific language, excessive
  all-caps labels, and decorative jargon.
- Use Phosphor icons already owned by Studio. Do not use emoji, text glyphs, or
  improvised SVGs as interface icons.

## Information hierarchy

Every surface must answer one primary question:

- **Bench:** what is held constant, what changes, and is the comparison ready?
- **Live trial:** what is happening now, what needs attention, and where is the
  active evidence?
- **Evidence results:** what is the verdict, is the evidence sufficient, and
  what trade-off produced it?

Structure each surface in this order:

1. Page context and one sentence describing the decision.
2. The primary state or task, with at most one visually dominant action.
3. Supporting evidence, controls, and metadata.

Show a surface switcher once per viewport. Do not repeat Bench / Live trial /
Evidence results navigation in both the application shell and the page body.
Do not repeat the same run status in a banner, row, sidebar, and footer unless
each occurrence enables a different action.

Use progressive disclosure for runtime detail. The central work area is primary;
execution trees, checkpoint lists, and state inspectors are secondary panes that
may collapse or become drawers. An empty or unavailable secondary pane must not
occupy more attention than the active task.

## Typography

- Use the documented system UI stack across macOS, Windows, and Linux. `Inter`
  is not part of the stack unless the font files are deliberately bundled and
  tested on every supported platform.
- Use monospace only for code, hashes, identifiers, paths, timestamps where
  alignment matters, and numeric trace data. Product copy and navigation stay
  in the UI font.
- Do not render meaningful text below `metadata` (12/16). Dense mode reduces
  spacing before it reduces type size.
- Body copy is regular weight. Labels and section headings are semibold. Reserve
  bold weight for the verdict, one primary action, or a genuinely exceptional
  state; do not make every `strong`, button, and navigation item bold.
- Use sentence case. Uppercase is allowed only for short eyebrows or compact
  machine-state badges, never for ordinary section titles or paragraphs.
- Do not use a global `!important` rule to force one size onto paragraphs,
  labels, buttons, code, and `strong` elements. Each semantic role owns its
  documented type token.

## Color

- Blue is the interaction color: primary actions, selected navigation, links,
  and keyboard focus.
- Green, amber, and red are semantic state colors for success, caution/waiting,
  and failure. Pair every colored state with text or an icon; color is never the
  only signal.
- Violet identifies the Candidate comparison lane. It is not a second primary
  action color.
- Use neutral borders and surface shifts for structure. Do not assign a new hue
  merely to distinguish another panel or hierarchy level.
- Text and controls must meet WCAG 2.2 AA contrast against their actual surface.
  Muted text is supporting content, not a way to hide essential information.

## Spacing, shape, and depth

- Use the spacing scale. Related items are separated by `sm` or `md`; component
  padding uses `md` or `lg`; major regions use `xl` or more.
- Docked regions meet edge to edge. Separate the title bar, sidebars, workspace,
  panels, rows, and sections with a background shift, a 1px divider, or a resize
  sash; do not place gutters around them to make them look like floating cards.
- Docked panes, tables, list regions, and editor groups use `rounded.none`.
  Controls use `xs` or `sm`. `md` and `lg` are reserved for floating dialogs,
  menus, quick picks, notifications, or exceptional standalone objects.
- Shadows are forbidden on docked panes, rows, buttons, tabs, tables, empty
  states, and ordinary content groups. A shadow may only communicate a
  transient overlay above the workbench; it must disappear with that overlay.
- `full` radius is limited to a numeric count or circular target. Status text,
  evidence roles, filters, and navigation do not become pills by default.
- Compact desktop text controls are 30px high and toolbar targets are at least
  28px square. At narrow or touch-oriented layouts, targets are at least 44px.

## Layout and density

- Wide mode is above 1080px, compact mode is 760–1080px, and narrow mode is
  below 760px. These modes follow the existing Studio layout boundaries and
  may be revised only with browser evidence at all three widths.
- Wide workbenches may use three regions, but the central evidence surface must
  retain at least half of the usable width. Side regions must collapse before
  central content becomes unreadable.
- Prefer resizable docked panes with independently scrolling content. Keep the
  active pane title and toolbar visible; do not make the whole page a tall stack
  of repeated session containers.
- Never allow a paragraph to collapse into one-word or character-wide columns.
  Define minimum content widths, wrap at phrase boundaries, or make the bounded
  data region scroll horizontally.
- Use comfortable density for setup, summaries, and empty states. Dense rows
  are reserved for traces, call trees, diffs, and data tables; they still honor
  the typography floor and target-size rules.
- Avoid fixed viewport-height layouts when they strand large empty regions or
  hide the decision below the fold. Prefer local scrolling only for panes whose
  headers and context remain visible.

## Components

### Navigation

- The product rail owns top-level tools. The primary sidebar lists objects in
  the active tool. Tabs own open views of those objects in the workspace. These
  levels must not duplicate one another.
- A segmented control is only for a small, mutually exclusive property switch;
  it is not top-level navigation and should not sit inside a pill-shaped shell.
- Selection uses a filled or soft-blue state plus an `aria-current` or selected
  semantic. Availability uses a labelled status, not a colored dot alone.
- Date scope uses a compact calendar grid with weekday alignment, a visible
  month and time zone, and one active date. Follow meeting-calendar conventions:
  keep date cells numeric, mark activity with a subtle dot, and show explicit
  session and commit counts for the active day below the grid. Do not compress
  counts into unexplained abbreviations such as `2s` or `9c`.

### Actions and forms

- One primary action per task region. Secondary actions use neutral styling;
  destructive actions use the danger role and require clear copy.
- Put workspace-wide actions in the title bar, view-wide actions in the pane
  toolbar, and item actions on the row or in its context menu. Do not repeat one
  command at all three levels.
- Show no more than three view-toolbar actions and two inline row actions. Put
  less frequent commands in an overflow or context menu and keep their labels
  and enablement consistent everywhere.
- Disabled controls explain the prerequisite near the control. If an entire
  control group is unavailable, show the prerequisite once instead of a wide
  banner plus multiple disabled buttons.
- Icon-only controls require an accessible name and a visible tooltip on hover
  or focus when the icon is not universally understood.

### Panels, inspectors, and empty states

- A pane has one compact title bar: one view name, optional count or state, and
  its scoped actions. It does not also need a card title, eyebrow, subtitle,
  badge, timestamp, and repeated object type.
- A list row has one primary label, at most one short description, and one
  trailing metadata/state area. Put shared dates or categories in group headers
  instead of repeating them as a heading inside every row.
- A session list should read as rows in a sidebar or table. Selecting a session
  reveals its detail in the workspace; the detail view owns the full prompt,
  activity, and commit panes. Do not expand a miniature three-column dashboard
  inside every session row.
- In a Session row, put the provider and observed start time before the title;
  they establish source and chronology before prose. In Session Detail, keep
  the top bar to product identity, one-line title, view tabs, and Close. Put
  runtime, model, duration, turns, calls, edits, and token availability in the
  right-hand facts pane instead of repeating them under the title.
- Inspector panes use definition-list alignment for stable facts and expandable
  sections for verbose payloads. Long identifiers use copy affordances and
  middle truncation; prose should wrap normally.
- Harness Inspector does not maintain a global “Selected evidence” state or
  evidence Drawer. Scope navigation, **Open session**, local disclosure, and
  chart inspection own their actions directly; clicking passive labels or rows
  must not create a second hidden selection model.
- Harness Inspector is a read-only evidence viewer, not a session-resumption
  surface. Do not generate or expose a continuation packet from Session Detail.
- Empty states name what is missing, why it matters, and the single next action.
  They should not look like completed results.

### Tables and comparison lanes

- Lead Evidence results with a decision summary: verdict, evidence sufficiency,
  quality delta, and cost guardrail. Raw aggregate and trial tables are the
  supporting layer.
- Keep labels left-aligned and numeric columns right-aligned with tabular
  numerals. Freeze the header in locally scrolling tables when rows exceed the
  visible region.
- Reference, Baseline, and Candidate are evidence roles, not generic container
  colors. Use role labels in addition to blue/violet accents.
- Truncation must preserve the distinguishing suffix or offer the full value on
  focus/hover. Never let status copy or summary prose break into vertical words.

## Interaction model

### Selection, opening, and disclosure

- Single click selects a row and updates the adjacent preview/detail pane. It
  must not also expand the row, run a command, or navigate away.
- `Enter` or an explicit **Open** command opens the selected object as a durable
  workspace tab. Double-click may be an accelerator for the same command, but
  it is never the only way to open something.
- A disclosure chevron only expands or collapses its own children. Its hit area
  and accessible name are separate from row selection and from **Open**.
- `Escape` closes the topmost transient surface or clears a temporary mode; it
  must not discard persisted filters, evidence, or edits without confirmation.

### Keyboard and focus

- Every command available by pointer is reachable by keyboard. Use natural Tab
  order between workbench parts; use arrow keys within tab lists, toolbars,
  trees, and listboxes so each composite contributes one Tab stop.
- In lists and trees, Up/Down moves the active row, Left/Right collapses or
  expands hierarchy when present, `Enter` opens, and Space toggles a checkbox or
  explicit selection control. Do not overload Space on ordinary navigation rows.
- Every interactive element has a visible `:focus-visible` treatment using the
  focus token. Focus, selection, hover, active, disabled, and unavailable are
  distinct states and cannot be expressed by color alone.

### Commands and contextual actions

- Each user action has one command definition: stable id, verb-first label,
  handler, visibility condition, enablement condition, and optional shortcut.
  Toolbars, row actions, context menus, and a future command palette invoke the
  same command rather than implementing parallel behavior.
- Hide actions that are irrelevant to the current object. Disable an action only
  when seeing it teaches a useful prerequisite, and explain that prerequisite.
- Hover may reveal secondary row actions only if focus reveals the same actions.
  Essential state and the primary next action remain visible without hover.

### Resize, feedback, and motion

- Resize sashes show a hover/focus affordance and remain keyboard operable.
  Persist user-adjusted pane sizes only after the layout is stable across wide,
  compact, and narrow modes.
- Keep layout transitions at 160ms or less. Respect `prefers-reduced-motion` by
  removing non-essential movement and smooth scrolling.
- Announce asynchronous run, pause, error, and verdict changes through the
  appropriate live-region semantics; visual color changes alone are not enough.

## Implementation alignment

- Project tokens must be exposed as shared CSS custom properties before adding
  new visual variants. Surface-specific aliases may reference the shared roles;
  they must not fork a second palette or type scale.
- Keep component CSS out of `index.html` as the system is migrated. Split tokens,
  shell primitives, and feature styles into owned files or modules so visual
  rules have an inspectable source.
- Do not add one-off hex colors, font sizes, weights, radii, or shadows when an
  existing token expresses the role. Add or revise a token here only when a new
  semantic role is genuinely required.
- Loading, empty, error, partial, running, paused, completed, and unavailable
  states must be visually and textually distinct without inventing product
  semantics absent from runtime evidence.

## Accessibility and visual review

- Review wide (1440×900), compact (1024×768), and narrow (390×844) layouts.
  At each width, confirm the primary question and action are visible, the page
  has no document-level horizontal overflow, and bounded tables/diffs remain
  usable.
- Check keyboard order, focus visibility, landmark and heading order, accessible
  control names, state announcements, 200% zoom/reflow, and reduced motion.
- For visual changes, use Playwright against the built preview, inspect browser
  console and page errors, and save screenshots of Bench, Live trial, and
  Evidence results in meaningful non-loading states.

## Do and do not

**Do**

- Make the verdict, active run, or setup decision the first thing users see.
- Use a restrained neutral canvas and reserve color for action, state, and
  evidence identity.
- Build the shell from docked regions and the content from rows or editor views.
- Make selection, opening, disclosure, and commands visibly distinct.
- Let users collapse secondary evidence while preserving the current scope.
- Prefer fewer, stronger labels and larger readable type over dense decoration.

**Do not**

- Duplicate navigation or status merely to fill a header.
- Use a card grid as the default information architecture, or give every object
  its own rounded title block and embedded dashboard.
- Make the whole row, its chevron, and its **Open** action perform the same or
  overlapping behavior.
- Use 7–9px prototype text, broad `!important` readability overrides, or an
  unbundled font name.
- Give every nested region a border, radius, shadow, badge, and uppercase label.
- Present a plain data dump as a decision screen or a decorative dashboard as
  evidence.
