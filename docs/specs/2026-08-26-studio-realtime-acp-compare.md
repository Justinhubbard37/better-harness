# Compare live ACP agent runs

## Traceability

- Spec ID: studio-realtime-acp-compare
- Status: Implemented

## Intent

Allow Harness Studio Compare to execute its fresh Baseline and Candidate runs
through one explicitly configured local ACP Agent, from the same locked
checkpoint and in separate isolated worktrees. The workbench must stream
canonical tool activity and bounded ACP protocol facts while retaining the raw,
redacted protocol evidence on disk for later review.

## Acceptance Scenarios

- AC-1: `harness-experiment.v1` accepts either the existing `qoder` host or an
  `acp` host. Qoder manifests retain their existing profiles and tool policy;
  ACP manifests use the single honest `acp-v1-stdio` profile, declare no
  Harness-standard tools, and may compare harness or model while keeping the
  host fixed across every lane.
- AC-2: Resolving an ACP experiment uses the prompt-session
  `@harness/adapter-acp` descriptor. A manifest cannot claim that Agent-owned
  ACP Tool Calls satisfy Harness `require tool` contracts.
- AC-3: When Studio has both an ACP experiment and a server-configured ACP
  Agent, every fresh trial starts its own Agent process in its own detached
  worktree, creates a new ACP v1 session rooted there, applies the lane's model
  through `session/set_config_option` only when that Agent supports lane-owned
  model selection, and streams its neutral Harness events into the existing
  lane-scoped experiment SSE endpoint.
- AC-4: Compare projects ACP protocol frames into bounded browser-safe facts,
  including method, direction, session id, and permission requests. The
  workbench shows per-lane ACP frame/session evidence and lets the user resolve
  only choices offered by that exact pending request through the existing
  same-origin permission route.
- AC-5: Cancelling the comparison, closing its SSE client, or closing Studio
  aborts every active lane, sends `session/cancel`, cancels pending permissions,
  and reaps Agent processes after the bounded executor grace period.
- AC-6: Each trial persists its redacted neutral trajectory, including raw ACP
  protocol events, plus runtime, materialization, permission, patch, Git, grade,
  and result receipts. The runtime receipt identifies the requested and
  observed ACP session configuration without claiming standard Harness tools.
- AC-7: Studio fails before materializing lanes when an ACP experiment has no
  configured ACP Agent. Browser input cannot provide or change the executable,
  argv, environment, workspace root, or protocol version.
- AC-8: Focused contract, executor, runner, server, model, and browser tests
  cover Qoder compatibility, ACP resolution/execution, model configuration,
  live protocol projection, permission selection, cancellation/disconnect,
  evidence retention, responsive layout, keyboard focus, and console/page
  errors. A real local `codex-acp` smoke proves two fresh lanes start from the
  same checkpoint and finish with distinct ACP session ids.

## Non-goals

- Comparing ACP against Qoder or another host in one experiment. Host remains a
  shared confounder boundary and is not introduced as a treatment axis.
- Discovering or accepting arbitrary Agent commands from the browser or from an
  experiment manifest.
- Treating observed ACP Tool Calls as a verified standard-tool capability.
- ACP v2, remote HTTP/WebSocket Agents, session resume, multi-turn chat, or
  restoration of external environment and network state.
- Changing the frozen `harness-compare.v1` CLI/results path.

## Plan and Tasks

1. Generalize the checkpoint experiment runtime contract to the bounded
   `qoder | acp` host set, with host-specific profile and visible-tool
   validation while preserving the existing schema version and Qoder inputs.
2. Resolve lane revisions through the descriptor for the declared host and
   select the matching executor factory. Keep ACP command ownership in Studio;
   the core runner accepts only an injected executor.
3. Extend `AcpSdkExecutor` with bounded session configuration applied after
   `session/new`, and include the applied configuration in the runtime receipt.
4. Bind Studio experiment lanes to its existing ACP run controls so permission
   and cancellation routes stay keyed by the exact lane `runId`.
5. Extend the canonical experiment stream with ACP protocol and permission
   facts, fold them into lane state, and render compact docked evidence and
   permission controls using existing Studio tokens.
6. Abort a run when its SSE client disconnects, retain per-trial protocol
   evidence, and add focused automated and real-runtime validation.

## Test and Review Evidence

- AC-1/AC-2: manifest, resolver, axis, and experiment-runner tests for both
  hosts and for ACP tool-claim rejection.
- AC-3/AC-6: ACP executor fixture tests for acknowledged
  `session/set_config_option`, Agent-default model policy, unique sessions,
  worktree cwd, runtime receipt, and persisted protocol trajectory.
- AC-4/AC-5/AC-7: Studio server/model tests for protocol projection,
  permission choice, missing Agent failure, explicit cancel, and transport
  disconnect cleanup.
- AC-8: focused package typechecks/tests, existing Qoder experiment regression,
  built Studio Playwright at wide/compact/narrow widths with screenshots and no
  console/page errors, then one two-lane local `codex-acp` smoke in read-only or
  isolated-worktree mode.
- Risk: an ACP Agent remains a real local process. Only the server owns its
  executable and argv; every fresh lane receives a detached worktree and the
  browser can only choose an Agent-offered permission option.
- Risk: model selection can be falsely reported if an Agent ignores session
  configuration. Treat `session/set_config_option` success plus the returned
  current option as the observed receipt; fail the lane when the requested
  model is not acknowledged.
- Risk: protocol frames may contain credentials or large payloads. Preserve the
  existing redaction and size/count bounds, stream only the minimal canonical
  projection, and keep full retained evidence server-side.

### Implemented evidence

- AC-1/AC-2/AC-3/AC-6/AC-7: Harness contract, runner, and ACP executor tests
  pass as part of 172 Harness tests. The real Studio run applied and observed
  `gpt-5.4` and `gpt-5.5` through `session/set_config_option`, produced distinct
  session ids, retained 163 and 157 ACP frames, and passed both isolated trials.
- AC-4/AC-5: Harness UI and Studio suites pass 31 and 275 tests. A live fixture
  run exposed two simultaneous lane-scoped permission requests, accepted each
  exact offered option, completed both lanes, and displayed 11 ACP frames per
  lane without browser console warnings or errors.
- AC-8: 486 focused/package/doc-link tests pass in total. Harness, Harness UI,
  and Studio production builds pass under Node 24, and generated Langium files
  are current. Browser checks at 1440x900 and 390x844 reported no horizontal
  overflow; screenshots cover idle, pending-permission, and narrow layouts.
- Environment limitation: the repository Canvas preview command cannot start
  on this host because no Canvas SDK runtime path is configured. This does not
  affect the built Studio surface or the live ACP Compare route.
