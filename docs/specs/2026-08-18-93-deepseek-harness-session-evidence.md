# DeepSeek Harness Session Evidence

## Traceability

- Spec ID: deepseek-harness-session-evidence
- Story: #93
- Status: Implemented

## Intent

Add a narrowly scoped, read-only DeepSeek Harness (`dsh`) session adapter so
Better Harness can analyze durable DSH JSONL evidence after a run. The first
slice stops at session discovery, workspace qualification, validation, and
normalization into the existing session-analysis contract. It deliberately does
not present DSH as a first-class or natively integrated Better Harness host.

This specification freezes the partial boundary approved by the maintainer in
[Issue #93](https://github.com/QoderAI/better-harness/issues/93), including the
feature-detection policy approved in the 2026-08-18T13:13:05Z comment. The
supported native contract is pinned to upstream commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, tag/contract
`dsh-v0.1.0-rc.7`, and `SESSION_FORMAT_VERSION = 0`. Later upstream behavior is
not implicitly supported.

## Native Contract Evidence

The implementation and its support claims must remain bound to these five
primary upstream sources at commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`:

1. [Developer-preview status, compatibility warning, and plugin-oriented positioning](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/README.md)
2. [Base profile composition and the DSH-home sessions route](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/bundle/base/cordis.patch.yml)
3. [Session header, format version, event vocabulary, correlation fields, and turn outcomes](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/session/src/types.ts)
4. [JSONL layout, default Zstandard encoding, packed rows, identity checks, and discovery constraints](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/session/session-persistence-jsonl/README.md)
5. [SQLite's separate persistence and discovery contract](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/session/session-persistence-sqlite/README.md)

Synthetic fixtures may encode only behavior supported by those pinned sources
and the approved Issue #93 boundary. A fixture passing is not evidence that a
newer DSH build remains compatible. Same-version structural drift must fail
closed rather than extending this contract by inference.

## Support Boundary

The delivered support claim is:

```text
DSH persisted JSONL session
  -> workspace qualification
  -> supported event normalization
  -> Better Harness session evidence
```

The Better Harness adapter metadata id is `dsh-v1`; the only supported native
DSH session format is `0`. The `dsh` host is registered only for the
`sessionAnalysis` capability. Raw `session.jsonl` and, when the running Node.js
runtime exposes the required public Zstandard API, concatenated checksummed
`session.jsonl.zstd` are the only physical encodings. SQLite and custom
persistence providers remain unavailable.

Support is JSONL-only and partial. Every artifact is read-only. Unavailable,
incomplete, malformed, ambiguous, foreign-workspace, and unsupported evidence
must remain visible as such or be rejected according to the acceptance
scenarios below; it must never be guessed, repaired, rewritten, or promoted to
a broader host capability.

## Acceptance Scenarios

### AC-1: Scope resolution

An explicit `--dsh-home` value takes precedence over inherited `DSH_HOME`,
which takes precedence over the default `~/.dsh`. The only session root is
`<resolved-home>/sessions`; empty, malformed, or otherwise unresolved values do
not trigger guesses at alternate roots.

### AC-2: Artifact discovery

Discovery accepts only the fixed nested DSH JSONL layout containing
`session.jsonl.zstd` or raw `session.jsonl`. It deduplicates by canonical
artifact path and bound session identity. Conflicting encodings or identities,
flat legacy layouts, and ambiguous artifacts fail closed and contribute no
session evidence.

### AC-3: Physical and logical validation

Before evidence is accepted, the adapter validates the tagged header's `type`,
format `version`, session `id`, `createdAt`, absolute `cwd`, and required
`delegationDepth`; artifact identity; session-id/path binding; and logical JSONL
record shape. Format `0` event `seq` values start at `0` and remain contiguous.
Default `packChunks=true` storage rows are losslessly decoded according to the
pinned upstream shape and their logical events participate in sequence
validation; a packed storage row is never treated as a `SessionEvent` itself.
Malformed records, identity or sequence mismatch, unsupported versions, and
same-version structural drift are rejected.

### AC-4: Zstandard runtime policy

A compressed artifact is treated as a concatenation of independently
checksummed Zstandard frames. The adapter scans and validates frame boundaries,
decompresses each complete frame independently, and concatenates the decoded
payloads; it must not submit the entire file to a single decompression call.
The public Zstandard API available in supported Node.js 22.20 and 24 runtimes is
feature-detected at runtime. Where Node.js 23.0 through 23.7 exposes no required
public API, compressed evidence is explicitly unavailable while raw JSONL
evidence remains readable. This slice adds no dependency and changes no Node.js
engine range.

### AC-5: Workspace qualification

Only the header's absolute `cwd` qualifies a session to the requested
workspace. The intentionally lossy project-directory name is never used as
workspace evidence. Qualification follows existing Better Harness workspace
topology and path, case, canonicalization, and symlink semantics across Windows,
macOS, and Linux. A foreign workspace cannot enter the result.

### AC-6: Normalization and bounded provenance

Normalization allowlists only `user/message`, `assistant/message`, `tool/call`,
`tool/result`, and turn lifecycle/outcome evidence. It preserves observed user
source distinctions, native call/result ids, turn/step/sequence coordinates,
and bounded `parentSession`, `seedLength`, `origin`, `delegationDepth`, and
`agentPreset` provenance. It does not copy arbitrary raw or plugin data and
does not infer plugin ownership, plugin causality, or faulty-plugin attribution.

### AC-7: Privacy and completeness

The adapter reuses the existing `includeUserText`, `includeCommandText`, and
`includeContent` gates. Credential-shaped fixture values do not leak through
facts, diagnostics, provenance, or errors. Missing token or usage fields remain
unobserved rather than becoming zero. An unknown required event rejects the
artifact; an unknown ignorable event is explicitly accounted for. An open
trailing turn is marked incomplete. Every source read is read-only, and no path
repairs or rewrites an upstream artifact.

### AC-8: Capability boundary

The Better Harness adapter id is `dsh-v1` and supports only native DSH session
format `0`. The `dsh` host receives only `sessionAnalysis`; catalog projection
must not grant configured assets, plugin lifecycle, shell, output, packaging,
or another capability. The session-analysis CLI and loader support `dsh`
explicitly, and unknown hosts continue to fail closed rather than falling
through to another adapter.

### AC-9: Deterministic evidence

Synthetic fixtures and behavioral tests cover raw JSONL, concatenated
checksummed Zstandard frames, workspace acceptance and rejection, packed rows,
event correlation, every terminal outcome, unknown required and ignorable
events, bad format version/header/id/sequence, malformed data, an open trailing
turn, canonical path and session-identity deduplication, privacy gates,
Zstandard API absence, and Windows/macOS/Linux path behavior. No fixture contains
a real transcript, secret, credential, or machine-specific absolute path.

### AC-10: Honest documentation

The source host adapter matrix and published adapter matrix describe DSH as
JSONL-only partial session evidence and identify every unavailable slice. DSH is
not added to README Quickstart or Installation. Documentation does not claim a
shell, configured assets, Skills, plugin lifecycle, packaging, report output,
native invocation, SQLite, or custom-provider support.

### AC-11: Validation and readiness

Focused adapter, loader, registry, CLI, fixture, and documentation tests pass,
followed by `npm test`, `npm run pack:verify`, and `git diff --check`. Review
evidence maps Story #93 to this spec, every AC to behavioral tests or an
explicit review check, and each material risk to a fail-closed response. The
diff contains no real transcript, secret, credential, or machine absolute path.

## Non-goals

- Native DSH installation, invocation, live PTY integration, or process-state
  observation.
- Configured-asset or Skill discovery.
- DSH plugin lifecycle integration.
- A shell, manifest, package integration, or packaging claim.
- README Quickstart or Installation placement.
- A report output route or a new report mode.
- SQLite or custom persistence-provider support.
- Global Node.js engine-range changes or new dependencies.
- Automatic harness optimization or self-modification.
- Faulty-plugin identification, plugin ownership, or causality inference.
- Upstream artifact mutation, repair, or recovery.
- Complete first-class DeepSeek Harness support.

## Plan and Tasks

1. **Contracts and fixtures (AC-3, AC-4, AC-6, AC-7, AC-9):** encode the
   pinned format-0 header, logical events, packed-row shape, terminal outcomes,
   bounded provenance, privacy values, raw JSONL, and independently checksummed
   concatenated Zstandard frames as deterministic synthetic fixtures. Include
   malformed and unsupported variants without copying a real transcript.
2. **Discovery and decoding (AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-9):** add
   explicit DSH-home resolution, nested artifact discovery, canonical identity
   deduplication, workspace qualification, raw decoding, feature-detected
   frame-by-frame Zstandard decoding, packed-row expansion, and fail-closed
   validation. Keep all reads side-effect free.
3. **Normalization and registration (AC-6, AC-7, AC-8, AC-9):** map only the
   allowlisted event subset into existing session facts, preserve bounded
   correlation/provenance, expose incompleteness and unavailable evidence, and
   register `dsh-v1` only in session-analysis loader/CLI and the corresponding
   capability slice.
4. **Documentation and support claims (AC-8, AC-10):** update only the two
   adapter matrices and relevant session-analysis support references so their
   JSONL-only partial claim, runtime Zstandard boundary, and unavailable slices
   exactly match executable behavior. Do not widen README installation or
   Quickstart surfaces.
5. **Full validation and readiness (AC-9, AC-11):** run focused behavioral
   tests, the full suite, package verification, whitespace validation, and a
   Review Readiness Check. Inspect the complete diff for capability overclaim,
   private data, real transcripts, machine paths, generated-file drift, and a
   coherent Story -> Spec -> AC -> test/risk evidence chain.

Each module is reviewed before the next begins. A later task may tighten an
implementation detail only when it remains inside these ACs and the pinned
native sources; widening support requires a separately approved specification.

## Test and Review Evidence

| Acceptance criteria | Test or command | Expected review evidence |
| --- | --- | --- |
| AC-1 | Focused home-resolution tests | CLI override wins over environment and default; the only derived root ends in `sessions`; invalid values do not guess. |
| AC-2 | Focused discovery and dedupe tests | Only fixed nested raw/compressed artifacts qualify; canonical path/session collisions, flat legacy, conflicts, and ambiguity fail closed. |
| AC-3 | Header, identity, sequence, malformed, and packed-row fixture tests | Format-0 headers and logical records validate; packed logical events retain contiguous sequence; drift and malformed input are rejected. |
| AC-4 | Raw, concatenated checksummed-frame, truncated-frame, and API-absence tests | Each complete frame is decoded independently; truncation rejects; unavailable API disables only compressed evidence; dependency and engine diffs stay empty. |
| AC-5 | Workspace topology tests on Windows/macOS/Linux path forms | Absolute header `cwd` follows existing case/canonical/symlink semantics and foreign workspaces never contribute facts. |
| AC-6 | Event normalization, correlation, and provenance tests | Only allowlisted evidence appears; native ids and bounded coordinates/lineage survive; arbitrary/plugin fields and causal claims do not. |
| AC-7 | Privacy-gate, unknown-event, missing-usage, open-turn, and read-only tests | Content gates redact credential-shaped values; absence stays unobserved; required unknowns reject, ignorable unknowns are accounted, and open turns stay incomplete without writes. |
| AC-8 | Catalog capability mapping, loader, CLI help, and unknown-host tests | `dsh-v1` accepts only format 0; only `sessionAnalysis` maps to `dsh`; loader/CLI route explicitly and unknown hosts reject. |
| AC-9 | Focused cross-platform synthetic fixture suite | Every enumerated encoding, validation, lifecycle, identity, privacy, runtime, and path case has deterministic behavioral evidence with no real local data. |
| AC-10 | Adapter matrix assertions plus `npx vitest run test/skills-docs/doc-link-graph.test.mjs` | Both matrices expose the same partial JSONL claim and unavailable slices; links resolve; README Quickstart/Installation remains unchanged. |
| AC-11 | Focused tests; `npm test`; `npm run pack:verify`; `git diff --check`; Review Readiness Check | All commands report their actual result; package boundaries remain valid; diff is whitespace-clean and the Story/Spec/Test/Risk chain is complete. |

Native smoke evidence, if available during implementation, is bounded and
redacted. It may confirm the pinned contract but cannot replace deterministic
fixtures or justify a broader support claim. Node.js runtimes without the public
Zstandard API must be exercised through deterministic feature-absence tests,
not described as a successful compressed-session smoke.

## Risks and Rollback

| Risk | Fail-closed control and review signal |
| --- | --- |
| Same-version structural drift | Validate the complete supported header and logical shapes against pinned fixtures; reject unrecognized required structure. |
| Packed rows mistaken for events | Decode only the upstream lossless packed-row shape before sequence validation; reject malformed packing and never normalize the storage row itself. |
| Multi-frame Zstandard truncation or silent tail loss | Scan and validate every boundary/checksum, require complete frames, decompress frame by frame, and reject a truncated or trailing-invalid artifact. |
| Zstandard API unavailable | Feature-detect the public API, mark compressed evidence unavailable, and continue to support independent raw evidence. |
| Path alias, case, or symlink mismatch | Reuse existing workspace topology and canonical path semantics with cross-platform positive and negative fixtures. |
| Foreign workspace admitted | Require the absolute header `cwd` to qualify; do not consult the lossy directory name or another heuristic. |
| Artifact or session identity collision | Bind header id to the nested artifact path, deduplicate canonical identity, and reject conflicts or ambiguity. |
| Unknown required event silently dropped | Distinguish required from explicitly ignorable events; reject the former and account for the latter. |
| Private content or credential leakage | Apply existing content gates at normalization and error/provenance boundaries, then assert value-level non-disclosure with synthetic credential shapes. |
| Capability or documentation overclaim | Test catalog-to-implementation mapping and review both matrices against the non-goals; no catalog projection may create an unsupported slice. |

Rollback removes the session-only adapter, its `sessionAnalysis` registration,
its synthetic fixtures/tests, and its two matrix claims. No user-data migration
or cleanup is needed because the adapter never writes, repairs, converts, or
owns DSH artifacts. If a runtime or upstream compatibility risk is found before
that full rollback, the affected evidence path fails closed while raw evidence
and unrelated host adapters remain unchanged.
