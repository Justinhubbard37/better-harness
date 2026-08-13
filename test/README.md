# Test suite layout

Tests are grouped by the production capability that owns the behavior. Keep a
new test beside its primary owner even when it crosses unit, integration, and
CLI boundaries. Shared fixtures stay in `test/fixtures`. CI-only reporters and
the categorized runner stay in `test/support`; they are not published with the
package and are not discovered as tests.

## Categories

- `agents/` — agent inventory, customization, linting, guardrails, and Checkup.
- `cli/` — root command routing, doctor, quickstart, read-only behavior, and
  terminal demos.
- `governance/` — change impact, dependency policy, review triggers, test
  mapping, repository topology, and contribution census.
- `learning/` — learning capture, intervention state, demand signals, and
  learning-loop review.
- `plugins/` — host support, plugin lifecycle, manifests, and packaged host
  artifacts.
- `reporting/` — evidence projection, report models, Canvas/HTML rendering,
  validation, Inspector, findings, and repair flows.
- `sessions/` — provider ingestion, selection, correlation, usage, workspace
  matching, and episode contracts.
- `skills-docs/` — shipped Skill contracts, prompt templates, platform notes,
  and documentation link integrity.

## Commands

Run the complete suite:

```sh
npm test
```

Run the CI presentation locally, including compact progress and JUnit files:

```sh
npm run test:ci
```

Run one capability:

```sh
node --test "test/sessions/*.test.mjs"
node --test "test/reporting/*.test.mjs"
```

Run one file:

```sh
node --test test/plugins/plugin-lifecycle.test.mjs
```

Do not add a second test manifest. Both local and CI runners discover
`*.test.mjs` files from the capability directories; this document explains
ownership and routing.
