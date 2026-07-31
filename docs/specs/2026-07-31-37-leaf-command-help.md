# Leaf command help

## Traceability

- Spec ID: 37-leaf-command-help
- Story: #37
- Status: Draft

## Intent

Make `--help` and `-h` immediate, side-effect-free discovery requests for every registered Better Harness terminal path. The root dispatcher must select the registered command owner before it forwards help so invalid or incomplete user arguments cannot reach runtime handlers.

## Acceptance Scenarios

- AC-1: Every canonical registered command path and direct-command alias exits successfully with canonical help on stdout and no stderr when either help flag appears after arbitrary arguments.
- AC-2: The dispatcher removes arbitrary arguments before invoking a registered leaf owner, retaining only a registered direct subcommand when that subcommand shares its owner's script.
- AC-3: Root and group help retain their existing behavior, including audience filtering and unknown-subcommand diagnostics; an unknown root command falls back to root help when a help flag is present.

## Non-goals

- Changing command execution when no help flag is present.
- Changing help text, command registry metadata, or the behavior of individual command implementations.
- Adding new command paths or aliases.

## Plan and Tasks

1. Detect either help flag before built-in metadata handlers or runtime dispatch.
2. Resolve a direct or group leaf only from the registry and forward a canonical help argument list to its exact owner.
3. Add an inventory-driven regression that covers canonical paths, aliases, and both help flags.

## Test and Review Evidence

- AC-1 and AC-2: `node --test test/better-harness-cli.test.mjs` exercises every inventory-derived route with an invalid argument before each help flag.
- AC-3: The same focused test covers invalid group and root paths with a help flag.
- Regression gate: `npm test`.
- Risk: centralized early exit could alter a metadata command's help behavior. The implementation scopes leaf dispatch through the existing registry and preserves normal execution paths when no help flag is present.
