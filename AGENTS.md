# Ripple

Two Forge apps in one npm-workspaces monorepo. Architecture spec: `PROMPT.md`.

- `apps/gate` — Bitbucket workspace app. Scopes: `*:bitbucket` and `storage:app` only.
- `apps/brain` — Atlassian site app (Jira + Teamwork Graph; no Compass). Never a `*:bitbucket` scope.
- `packages/contracts` — wire contract v1 and HMAC-SHA256 signing shared by both apps.

## Commands (run from the repo root)

- `npm run verify` — build contracts, typecheck everything, run tests, no-`any` check, scope-boundary check, bundle both apps
- `npm run bundle` — esbuild each app to `apps/<app>/dist/index.js` (CommonJS, contracts inlined); Forge uploads `dist/` as-is (`bundler: manual@2026`), so always bundle before `forge deploy`
- `npm run build` — compile `packages/contracts` to `dist/` (apps resolve its types from there)
- `npm test` — `node --test`, TypeScript run directly by Node (no test framework)

## Deploying (Forge CLI is a dev dependency; needs Node 22 via nvm, FORGE_EMAIL and FORGE_API_TOKEN)

- `npm run bundle`, then `npx forge deploy -e development --non-interactive` in `apps/brain` and `apps/gate`.
- Scope changes need `--approve MAJOR_VERSION_RULE` on deploy and `forge install --upgrade` afterwards.
- Brain is installed in Jira on `one-atlas-hfre.atlassian.net`; Gate in Bitbucket workspace `one-atlas-hfre`.
- `scripts/smoke.mjs` sends an HMAC-signed POST to a web trigger (key from `RIPPLE_SIGNING_KEY`).

## Invariants

- Dependencies come from `ripple.yml` at the repo root (service space + downstream Jira space keys), read from the PR's destination branch first.
- Ownership of a space is tiered: graph-linked teams, then the Jira project lead's team, then the lead alone.
- Teamwork Graph is user-only: calls impersonate the PR author, and operation names must look like `ripple_operation`.

- Strict TypeScript, zero `any`. Identifiers are branded types; create them only via the `parse*` helpers in `packages/contracts/src/ids.ts`.
- The scope boundary above is a hard platform rule: mixing them fails `forge deploy`.
- Every inter-app request is signed and verified with `packages/contracts/src/signing.ts`.
- The merge decision is `MERGE_OUTCOME` in `apps/gate/src/types.ts`; it must never read LLM output.
- Commit SHAs are always the full 40 characters, in memory, on the wire and in KVS keys.
- Logic depends on the interfaces in `apps/*/src/ports.ts`; only `apps/*/src/forge/` may import `@forge/*`. Tests use `apps/*/src/testing/fakes.ts`.
- Fallible operations return `Result<T, E>` (`packages/contracts/src/result.ts`); payloads crossing the app boundary are decoded with `schemas.ts`.
- Source imports use `.ts` extensions so Node can run tests directly.
- New dependencies: pin exact versions published at least 7 days ago.
