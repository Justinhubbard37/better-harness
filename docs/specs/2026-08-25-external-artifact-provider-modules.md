# External Artifact provider modules

## Traceability

- Spec ID: external-artifact-provider-modules
- Status: Implemented

## Intent

Let an operator run a separately published Artifact Provider in Harness Studio
without copying its renderer or adapter into Studio. The host owns module
loading and Provider validation; the external package owns format semantics and
its receipt-bound implementation.

## Acceptance Scenarios

- AC-1: Repeated `--artifact-provider-module <specifier>` options load the
  module's `createArtifactProvider()` result and inject it through Studio's
  existing external Provider registry.
- AC-2: Relative module paths resolve from `--cwd`, package specifiers resolve
  through Node, and URL/builtin/empty/duplicate/over-budget inputs fail before
  Studio opens a port.
- AC-3: A real published Homology Notebook Provider can be activated and render
  an `.ipynb` through the generic hosted surface; Studio does not import the
  Provider's private renderer or adapter files.
- AC-4: Help, TypeScript build, focused unit/server tests, and a clean packed
  cross-repository consumer prove the integration boundary.

## Non-goals

- Downloading or installing Provider packages from the Studio UI.
- Granting an untrusted module a sandbox; module loading is an explicit
  operator-authorized local-code action.
- Moving Notebook or kernel execution semantics into Better Harness.
- Automatically activating a contribution without the existing fingerprint-
  bound activation record.

## Plan and Tasks

- Add a bounded Node module loader beside Artifact Provider discovery.
- Add a repeatable CLI option and pass loaded Providers through the existing
  `artifactProviders` embedding seam.
- Declare the Homology Provider as an optional peer integration after it has a
  public npm identity; keep Studio independently runnable without it.
- Test parsing, path/package resolution, failure closure, registry status, and
  the real cross-repository package lane.

## Test and Review Evidence

- AC-1/AC-2: focused Vitest for loader and CLI behavior.
- AC-3: Homology clean-consumer tarballs plus Harness Studio server/browser E2E.
- AC-4: Node 24 package build/test/pack and Review Readiness Check.
- Risk: loaded modules execute with the Studio process authority. The CLI help
  and spec identify this as an operator-provisioned local-code boundary; no
  browser-controlled module specifier is accepted.
- Implemented evidence: Node 24 Studio build and 46 files/270 Vitest tests;
  generic external-host Playwright 1/1; Homology's packed-provider browser E2E
  loaded the public factory, verified/activated its receipt, rendered Markdown
  plus stored output, and reported 0 console/page errors.
