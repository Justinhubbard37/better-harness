# Studio PDF, FBX, and Large Workbook Previews

Status: Implemented
Date: 2026-08-24

## Problem

Artifact View already dispatches through server-owned adapter and surface bindings, but PDF has no native binding, FBX has no activated Homology Provider contribution, and the XLSX projection drops cells outside a 200 by 64 preview window. Those gaps make the workbench look format-specific even though its extension points are general.

## Contract

- ArtifactView remains a renderer-agnostic dispatcher. It must not inspect PDF, FBX, Office, or Canvas payload details.
- PDF is a Studio-owned, read-only data surface. The adapter binds the exact catalog revision, exposes only the PDF bytes plus bounded page metadata, and the browser renders pages with PDF.js. PDF JavaScript, form actions, attachments, and external network access are not executed.
- FBX is a Provider-owned external-hosted surface. The Homology Provider binds the exact catalog revision, parses it with `@homology/diagram-fbx`, and owns the rendered document. Better Harness only validates and mounts the common opaque hosted surface.
- XLSX remains a Studio-owned read-only data surface. The projection may expose up to the existing populated-cell budget, and the client virtualizes rows so a large sparse worksheet does not create one DOM row for every worksheet row.
- Revision, adapter, renderer, hosted-runtime, provider fingerprint, capability, and security-profile identity continue to decide surface retention. Late data from an older revision must not replace the current view.

## Acceptance criteria

1. A real multipage PDF appears as a native Artifact View with page count, page navigation, zoom, keyboard operation, and virtualized page mounting.
2. PDF bytes are served only from an immutable revision resource URI. Oversized files, excessive page counts, malformed files, password-protected files, and revision drift fail closed with a browser-safe diagnostic.
3. A real ASCII or binary FBX appears through the existing external-hosted iframe lane, includes mesh/vertex/polygon metadata, and remains usable without adding an FBX branch to `ArtifactView.tsx` or the Studio surface registry.
4. FBX provider activation is explicit and receipt-bound. Ordinary TSX/JSX, Canvas TSX, diagrams, notebooks, Office files, and unknown files retain their existing resolution rules.
5. XLSX retains populated cells beyond row 200, renders only the visible row window plus overscan, preserves sheet and cell selection across compatible revisions, and supports keyboard navigation to an off-screen row.
6. Unit tests cover model validation, catalog resolution, exact-revision resource reads, fail-closed inputs, provider receipts, and renderer selection. Browser tests cover wide, compact, and narrow layouts with no page errors, console errors, or unintended horizontal page overflow.

## Limits and non-goals

- This work is read-only. It does not add PDF editing, Office writeback, formula recalculation, chart/pivot fidelity, or native Office parity.
- The FBX projection is a bounded model preview, not a claim of skinning, animation, audio, official Cursor parity, or pixel identity with a DCC application.
- The opaque hosted provider profile remains network-denied. Hostile remote providers and publication certification remain separate trust and release work.

## Verification

- Better Harness Node 24 generated-code check, Harness build/Vitest (19 files, 162 tests), Studio build/Vitest (40 files, 243 tests), Playwright (35 tests), and package verification passed.
- Homology `diagram-fbx` build and integration Provider check passed (4 files, 13 tests; pack 1,851,262 bytes / 6,056,207 bytes unpacked / 11 entries), plus the cross-repository `verify:studio` route check.
- A real three-page PDF, binary FBX, and generated 420-row XLSX returned exact-revision snapshots/resources; PDF and XLSX used native bindings, while FBX used the receipt-bound opaque hosted Provider.
- Browser inspection at 1440x900, 1024x768, and 390x844 found zero page overflow and zero final console warning/error. PDF rendered real canvases and navigated to page 2; XLSX mounted 37 visible rows and materialized A420 only near the bottom; FBX pan/zoom controls changed scale from 1.0 to 1.2.
