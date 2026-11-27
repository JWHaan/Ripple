# ROLE

You are a principal Atlassian ecosystem engineer and hackathon-winning architect. You have deep, current knowledge of Atlassian Forge, Bitbucket Cloud, the Teamwork Graph, Forge LLMs, Rovo, and Jira Cloud APIs. You write implementation documentation that a solo developer can execute without needing to make any further design decisions.

# MISSION

Create TWO files in this repository:

1. `PLAN.md` — the project execution plan for building the app within a 1–2 week hackathon window
2. `BUILD.md` — the complete technical build guide, detailed enough to implement from without guesswork

These documents are for **Codegeist 2026** (Atlassian's hackathon: https://codegeist2026.devpost.com/). The judging strategy is to go **all-in on native Atlassian platform depth**: Forge, Teamwork Graph, Jira, Forge LLMs/Rovo. Do NOT design a generic tool with an Atlassian wrapper.

> **Design revision (Nov 2026):** the original draft expanded the blast radius through the Compass service catalog. Compass was dropped. Ripple now declares dependencies in a `ripple.yml` file (service Jira space + downstream Jira space keys) and resolves ownership of each space through the **Teamwork Graph** (`atlassianTeamsBySpace` → `atlassianTeamMembers`, with Jira project-lead fallbacks). This prompt reflects the revised design; the code in `apps/` is authoritative where they differ.

# THE PRODUCT: "Ripple" — Pre-Merge Blast Radius & Accountability Gate

Ripple runs on Bitbucket Cloud pull requests. It answers one question: **"What else could this PR break, who needs to know, and what must be updated before we merge?"**

It is NOT a dependency graph visualizer and NOT generic AI code review. It is a **pre-merge impact and accountability workflow**:

1. Detect when a PR touches cross-cutting architectural surfaces (not typo fixes).
2. Expand the blast radius from the repo's `ripple.yml` (the downstream Jira spaces that consume this service) and resolve who owns each downstream space through the Teamwork Graph — owning teams and their members.
3. Generate a grounded impact analysis using Atlassian-hosted LLMs.
4. Block merge via a custom merge check until every affected downstream owner signs off — OR the author explicitly accepts risk, which auto-creates a linked Jira tech-debt ticket with owner, due date, and PR linkage, then unblocks merge.

Motivating example: a PR changing an auth token format looks small in the diff but can affect the mobile client, internal APIs, reporting jobs, a security runbook in Confluence, a Jira migration epic, and two other teams' services. Ripple surfaces all of that BEFORE merge and makes the resolution accountable.

# CRITICAL ARCHITECTURE CONSTRAINT: THIS MUST BE TWO FORGE APPS

This is a hard platform constraint discovered through research, and getting it wrong invalidates the entire design. You MUST verify it independently and design around it:

- A single Forge app **cannot hold Bitbucket workspace scopes and Jira/Teamwork-Graph site scopes in the same manifest**. `forge deploy` fails with: `"Workspace scopes can not be used with site scopes"`.
- `requestJira` is rejected from a Bitbucket installation context ("Request jira is not allowed from bitbucket context"). The same applies to Teamwork Graph access, which requires site scopes.
- Multi-product app compatibility currently covers **Jira + Confluence only** — Bitbucket is excluded (org-linking of workspaces, CHANGE-2776 effective March 2026, is laying groundwork but cross-product Bitbucket apps are not generally available).
- Other Codegeist 2026 entrants solve this exact problem with a **two-app architecture communicating via Forge web triggers** — see github.com/vigohan95/merge-policy-gate and merge-gate-explainer for a working precedent. Community consensus is that two installation links in one submission are acceptable, but flag this as `⚠️ VERIFY` against the official rules.

Therefore Ripple is two apps sharing one repository (monorepo, two manifests, two app IDs):

## App 1 — "Ripple Gate" (Bitbucket workspace app)
- Modules: `bitbucket:repoPullRequestOverviewPanel`, `bitbucket:mergeCheck`, `trigger` (PR events), `webtrigger` (receives analysis results pushed by Brain), function modules, storage.
- Scopes: `read:pullrequest:bitbucket`, `read:repository:bitbucket`, `storage:app` — workspace scopes ONLY, never site scopes.
- Responsibilities: fetch diffs via Bitbucket REST, run the deterministic noise-gate classifier, read the `ripple.yml` service declaration, render the PR panel, run the merge check state machine, validate signoff clicks against the pre-resolved roster, store gate state in its own Forge storage.
- NEVER calls Jira, Teamwork Graph, or any site-scoped API.

## App 2 — "Ripple Brain" (site app, installed on the Atlassian cloud site with Jira)
- Modules: `webtrigger` endpoints (the inter-app API), `llm` module for Forge LLMs, optional `rovo:agent` for judge-facing conversational follow-up in Jira/Confluence, optional scheduled trigger for cleanup, storage.
- Scopes: `read:graph:project:jira`, `read:graph:team:atlassian`, `read:graph:user:atlassian` (all with `allowImpersonation: true`, because Teamwork Graph is user-only), `read:jira-work`, `write:jira-work`, `storage:app`.
- Responsibilities: resolve each downstream Jira space (key → id, name, lead), Teamwork Graph ownership resolution (space → owning teams → members, acting as the PR author), Forge LLM grounded analysis + validation layer, signoff roster resolution, Jira tech-debt ticket creation.
- NEVER holds Bitbucket workspace scopes.

## Inter-app contract (the nerve center — must be fully specified in BUILD.md)
- Brain exposes webtrigger endpoints; Gate calls them with signed payloads:
  - `POST /analyze` — Gate → Brain: semantic diff summary, the `ripple.yml` service declaration, PR metadata keyed by `{workspace, repoSlug, prId, headSha}`. Idempotent on that key.
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
- Teamwork Graph is in Preview. New apps must use **curated queries or persisted Cypher queries** — raw `cypherQuery` is unavailable to new apps. Ripple uses `atlassianTeamsBySpace` (teams linked to a Jira space, by space ARI `ari:cloud:jira:{cloudId}:project/{id}`), `atlassianUserInTeams` and `atlassianTeamMembers`. Curated queries reject page sizes above 25. Docs: https://developer.atlassian.com/platform/teamwork-graph/curated-queries/
- Teamwork Graph has **no app-level access**: calls go through `api.asUser(accountId).requestTeamworkGraph(query, variables)`, so the scopes need `allowImpersonation: true` and the async worker impersonates the PR author. GraphQL operation names must look like `company_operation` (Ripple uses `ripple_teamsBySpace`, `ripple_userInTeams`, `ripple_teamMembers`).
- CRITICAL Teamwork Graph gotcha: **missing graph scopes fail silently** — queries succeed but omit data. Empty results must therefore be treated as "unverifiable", never as "does not exist". There are also community reports of `teamsV2` 403s on provisioned demo sites — design a fallback roster and put this in the risk register.
- Teamwork Graph ingestion lag: newly created Jira/Confluence objects can take minutes to appear in the graph. Create demo data BEFORE recording the demo and verify graph hydration.
- Dependencies as code: a `ripple.yml`/`ripple.yaml` file at the repository root declares the service, its Jira space, and the Jira spaces downstream of it:
  ```yaml
  service:
    id: auth-service
    jiraSpaceKey: PLAT
  downstream: [MPLAT, MOB, SECOPS]
  ```

# FOUR HARDENED DESIGN DECISIONS (these resolve known gaps — implement exactly, or argue better with evidence)

## 1. Repo → service declaration (`ripple.yml`)
Resolution order, first match wins:
1. **Primary — read `ripple.yml`/`ripple.yaml` from the PR's DESTINATION branch commit** via Bitbucket REST (`GET /2.0/repositories/{workspace}/{repo_slug}/src/{commit}/ripple.yml`). Reading the destination first means a PR cannot shrink its own blast radius by editing the file.
2. **Secondary — the PR head commit**, only when the destination branch has no declaration yet (the PR that introduces Ripple to a repository).
3. **Unresolved → `NOT_IN_CATALOG` advisory state**: no blast radius computable. Frame it in the UI as a governance gap ("this repository declares no downstream dependencies") — a feature, not an error. It warns rather than blocks, because blocking undeclared repos would be noise.
Edge cases: a declaration that exists but is invalid (bad YAML, a value that is not a Jira space key) fails closed and is never treated as "no declaration"; the service's own space is never downstream of itself; duplicates are dropped; at most 25 downstream spaces.

## 1b. Ownership of a downstream space (deterministic, tiered)
For each downstream Jira space, Brain resolves the key to its id, name and project lead (Jira REST, as the app), then:
1. `SPACE_TEAM` — teams linked to the space in the Teamwork Graph (`atlassianTeamsBySpace`).
2. `LEAD_TEAM` — no linked team → the project lead's team (`atlassianUserInTeams`, first team only; inferred and weaker).
3. `LEAD_ONLY` — no team at all → the project lead alone.
4. `UNRESOLVED` — no lead either.
The signoff roster is the project lead plus the members of the owning teams (`atlassianTeamMembers`).

## 2. Signoff identity & authorization
- At analysis time, Brain resolves each required-signoff team to a **roster of Atlassian accountIds** using `atlassianTeamMembers` (or the inverse traversal of `atlassianUserInTeams`). The roster is embedded in the verdict payload pushed to Gate.
- When a user clicks "Sign off" in the Bitbucket panel, Gate validates the clicking user's accountId against the pre-resolved roster for that team **locally and deterministically** — no live cross-app call. (⚠️ VERIFY exactly how the Bitbucket panel resolver/UI obtains the acting user's accountId — product context vs `asUser` — and document it.)
- Silent-failure handling: if roster resolution returned empty due to missing scopes or `teamsV2` errors, the verdict payload carries `rosterStatus: DEGRADED`. Policy: any Bitbucket user may then sign, but the UI shows a visible "ownership verification unavailable" warning and the audit record is annotated. Never treat unverifiable as unauthorized-by-default in a way that deadlocks the demo, and never treat it as a silent pass.
- Every signoff record: `{accountId, displayName, teamId, spaceKey, headSha, timestamp, decision}` — append-only audit, never mutated in place.
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
States: `NO_SENSITIVE_SURFACE` → PASS · `NOT_IN_CATALOG` (no `ripple.yml`) → PASS with advisory · `ANALYSIS_PENDING` → FAIL (temporary) · `ANALYSIS_FAILED` → FAIL with retry path (decide fail-open vs fail-closed for infra errors, justify — recommend fail-closed for sensitive diffs with a documented manual override, because that IS the product's philosophy) · `SIGNOFF_REQUIRED` → FAIL · `RISK_ACCEPTED` → PASS (annotated) · `CLEARED` → PASS.
For each: entry conditions, exit conditions, what the merge check returns, what the panel renders, what the audit log records.

# THE 4-STAGE PIPELINE (mapped onto the two apps)

## Stage 1 — Semantic Diff Classifier (GATE, deterministic)
- PR created/updated triggers + merge-check invocation both feed here.
- Fetch diff via `requestBitbucket`. Rule engine over paths + content: schemas/migrations (`migrations/*.sql`, `schema.prisma`), API specs (`openapi.yaml`, `*.graphql`, `*.proto`), auth/token models (`auth/*`, JWT claims, session middleware), config/env contracts (`.env.example`, `config/*.json`).
- Where feasible, spec-aware deterministic diffing (OpenAPI operation/field/type changes, GraphQL field removal, protobuf tag/field-number changes) — Buf/Optic philosophy: the LLM NEVER decides whether a contract changed.
- No sensitive surface → PASS silently, zero UI noise, no cross-app traffic.

## Stage 2 — Graph Expansion (BRAIN)
- Receives semantic diff summary from Gate (NOT the raw diff — minimize data crossing the trust boundary; decide and justify exactly what diff detail crosses).
- Take the downstream Jira spaces from the `ripple.yml` declaration Gate sent; resolve each space (key → id, name, lead) through Jira REST.
- Teamwork Graph curated queries, acting as the PR author: owning teams per space (`atlassianTeamsBySpace`), the lead's teams as a fallback (`atlassianUserInTeams`), and team members for the roster (`atlassianTeamMembers`). Curated queries only — no raw Cypher, so no persisted-query registration delay.

## Stage 3 — Grounded Impact Analyzer (BRAIN, Forge LLMs)
- Input: ONLY the semantic diff summary + the declared service + the resolved downstream spaces and owners.
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
- The moat is NOT the Jira ticket — it's the closed loop: diff evidence → `ripple.yml` downstream spaces → Teamwork Graph ownership → merge gate → signoff or Jira-backed exception → audit trail.

# DEMO SCENARIO (the plan must build toward exactly this)
Seed Jira with the service space (`PLAT`, auth-service) and downstream spaces (e.g. `MPLAT`, `MOB`, `SECOPS`), each with a project lead; link distinct Atlassian teams to the downstream spaces so the Teamwork Graph returns them. The demo repo (`ripple-demo-service`) contains a `ripple.yml` on its default branch naming those spaces.
1. Author opens a PR in the demo repo changing the token format.
2. Panel lights up: the downstream spaces, their owning teams (and how ownership was resolved), and who may sign.
3. Merge blocked (Premium workspace). Downstream owner signs off in-panel, OR author clicks "Accept Risk & File Tech Debt" → Jira ticket created → merge unblocks with exception visible.
Also demo the negative control: a typo-fix PR passes silently.
Demo-environment checklist for PLAN.md: team workspace (not personal), workspace linked to Atlassian org, Premium plan or trial, custom merge checks enabled + configured Required, teams linked to the downstream Jira spaces, both Forge apps installed (two installation links), graph hydration verified before recording, backup screen recordings for live-demo failure.

# REQUIRED CONTENTS — PLAN.md
- Executive summary + judging-criteria mapping
- Scope / explicit non-scope
- Prerequisites & environment setup incl. every admin step above
- Phased milestones across 1–2 weeks, half-day granularity: Phase 0 env/scaffold both apps · 1 noise gate + diff ingestion · 2 Jira/team seed + `ripple.yml` resolution + Teamwork Graph ownership · 3 Brain LLM analyzer + validation · 4 panel UI + signoff flow · 5 merge check + accept-risk + Jira · 6 Rovo agent (optional stretch) · 7 polish, demo script, video, Devpost submission
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
- `ripple.yml` parsing + destination-branch-first resolution with pseudocode
- LLM prompt design + validation layer pseudocode + behavior when LLM unavailable (gate correctness must never depend on LLM)
- Accept Risk flow: exact Jira REST calls, payload shape, idempotency
- Security section: webtrigger shared-secret pattern, least-privilege scopes, what data crosses the trust boundary, no secrets in code, Forge egress rules
- Testing strategy: unit tests for detectors/state machine, mock fixtures for Jira/TWG, how to integration-test two apps locally (`forge tunnel` capabilities/limits for webtriggers and merge checks — VERIFY), end-to-end demo-repo test plan
- Seed guide: exact steps to create the Jira spaces, leads, teams linked to spaces, and the demo repo's `ripple.yml`
- Troubleshooting: scope-mixing deploy error, webtrigger auth, merge check not appearing, Premium gating, graph empty-result debugging

# PROCESS & QUALITY BAR
1. FIRST research current official Atlassian docs (you have web access — use it). Verify every module name, event name, trigger name, scope, endpoint, and GraphQL field. Where uncertain, write `⚠️ VERIFY:` with the specific open question — never invent an API.
2. Every platform-capability claim cites a doc URL inline.
3. Concrete: real file names, real signatures, real query strings — no "implement logic here".
4. Flag Preview features and admin-gated features prominently.
5. Optimize for the hackathon timeline: UI Kit over Custom UI where it saves real time; mock nothing in the core `ripple.yml` → Teamwork Graph → merge-check → Jira loop (that IS the demo).
6. Write `PLAN.md` first, then `BUILD.md` consistent with it.
7. Self-review pass before finishing: internal consistency, realistic timeline, every platform fact verified or flagged.
