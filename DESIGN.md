---
version: alpha
name: Better Harness Studio
description: Visual design contract for Studio, interactive reports, and other Better Harness product surfaces.
colors:
  action: "#245CC8"
  action-hover: "#1D4FAF"
  action-soft: "#EEF4FF"
  on-action: "#FFFFFF"
  text: "#263244"
  text-muted: "#5F6D82"
  text-subtle: "#667085"
  canvas: "#F4F6F8"
  surface: "#FFFFFF"
  surface-subtle: "#F8FAFC"
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
    fontWeight: 650
    lineHeight: 40px
    letterSpacing: -0.6px
  page-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 24px
    fontWeight: 650
    lineHeight: 32px
    letterSpacing: -0.2px
  section-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 26px
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
  xs: 4px
  sm: 6px
  md: 10px
  lg: 14px
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
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.lg}"
    height: 36px
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
    textColor: "{colors.on-action}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.lg}"
    height: 36px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  segmented-control:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-muted}"
    borderColor: "{colors.border}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs}"
    height: 40px
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
    height: 36px
  status-badge:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-muted}"
    typography: "{typography.metadata}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs} {spacing.sm}"
  data-table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
  focus-indicator:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.xs}"
    width: 2px
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

## Product character

- Prefer restrained, technical, and legible over decorative, playful, or
  dashboard-like.
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
Do not repeat the same run status in a banner, card, sidebar, and footer unless
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
- Use spacing before borders. A page should normally have at most two visible
  container levels. Avoid full borders around a card nested inside another
  fully bordered card when whitespace or a divider can communicate the group.
- Use `sm` radius for controls, `md` for panels, `lg` only for prominent empty
  states or overview surfaces, and `full` only for badges and circular targets.
- Shadows indicate a floating layer such as a drawer or menu. Do not shadow
  ordinary cards or use elevation to compensate for weak hierarchy.
- A compact desktop control is at least 36px high. At narrow or touch-oriented
  layouts, interactive targets are at least 44px high.

## Layout and density

- Wide mode is above 1080px, compact mode is 760–1080px, and narrow mode is
  below 760px. These modes follow the existing Studio layout boundaries and
  may be revised only with browser evidence at all three widths.
- Wide workbenches may use three regions, but the central evidence surface must
  retain at least half of the usable width. Side regions must collapse before
  central content becomes unreadable.
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

- The product rail owns top-level objects. A segmented control owns sibling
  surfaces within the current object. Tabs own views of the same evidence.
  These are different levels and must not duplicate one another.
- Selection uses a filled or soft-blue state plus an `aria-current` or selected
  semantic. Availability uses a labelled status, not a colored dot alone.

### Actions and forms

- One primary action per task region. Secondary actions use neutral styling;
  destructive actions use the danger role and require clear copy.
- Disabled controls explain the prerequisite near the control. If an entire
  control group is unavailable, show the prerequisite once instead of a wide
  banner plus multiple disabled buttons.
- Icon-only controls require an accessible name and a visible tooltip on hover
  or focus when the icon is not universally understood.

### Panels, inspectors, and empty states

- A panel title says what the content is; supporting copy says why it matters.
  Avoid stacking eyebrow, title, subtitle, badge, status, and count when two
  lines communicate the same thing.
- Inspector panes use definition-list alignment for stable facts and expandable
  sections for verbose payloads. Long identifiers use copy affordances and
  middle truncation; prose should wrap normally.
- Empty states name what is missing, why it matters, and the single next action.
  They should not look like completed results.

### Tables and comparison lanes

- Lead Evidence results with a decision summary: verdict, evidence sufficiency,
  quality delta, and cost guardrail. Raw aggregate and trial tables are the
  supporting layer.
- Keep labels left-aligned and numeric columns right-aligned with tabular
  numerals. Freeze the header in locally scrolling tables when rows exceed the
  visible region.
- Reference, Baseline, and Candidate are evidence roles, not generic card
  colors. Use role labels in addition to blue/violet accents.
- Truncation must preserve the distinguishing suffix or offer the full value on
  focus/hover. Never let status copy or summary prose break into vertical words.

## Interaction and motion

- Every interactive element has a visible `:focus-visible` ring using the focus
  token with a 2px minimum width and sufficient offset.
- Hover may reinforce an affordance but must not reveal essential information
  unavailable to keyboard and touch users.
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
- Let users collapse secondary evidence while preserving context and selection.
- Prefer fewer, stronger labels and larger readable type over dense decoration.

**Do not**

- Duplicate navigation or status merely to fill a header.
- Use 7–9px prototype text, broad `!important` readability overrides, or an
  unbundled font name.
- Give every nested region a border, radius, shadow, badge, and uppercase label.
- Present a plain data dump as a decision screen or a decorative dashboard as
  evidence.
