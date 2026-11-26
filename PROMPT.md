# ROLE

You are a principal Atlassian ecosystem engineer and hackathon-winning architect. You have deep, current knowledge of Atlassian Forge, Bitbucket Cloud, Compass, the Teamwork Graph, Forge LLMs, Rovo, and Jira Cloud APIs. You write implementation documentation that a solo developer can execute without needing to make any further design decisions.

# MISSION

Create TWO files in this repository:

1. `PLAN.md` — the project execution plan for building the app within a 1–2 week hackathon window
2. `BUILD.md` — the complete technical build guide, detailed enough to implement from without guesswork

These documents are for **Codegeist 2026** (Atlassian's hackathon: https://codegeist2026.devpost.com/). The judging strategy is to go **all-in on native Atlassian platform depth**: Forge, Compass, Teamwork Graph, Forge LLMs/Rovo. Do NOT design a generic tool with an Atlassian wrapper.

# THE PRODUCT: "Ripple" — Pre-Merge Blast Radius & Accountability Gate

Ripple runs on Bitbucket Cloud pull requests. It answers one question: **"What else could this PR break, who needs to know, and what must be updated before we merge?"**

It is NOT a dependency graph visualizer and NOT generic AI code review. It is a **pre-merge impact and accountability workflow**:

1. Detect when a PR touches cross-cutting architectural surfaces (not typo fixes).
2. Expand the blast radius through the Compass service catalog and Teamwork Graph — downstream consumers, owning teams, linked ADRs/runbooks, open Jira work.
3. Generate a grounded impact analysis using Atlassian-hosted LLMs.
4. Block merge via a custom merge check until every affected downstream owner signs off — OR the author explicitly accepts risk, which auto-creates a linked Jira tech-debt ticket with owner, due date, and PR linkage, then unblocks merge.

Motivating example: a PR changing an auth token format looks small in the diff but can affect the mobile client, internal APIs, reporting jobs, a security runbook in Confluence, a Jira migration epic, and two other teams' services. Ripple surfaces all of that BEFORE merge and makes the resolution accountable.

# CRITICAL ARCHITECTURE CONSTRAINT: THIS MUST BE TWO FORGE APPS

This is a hard platform constraint discovered through research, and getting it wrong invalidates the entire design. You MUST verify it independently and design around it:

- A single Forge app **cannot hold Bitbucket workspace scopes and Jira/Compass/Teamwork-Graph site scopes in the same manifest**. `forge deploy` fails with: `"Workspace scopes can not be used with site scopes"`.
- `requestJira` is rejected from a Bitbucket installation context ("Request jira is not allowed from bitbucket context"). The same applies to Compass/GraphQL-gateway access, which requires site scopes.
- Multi-product app compatibility currently covers **Jira + Confluence only** — Bitbucket is excluded (org-linking of workspaces, CHANGE-2776 effective March 2026, is laying groundwork but cross-product Bitbucket apps are not generally available).
- Other Codegeist 2026 entrants solve this exact problem with a **two-app architecture communicating via Forge web triggers** — see github.com/vigohan95/merge-policy-gate and merge-gate-explainer for a working precedent. Community consensus is that two installation links in one submission are acceptable, but flag this as `⚠️ VERIFY` against the official rules.

Therefore Ripple is two apps sharing one repository (monorepo, two manifests, two app IDs):

## App 1 — "Ripple Gate" (Bitbucket workspace app)
- Modules: `bitbucket:repoPullRequestOverviewPanel`, `bitbucket:mergeCheck`, `trigger` (PR events), `webtrigger` (receives analysis results pushed by Brain), function modules, storage.
- Scopes: `read:pullrequest:bitbucket`, `read:repository:bitbucket`, `storage:app` — workspace scopes ONLY, never site scopes.
- Responsibilities: fetch diffs via Bitbucket REST, run the deterministic noise-gate classifier, resolve repo→component binding files, render the PR panel, run the merge check state machine, validate signoff clicks against the pre-resolved roster, store gate state in its own Forge storage.
- NEVER calls Jira, Compass, Teamwork Graph, or any site-scoped API.

## App 2 — "Ripple Brain" (site app, installed on the Atlassian cloud site with Jira/Compass/Confluence)
- Modules: `webtrigger` endpoints (the inter-app API), `llm` module for Forge LLMs, optional `rovo:agent` for judge-facing conversational follow-up in Jira/Confluence, optional scheduled trigger for cleanup, storage.
- Scopes: `read:component:compass`, `read:graph:component:compass` (or whatever the current graph scope names are — VERIFY), `read:graph:user:atlassian`, `read:graph:team:atlassian`, other `read:graph:*` scopes per object types traversed, `read:jira-work`, `write:jira-work`, `storage:app`.
- Responsibilities: Compass graph expansion (reverse `DEPENDS_ON`), Teamwork Graph enrichment (owners, team members, linked Confluence ADRs, open Jira work), Forge LLM grounded analysis + validation layer, signoff roster resolution, Jira tech-debt ticket creation.
- NEVER holds Bitbucket workspace scopes.

## Inter-app contract (the nerve center — must be fully specified in BUILD.md)
- Brain exposes webtrigger endpoints; Gate calls them with signed payloads:
  - `POST /analyze` — Gate → Brain: semantic diff summary, repo/component binding info, PR metadata keyed by `{workspace, repoSlug, prId, headSha}`. Idempotent on that key.
  - `GET /verdict?workspace=&repo=&pr=&sha=` — Gate → Brain polling fallback: returns current analysis state.
  - `POST /signoff` — Gate → Brain: records a signoff decision (after Gate-local roster validation); Brain writes the audit record. (Evaluate whether signoff state should live in Gate storage only, with Brain just providing rosters — pick the simpler correct design and justify it.)
  - `POST /accept-risk` — Gate → Brain: triggers Jira ticket creation; returns ticket key/URL.
  - `POST /verdict-push` — Brain → Gate (reverse direction): when analysis completes, Brain pushes the verdict + pre-resolved signoff roster to Gate's webtrigger so the merge check never depends on a live cross-app call.
- Authentication between apps: shared secret provisioned as an environment variable in BOTH apps (`forge variables set`), sent as a bearer/HMAC header; document rotation. Note honestly that webtrigger URLs are unauthenticated by default and this shared-secret pattern is the standard mitigation — judges care about security posture.
- All payloads keyed by `{workspace, repoSlug, prId, headSha}`. Version the payload schema (`v1` field).

# VERIFIED PLATFORM FACTS (confirm each against current docs before writing; correct me if anything changed)

- Bitbucket PR trigger events: `avi:bitbucket:created:pullrequest` and `avi:bitbucket:updated:pullrequest` (NOT `avi:bitbucket:pullrequest:created`). Docs: https://developer.atlassian.com/platform/forge/events-reference/bitbucket/
- PR panel module: `bitbucket:repoPullRequestOverviewPanel`. Docs: https://developer.atlassian.com/platform/forge/manifest-reference/modules/bitbucket-repository-pull-request-overview-panel/
- Merge blocking: `bitbucket:mergeCheck` module. Trigger types include `on-code-pushed` (pre-merge, fires when commits are pushed to the source branch), `on-reviewer-status-changed`, and `on-merge` (integrated into the merge action itself). Subscribe to BOTH `on-code-pushed` and `on-merge` — the first gives invalidation-on-push, the second is the authoritative final gate. Docs: https://developer.atlassian.com/platform/forge/manifest-reference/modules/bitbucket-merge-check/ and https://support.atlassian.com/bitbucket-cloud/docs/set-up-and-use-custom-merge-checks/
- **Required custom merge checks are a Bitbucket Premium feature.** On Free/Standard the check still runs and renders but does NOT block merging. The demo must be narrated accordingly and judge instructions must call this out. Also: Forge apps do not run on personal workspaces — a team workspace is required, and the workspace must be linked to an Atlassian organization.
- Admins must enable the "Custom merge checks" workspace feature and then configure the check as Required at workspace/project/repo level. This is an explicit installation step in PLAN.md.
- Forge trigger delivery can lag up to ~3 minutes. The merge check must therefore never depend on trigger timing: triggers precompute, webtrigger pushes cache verdicts into Gate storage, and the merge check reads only Gate-local state.
- Known pitfall: after a force-push/amend, Bitbucket's commits API can briefly return stale data — prefer the SHA from the event payload over re-listing commits, and use short backoff-retry when fetching diffs for a just-pushed SHA.
- Backend AI analysis uses **Forge LLMs** (`@forge/llm`, `chat()` with structured output) in the Brain app; requires the `llm` module in Brain's manifest. Do NOT claim a Rovo agent runs inside Bitbucket — Rovo agents surface in Jira/Confluence. The optional `rovo:agent` in Brain is a secondary judge-pleasing experience ("ask Ripple why this PR is held"). Docs: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/
- Compass relationships are `DEPENDS_ON`; "consumed by" is a reverse/inward traversal, not a separate edge type. Use the Compass GraphQL toolkit `@atlassian/forge-graphql` (`graphqlGateway.compass.asApp()`) with methods like `getComponent`, `searchComponents`, and relationship queries with direction `INWARD`/`OUTWARD`. Docs: https://developer.atlassian.com/cloud/compass/integrations/use-the-graphql-api-toolkit/
- Teamwork Graph is in Preview. New apps must use **curated queries or persisted Cypher queries** — raw `cypherQuery` is unavailable to new apps. Relevant curated queries include `atlassianUserInTeams`, `atlassianTeamMembers`, `atlassianUserAssignedJiraWorkItems`, `atlassianUserPullRequests`. Docs: https://developer.atlassian.com/platform/teamwork-graph/curated-queries/
- CRITICAL Teamwork Graph gotcha: **missing graph scopes fail silently** — queries succeed but omit data. Empty results must therefore be treated as "unverifiable", never as "does not exist". There are also community reports of `teamsV2` 403s on provisioned demo sites — design a fallback roster and put this in the risk register.
- Teamwork Graph ingestion lag: newly created Jira/Confluence objects can take minutes to appear in the graph. Create demo data BEFORE recording the demo and verify graph hydration.
- Compass config-as-code: a `compass.yml`/`compass.yaml` file in a repo declares the component and its immutable `id` ARI; committing it to the default branch links the repo to the component (requires the Compass Bitbucket app installed on the site). Monorepos can host multiple files in subfolders. Docs: https://developer.atlassian.com/cloud/compass/config-as-code/what-is-config-as-code/

# FOUR HARDENED DESIGN DECISIONS (these resolve known gaps — implement exactly, or argue better with evidence)

## 1. Repo → Compass component binding
Resolution order, first match wins:
1. **Primary — read `compass.yml`/`compass.yaml` from the PR head commit** via Bitbucket REST (`GET /2.0/repositories/{workspace}/{repo_slug}/src/{commit}/compass.yml`, fall back to `.yaml` and known subfolder patterns for monorepos). Parse the `id` ARI directly. In monorepos, map each changed file path to its nearest enclosing `compass.yml` — one PR can implicate multiple components.
2. **Secondary — Compass catalog search**: `searchComponents` and match a `REPOSITORY`-type component link whose URL host+path matches the Bitbucket repo.
3. **Tertiary — manual mapping table** in Brain storage, editable via config.
4. **Unresolved → `NOT_IN_CATALOG` advisory state**: no blast radius computable. Frame it in the UI as a governance gap ("this service isn't cataloged in Compass") — a feature, not an error. Decide and document whether this state blocks or warns for sensitive diffs (recommend: warn, because blocking uncatalogued repos would be noise; but flag the tension explicitly).
Edge cases to spec: compass.yml exists but has no `id` yet (unregistered component); file exists only on default branch but not PR branch (read at head, fall back to default-branch read); multiple compass.yml files implicated by one diff.

## 2. Signoff identity & authorization
- At analysis time, Brain resolves each required-signoff team to a **roster of Atlassian accountIds** using `atlassianTeamMembers` (or the inverse traversal of `atlassianUserInTeams`). The roster is embedded in the verdict payload pushed to Gate.
- When a user clicks "Sign off" in the Bitbucket panel, Gate validates the clicking user's accountId against the pre-resolved roster for that team **locally and deterministically** — no live cross-app call. (⚠️ VERIFY exactly how the Bitbucket panel resolver/UI obtains the acting user's accountId — product context vs `asUser` — and document it.)
- Silent-failure handling: if roster resolution returned empty due to missing scopes or `teamsV2` errors, the verdict payload carries `rosterStatus: DEGRADED`. Policy: any Bitbucket user may then sign, but the UI shows a visible "ownership verification unavailable" warning and the audit record is annotated. Never treat unverifiable as unauthorized-by-default in a way that deadlocks the demo, and never treat it as a silent pass.
- Every signoff record: `{accountId, displayName, teamId, componentId, headSha, timestamp, decision}` — append-only audit, never mutated in place.
- The PR author must not be able to sign off on behalf of a downstream team they don't belong to — but CAN always accept risk for their own change. Make this explicit in the UI copy.

