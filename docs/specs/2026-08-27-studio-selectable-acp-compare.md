# Selectable ACP comparison agents

## Traceability

- Spec ID: studio-selectable-acp-compare
- Status: Implemented

## Intent

Make live Compare easier to inspect and run. A selected file operation should
show its retained Tool Call result beside that operation, and each fresh lane
should let the user choose from the ACP Agents that this Studio server can
actually launch for the current project.

## Acceptance Scenarios

- AC-1: Selecting a Read, Edit, Search, List, Verify, or Run operation expands
  its bounded recorded result inside the same resource row and lane; the view
  does not require the user to correlate a row with a detached page footer.
- AC-2: Compare exposes one Agent selector per fresh lane. Each option reports
  a stable server-owned id, label, availability, and unavailable reason without
  exposing an arbitrary browser-controlled executable or environment.
- AC-3: Starting a comparison sends only the selected Agent ids. The server
  rejects unknown or unavailable ids before materializing trials and launches
  each lane with the command and argv registered for that exact id.
- AC-4: Studio discovers installed, protocol-backed presets for `qodercli
  --acp`, `codex-acp`, `pi-acp`, and `claude-agent-acp`; an environment-specific
  Agent such as DSH can be registered explicitly with a command and argv.
  Missing ACP bridges remain visible as unavailable rather than being treated
  as working Agents.
- AC-5: Existing single `--acp-agent <command>` startup remains compatible and
  becomes the default selection. Preset discovery is bounded, deterministic,
  and portable across Windows, macOS, and Linux.
- AC-6: Run evidence and lane headers identify the selected Agent separately
  from the requested model. A mixed-Agent comparison is labelled as such and
  does not claim that Agent identity was held constant.
- AC-7: Keyboard focus, live status, inline result overflow, and the Agent
  controls remain usable at 1440x900, 1024x768, and 390x844 with no
  document-level horizontal overflow or browser console/page errors.

## Non-goals

- Install ACP adapters or Coding Agent CLIs from a browser action.
- Treat a plain CLI or SDK as ACP when it does not expose an ACP stdio server.
- Accept a command, argv, environment, path, or package name from the run API.
- Infer file access, edits, verification success, or model quality beyond the
  retained canonical Tool Call and runtime evidence.
- Add a new Coding Agent host support claim to the repository host matrix.

## Plan and Tasks

1. Add a server-owned ACP Agent catalog with stable ids, preset discovery, an
   explicit named-registration CLI contract, and backward-compatible single
   Agent handling.
2. Project the catalog into the experiment preview, accept one selected id per
   execute lane, validate the bounded mapping, and select the matching executor
   at lane creation time.
3. Record and stream the selected Agent identity without replacing the lane's
   model identity or leaking executable details.
4. Add lane Agent selectors to the simple composer and place the selected Tool
   Call result inline in the originating resource row.
5. Add focused contract, server, model, component/browser, portability, and
   real-Agent tests; then run a read-only qodercli review before commits.

## Test and Review Evidence

- AC-2/AC-3/AC-5: server and CLI tests cover catalog projection, backward
  compatibility, unknown/unavailable ids, browser command omission, and
  lane-specific executor selection.
- AC-4: discovery tests simulate POSIX and Windows PATH/PATHEXT behavior without
  shell commands; local smoke records which preset executables are available.
- AC-1/AC-6: component/model tests assert that one selected operation owns its
  inline result and that Agent and model labels remain distinct.
- AC-3/AC-6: a two-lane fixture run proves two different registered commands
  are selected by lane and retained in canonical run evidence.
- AC-7: Playwright screenshots and overflow/focus/error checks at the three
  Studio layout widths.
- Risk: a preset name can overstate support. Availability requires the actual
  ACP entrypoint or explicit server registration; underlying CLI presence alone
  is insufficient for Pi, Claude, or DSH.
- Risk: dynamic Agent selection adds a treatment axis. The UI and compare-set
  metadata must keep that confounder visible rather than presenting a pure model
  comparison.
- Risk: browser-controlled process launch could become command injection. The
  request contains allow-listed ids only and process launch continues to use an
  argv array owned by the server.

### Implemented evidence

- Harness, Harness UI, and Studio suites pass 172/172, 31/31, and 291/291;
  generated Langium sources are current and the documentation link graph passes
  8/8 checks.
- The Studio Playwright surface passes 10/10 checks across wide, compact, and
  390px layouts, including one roving Tab stop for Resources/Messages, inline
  result ownership, bounded overflow, and browser console/page-error checks.
- A live mixed-Agent run selected `qodercli --acp` for AI 1 and `codex-acp` for
  AI 2. Both isolated trials passed, both changed only `README.md`, and their
  evidence records `agent-default` separately from the lane-selected
  `gpt-5.5` model.
- Local discovery reports Qoder CLI and Codex ACP available. Pi ACP, Claude ACP,
  and DSH remain visible but unavailable because their ACP entrypoints are not
  installed or explicitly configured on this host.
- A read-only qodercli review found no P1 issues. Its two P2 findings were fixed:
  already-exited Agent cleanup no longer waits through two grace periods, and
  experiment-wide preflight SSE failures are now visible in the Simple UI.
