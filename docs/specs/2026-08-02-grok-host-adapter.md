# Spec: Grok CLI host adapter

**Date:** 2026-08-02
**Host id:** `grok`
**Host version (verified):** Grok CLI 0.2.x (user-guide + local `~/.grok`)
**Capability level (this PR):** Partial adapter → Verified assets + sessions + HTML render path
**Non-goals:** Grok marketplace packaging into public npm shell; Canvas mode; reading `auth.json` secrets; claiming full Quickstart until native install smoke is recorded.

## Support slices

| Slice | Status | Owner |
| --- | --- | --- |
| Shell / discovery | Partial — Skill path + optional thin docs; no `.grok-plugin` required for analysis | docs + `skills/better-harness` |
| Configured assets | Claimed | `scripts/agent-customize/providers/grok.mjs` |
| Session evidence | Claimed | `scripts/session-analysis/platforms/grok.mjs` |
| Evidence bundle / registries | Claimed | capability indexes + `evidence-bundle` |
| Output | Claimed — HTML visual | `.grok/better-harness` host root |
| Packaging (npm shell) | Unavailable this PR | — |

## Native contract (verified)

| Item | Value |
| --- | --- |
| Home | `GROK_HOME` env, else `~/.grok` |
| Config | `$GROK_HOME/config.toml` |
| Skills | `$GROK_HOME/skills/`, `$GROK_HOME/bundled/skills/`, `<ws>/.grok/skills/`, `<ws>/.agents/skills/` |
| Hooks | `$GROK_HOME/hooks/*.json`, project `.grok/hooks` when present |
| MCP | `[mcp_servers.<name>]` tables in `config.toml` (enabled flag) |
| Plugins | `$GROK_HOME/installed-plugins/`, `marketplace-cache/` (inventory only) |
| Sessions | `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/` with `summary.json`, `updates.jsonl`, `chat_history.jsonl`, `signals.json` |
| Report root | `<workspace>/.grok/better-harness/` |
| Output mode | `html` |

### Workspace qualification

'
    )
# add notes section if missing
if 'updates.jsonl is authoritative' not in t:
    t = t.replace(
        '### Privacy
',
        - `updates.jsonl` is the authoritative conversation log; `chat_history.jsonl` is only used when updates are missing (never both).
- Terminal tool results require an explicit terminal status (`completed`/`failed`/…); progress and status-less `tool_call_update` stay metadata.
- Model usage comes from `turn_completed.usage` on `_x.ai/session/update` records. `signals.contextTokensUsed` is context occupancy, not total spend.
- When `encodeURIComponent(cwd)` exceeds 255 bytes, Grok uses a slug+hash group directory and stores the original path in `.cwd`; discovery matches both forms.

### Privacy

- Prefer `summary.json` → `info.cwd` (or equivalent) matched via existing workspace-match helpers.
- Session group directory name is `encodeURIComponent(absoluteCwd)` (e.g. `/Users/work` → `%2FUsers%2Fwork`).
- Foreign-workspace sessions never enter facts for a report.

### Privacy

- Never serialize `auth.json`, API keys, or MCP `env` secret values.
- Inventory may record server names, enabled flags, and path existence only.

## Acceptance ids

| Id | Criterion |
| --- | --- |
| Grok-A1 | Provider inventory returns skills/hooks/mcp/plugins scopes for synthetic home + workspace |
| Grok-A2 | `GROK_HOME` / `--grok-home` overrides default without foreign home fallback |
| Grok-S1 | Session sources list only cwd-matching sessions under encoded group dir |
| Grok-S2 | Foreign session group excluded from sources |
| Grok-S3 | Missing `signals.json` usage stays unobserved (not zero-filled) |
| Grok-S4 | Unknown `updates.jsonl` events preserved as metadata |
| Grok-R1 | `platform=grok` accepted by evidence-bundle and session-analysis CLI help |
| Grok-R2 | HTML render default out root documents `.grok/better-harness` |

## Smoke (local)

```bash
node scripts/session-analysis.mjs sources --platform grok --workspace <path>
node scripts/better-harness.mjs agent-customize inventory --provider grok --workspace <path>
node scripts/better-harness.mjs harness evidence-bundle --platform grok --workspace <path> --depth quick --format json
```

Install skill for Grok TUI:

```bash
ln -sfn <repo>/skills/better-harness ~/.grok/skills/better-harness
# then in a target repo: /better-harness …
```