## 3. Re-entrancy & stale-analysis invalidation
- All gate state is keyed by `{workspace, repoSlug, prId, headSha}`.
- The merge check runs on `on-code-pushed` and `on-merge`. On every invocation it compares the payload head SHA with the SHA of the stored analysis:
  - Match + all signoffs present → PASS
  - Match + risk exception recorded → PASS WITH ACCEPTED RISK (message surfaces the Jira ticket key)
  - Match + missing signoffs → FAIL with message naming the outstanding teams
  - Mismatch or no analysis → FAIL as "analysis pending/required" AND trigger (idempotently) a new analysis request to Brain. There is no pass state for an unanalyzed sensitive diff.
- Signoffs and exceptions are bound to a SHA. A new head SHA invalidates them for gating purposes; the audit log is append-only and never deleted.
- Stretch goal (mark as v2, do not implement in v1): carry forward signoffs/exceptions when the new analysis shows an identical affected-component signature.
- Idempotency: event redelivery and double-clicks must be no-ops — dedupe analysis requests on the key, make webtrigger writes upserts, make the accept-risk flow check for an existing ticket key before creating a new one.

## 4. State machine (authoritative — must appear as a table/diagram in BUILD.md)
States: `NO_SENSITIVE_SURFACE` → PASS · `NOT_IN_CATALOG` → warn/advisory · `ANALYSIS_PENDING` → FAIL (temporary) · `ANALYSIS_FAILED` → FAIL with retry path (decide fail-open vs fail-closed for infra errors, justify — recommend fail-closed for sensitive diffs with a documented manual override, because that IS the product's philosophy) · `SIGNOFF_REQUIRED` → FAIL · `RISK_ACCEPTED` → PASS (annotated) · `CLEARED` → PASS.
For each: entry conditions, exit conditions, what the merge check returns, what the panel renders, what the audit log records.

# THE 4-STAGE PIPELINE (mapped onto the two apps)

## Stage 1 — Semantic Diff Classifier (GATE, deterministic)
- PR created/updated triggers + merge-check invocation both feed here.
- Fetch diff via `requestBitbucket`. Rule engine over paths + content: schemas/migrations (`migrations/*.sql`, `schema.prisma`), API specs (`openapi.yaml`, `*.graphql`, `*.proto`), auth/token models (`auth/*`, JWT claims, session middleware), config/env contracts (`.env.example`, `config/*.json`).
- Where feasible, spec-aware deterministic diffing (OpenAPI operation/field/type changes, GraphQL field removal, protobuf tag/field-number changes) — Buf/Optic philosophy: the LLM NEVER decides whether a contract changed.
- No sensitive surface → PASS silently, zero UI noise, no cross-app traffic.

## Stage 2 — Graph Expansion (BRAIN)
- Receives semantic diff summary from Gate (NOT the raw diff — minimize data crossing the trust boundary; decide and justify exactly what diff detail crosses).
- Reverse `DEPENDS_ON` traversal from the implicated component(s); collect downstream consumers, their owners, tiers.
- Teamwork Graph curated queries: team membership/rosters, linked Confluence pages/ADRs, open Jira work where the curated queries permit. Anything needing raw Cypher → flag as a persisted-query registration step in PLAN.md (it has a propagation delay — schedule risk!).

## Stage 3 — Grounded Impact Analyzer (BRAIN, Forge LLMs)
- Input: ONLY the semantic diff summary + retrieved graph facts + ADR excerpts.
- Output: structured JSON — breaking-change likelihood, affected consumers + teams, doc-drift alerts, recommended signoffs, plus a **pre-resolved signoff roster**.
- Validation layer: every entity in LLM output is cross-checked against retrieved graph facts; unverifiable references are dropped or trigger retry. Product claim: "zero ungrounded claims in gate decisions" — never claim literal zero hallucination.
- The LLM explains and classifies. The gate outcome is always deterministic code.

## Stage 4 — Accountability UI + Merge Check (GATE) + Risk Exception (BRAIN)
- Panel: Blast Radius Matrix, per-team signoff status, ADR/doc-drift warnings, next action always obvious.
- Accept Risk → Brain creates Jira issue (exact REST payload in BUILD.md: project, issue type, summary, description with evidence + PR link, assignee/team, due date, labels), stores ticket key, returns it; Gate annotates state; merge check passes with the exception visible.
- Optional judge-pleaser: Rovo agent in Brain answers "why is this PR held?" in Jira/Confluence using the same verdict data.

# COMPETITIVE POSITIONING (informs design, one line each)
- Swimm → docs/runbooks as first-class impacted artifacts (Confluence here)
- Buf/Optic/Speakeasy → deterministic contract diffing, no fuzzy AI verdicts
- Trunk/Graphite → gate UX: state + obvious next action, never a passive dashboard
- Cortex/Port/OpsLevel → service tiers, ownership confidence, criticality weighting
- The moat is NOT the Jira ticket — it's the closed loop: diff evidence → Compass expansion → graph ownership → merge gate → signoff or Jira-backed exception → audit trail.

# DEMO SCENARIO (the plan must build toward exactly this)
Seed Compass with 3 components: `auth-service` consumed by `billing-engine` and `mobile-gateway` (their `DEPENDS_ON` edges point at auth-service), distinct owning teams, one linked Confluence ADR describing the token format, one open Jira epic. The auth-service repo contains a `compass.yml` with the real component ARI.
1. Author opens a PR in the auth-service Bitbucket repo changing the token format.
2. Panel lights up: billing-engine + mobile-gateway affected, owning teams, linked ADR flagged.
3. Merge blocked (Premium workspace). Downstream owner signs off in-panel, OR author clicks "Accept Risk & File Tech Debt" → Jira ticket created → merge unblocks with exception visible.
Also demo the negative control: a typo-fix PR passes silently.
Demo-environment checklist for PLAN.md: team workspace (not personal), workspace linked to Atlassian org, Premium plan or trial, custom merge checks enabled + configured Required, Compass Bitbucket app installed, both Forge apps installed (two installation links), graph hydration verified before recording, backup screen recordings for live-demo failure.

# REQUIRED CONTENTS — PLAN.md
- Executive summary + judging-criteria mapping
- Scope / explicit non-scope
- Prerequisites & environment setup incl. every admin step above
- Phased milestones across 1–2 weeks, half-day granularity: Phase 0 env/scaffold both apps · 1 noise gate + diff ingestion · 2 Compass seed + binding resolution + expansion · 3 Brain LLM analyzer + validation · 4 panel UI + signoff flow · 5 merge check + accept-risk + Jira · 6 Rovo agent (optional stretch) · 7 polish, demo script, video, Devpost submission
- Per phase: tasks, exit criteria, dependencies, parallelization, de-scope fallbacks (define the minimum viable demo explicitly)
- Risk register: two-app install friction, Premium-only blocking, persisted-query propagation delay, teamsV2/demo-site 403s, TWG ingestion lag, trigger latency, force-push staleness, webtrigger security, LLM latency — each with mitigation
- Demo script (narrated, timed, with failure backups)
- Submission checklist per Codegeist requirements

# REQUIRED CONTENTS — BUILD.md
- Architecture overview with mermaid diagrams: the two apps, the webtrigger contract, the state machine, one full sequence diagram (PR opened → verdict cached)
- Monorepo layout: both apps, shared packages (payload schema types, detector rules), two `manifest.yml` files fully annotated with every scope justified
- Complete webtrigger API spec: endpoints, methods, exact JSON payload schemas (v1), auth header format, error codes, idempotency semantics
- Data model: exact Forge storage keys + value schemas in BOTH apps, TTL/cleanup, data-minimization justification
- Stage-by-stage implementation guide: exact function signatures, `@forge/api`/`@atlassian/forge-graphql` calls, exact GraphQL query strings validated against documented schema, Bitbucket REST endpoints with real paths, sample input/output JSON
- Detector rules table: pattern, detection method (path regex / content regex / spec-aware parse), severity weight
- compass.yml parsing + monorepo path-mapping algorithm with pseudocode
- LLM prompt design + validation layer pseudocode + behavior when LLM unavailable (gate correctness must never depend on LLM)
- Accept Risk flow: exact Jira REST calls, payload shape, idempotency
- Security section: webtrigger shared-secret pattern, least-privilege scopes, what data crosses the trust boundary, no secrets in code, Forge egress rules
- Testing strategy: unit tests for detectors/state machine, mock fixtures for Compass/TWG, how to integration-test two apps locally (`forge tunnel` capabilities/limits for webtriggers and merge checks — VERIFY), end-to-end demo-repo test plan
- Seed guide: exact steps/API calls to create the 3 components + relationships + teams + ADR + epic + compass.yml files
- Troubleshooting: scope-mixing deploy error, webtrigger auth, merge check not appearing, Premium gating, graph empty-result debugging

# PROCESS & QUALITY BAR
1. FIRST research current official Atlassian docs (you have web access — use it). Verify every module name, event name, trigger name, scope, endpoint, and GraphQL field. Where uncertain, write `⚠️ VERIFY:` with the specific open question — never invent an API.
2. Every platform-capability claim cites a doc URL inline.
3. Concrete: real file names, real signatures, real query strings — no "implement logic here".
4. Flag Preview features and admin-gated features prominently.
5. Optimize for the hackathon timeline: UI Kit over Custom UI where it saves real time; mock nothing in the core Compass → merge-check → Jira loop (that IS the demo).
6. Write `PLAN.md` first, then `BUILD.md` consistent with it.
7. Self-review pass before finishing: internal consistency, realistic timeline, every platform fact verified or flagged.
