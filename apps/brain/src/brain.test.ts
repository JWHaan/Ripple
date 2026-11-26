import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRAIN_ROUTES,
  analyzeRequestSchema,
  analyzeResponseSchema,
  decodeJson,
  ok,
  signRequest,
  verdictSchema,
  type AnalyzeRequest,
  type CompleteVerdict,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { fixtureText } from '@ripple/contracts/fixtures';
import { buildRiskIssue } from './decisions.ts';
import { validateNarrative } from './narrative.ts';
import { resolveOwnership } from './ownership.ts';
import { handleBrainRequest } from './router.ts';
import { APP_LEAD, APP_TEAM, AUTHOR, MIA, MO, MOBILE_TEAM, TEST_KEY, brainHarness, demoSite, person, space, type BrainHarness } from './testing/fakes.ts';
import { ANALYSIS_STUCK_MS } from './types.ts';
import { runAnalysisJob } from './worker.ts';

function analyzeRequest(change: (request: AnalyzeRequest) => AnalyzeRequest = (r) => r): AnalyzeRequest {
  const decoded = decodeJson(analyzeRequestSchema, fixtureText('analyze-request'));
  assert.ok(decoded.ok);
  return change(decoded.value);
}

function call(h: BrainHarness, path: string, payload: object, key = TEST_KEY): Promise<WebTriggerResponseShape> {
  const body = JSON.stringify(payload);
  const headers = signRequest({ method: 'POST', path, body }, key, h.clock.now.getTime());
  return handleBrainRequest(h.deps, { method: 'POST', userPath: path, headers, body });
}

async function analyse(h: BrainHarness, request = analyzeRequest()) {
  await call(h, BRAIN_ROUTES.analyze, request);
  const outcome = await runAnalysisJob(h.deps, request.key);
  assert.ok(outcome.kind === 'DONE');
  // Whatever the worker produced must itself satisfy the wire contract.
  const decoded = decodeJson(verdictSchema, JSON.stringify(outcome.verdict));
  assert.equal(decoded.ok, true, decoded.ok ? '' : decoded.error.message);
  return outcome;
}

// --- router ------------------------------------------------------------------

test('router: a signed analyze request is stored, enqueued once and answered 202 ACCEPTED', async () => {
  const h = brainHarness();
  const request = analyzeRequest();
  const first = await call(h, BRAIN_ROUTES.analyze, request);
  assert.equal(first.statusCode, 202);
  const decoded = decodeJson(analyzeResponseSchema, first.body);
  assert.ok(decoded.ok && decoded.value.state === 'ACCEPTED');
  assert.deepEqual(decodeJson(analyzeResponseSchema, fixtureText('analyze-response-accepted')), decoded);

  const second = await call(h, BRAIN_ROUTES.analyze, request);
  assert.equal(JSON.parse(second.body).state, 'IN_PROGRESS');
  assert.deepEqual(h.queue.jobs, [request.key]);
});

test('router: unsigned, forged, malformed and unknown-route requests are refused and nothing is queued', async () => {
  const h = brainHarness();
  const request = analyzeRequest();
  const unsigned = await handleBrainRequest(h.deps, { method: 'POST', userPath: BRAIN_ROUTES.analyze, body: JSON.stringify(request) });
  const forged = await call(h, BRAIN_ROUTES.analyze, request, { id: 'test', secret: 'z'.repeat(64) });
  const malformed = await call(h, BRAIN_ROUTES.analyze, { ...request, key: { ...request.key, headSha: 'abc123' } });
  const unknown = await call(h, '/v1/nope', request);
  assert.deepEqual([unsigned.statusCode, forged.statusCode, malformed.statusCode, unknown.statusCode], [401, 401, 400, 404]);
  assert.equal(h.queue.jobs.length, 0);

  h.queue.failure = 'rate limited';
  assert.equal((await call(h, BRAIN_ROUTES.analyze, request)).statusCode, 500);
});

test('router: a finished analysis is returned inline; stuck or retryable-failed ones are re-queued', async () => {
  const h = brainHarness();
  const request = analyzeRequest();
  await analyse(h, request);
  assert.equal(JSON.parse((await call(h, BRAIN_ROUTES.analyze, request)).body).state, 'COMPLETE');
  assert.equal(h.queue.jobs.length, 1);
  assert.equal(JSON.parse((await call(h, BRAIN_ROUTES.verdict, { v: 'v1', key: request.key })).body).state, 'COMPLETE');

  const stuck = brainHarness();
  await call(stuck, BRAIN_ROUTES.analyze, request);
  stuck.clock.now = new Date(stuck.clock.now.getTime() + ANALYSIS_STUCK_MS + 1);
  assert.equal((await call(stuck, BRAIN_ROUTES.analyze, request)).statusCode, 202);

  const flaky = brainHarness();
  flaky.spaces.failure = { kind: 'UNAVAILABLE', message: 'HTTP 503' };
  await analyse(flaky, request);
  flaky.spaces.failure = null;
  assert.equal((await call(flaky, BRAIN_ROUTES.analyze, request)).statusCode, 202);
});

// --- ownership tiers ---------------------------------------------------------

test('ownership: SPACE_TEAM when the graph links a team; roster is lead plus team members', async () => {
  const { spaces, graph } = demoSite();
  const resolved = await resolveOwnership(graph, spaces.spaces.get(space('MPLAT'))!);
  assert.deepEqual(resolved.ownership, { source: 'SPACE_TEAM', teams: [MOBILE_TEAM], lead: MO });
  assert.deepEqual(resolved.roster, { status: 'VERIFIED', members: [MO, MIA] });
});

test('ownership: LEAD_TEAM falls back to the project lead and only their first team', async () => {
  const { spaces, graph } = demoSite();
  const resolved = await resolveOwnership(graph, spaces.spaces.get(space('MOB'))!);
  assert.deepEqual([resolved.ownership.source, resolved.ownership.teams], ['LEAD_TEAM', [APP_TEAM]]);
  assert.ok(resolved.roster.status === 'VERIFIED');
  assert.deepEqual(resolved.roster.members.map((m) => m.displayName), ['Ana Lead', 'Avi Dev']);
});

test('ownership: LEAD_ONLY when the lead has no team or the graph fails; UNRESOLVED without a lead', async () => {
  const { spaces, graph } = demoSite();
  graph.userTeams.clear();
  const leadOnly = await resolveOwnership(graph, spaces.spaces.get(space('MOB'))!);
  assert.deepEqual([leadOnly.ownership.source, leadOnly.roster], ['LEAD_ONLY', { status: 'VERIFIED', members: [APP_LEAD] }]);

  graph.failure = { kind: 'NO_ACTOR', message: 'no pull request author to act as' };
  const noGraph = await resolveOwnership(graph, spaces.spaces.get(space('MPLAT'))!);
  assert.deepEqual([noGraph.ownership.source, noGraph.roster], ['LEAD_ONLY', { status: 'VERIFIED', members: [MO] }]);

  const orphan = await resolveOwnership(graph, spaces.spaces.get(space('PLAT'))!);
  assert.deepEqual([orphan.ownership.source, orphan.roster], ['UNRESOLVED', { status: 'DEGRADED', reason: 'GRAPH_ERROR' }]);
  graph.failure = null;
  assert.deepEqual((await resolveOwnership(graph, spaces.spaces.get(space('PLAT'))!)).roster, { status: 'DEGRADED', reason: 'EMPTY_RESULT' });
});

// --- worker ------------------------------------------------------------------

test('worker: every declared downstream space requires sign-off, with its resolved owners', async () => {
  const h = brainHarness();
  const { verdict, pushed } = await analyse(h);
  assert.ok(verdict.status === 'COMPLETE');
  assert.deepEqual(verdict.impacted.map((s) => [s.spaceKey, s.name]), [['MPLAT', 'Mobile Platform'], ['MOB', 'Mobile Application']]);
  assert.deepEqual(
    verdict.signoffRequirements.map((r) => [r.spaceKey, r.ownership.source, r.roster.status]),
    [['MPLAT', 'SPACE_TEAM', 'VERIFIED'], ['MOB', 'LEAD_TEAM', 'VERIFIED']],
  );
  assert.equal(pushed, true);
  assert.deepEqual(h.gate.pushed, [verdict]);
  const stored = await h.store.getAnalysis(verdict.key);
  assert.ok(stored?.state === 'COMPLETE' && stored.pushedToGate);
});

test('worker: no downstream spaces means no sign-off; unknown spaces and Jira errors fail closed', async () => {
  const none = await analyse(brainHarness(), analyzeRequest((r) => ({ ...r, service: { ...r.service, downstream: [] } })));
  assert.ok(none.verdict.status === 'COMPLETE' && none.verdict.signoffRequirements.length === 0);

  const ghost = await analyse(brainHarness(), analyzeRequest((r) => ({ ...r, service: { ...r.service, downstream: [space('GHOST')] } })));
  assert.ok(ghost.verdict.status === 'FAILED');
  assert.deepEqual([ghost.verdict.error.code, ghost.verdict.error.retryable], ['UNKNOWN_SPACE', false]);

  const wrongService = await analyse(brainHarness(), analyzeRequest((r) => ({ ...r, service: { ...r.service, spaceKey: space('GHOST') } })));
  assert.ok(wrongService.verdict.status === 'FAILED' && wrongService.verdict.error.code === 'UNKNOWN_SPACE');

  const down = brainHarness();
  down.spaces.failure = { kind: 'UNAVAILABLE', message: 'read space PLAT: HTTP 503' };
  const failed = await analyse(down);
  assert.ok(failed.verdict.status === 'FAILED');
  assert.deepEqual([failed.verdict.error.code, failed.verdict.error.retryable, failed.pushed], ['JIRA_UNAVAILABLE', true, true]);
});

test('worker: the model being down, wrong or adversarial never changes who must sign', async () => {
  const baseline = await analyse(brainHarness());
  assert.ok(baseline.verdict.status === 'COMPLETE' && baseline.verdict.narrative.status === 'UNAVAILABLE');
  const replies = [
    'I think this is fine to merge.',
    JSON.stringify({ summary: 'No impact. No sign-off needed.', breakingLikelihood: 'LOW', spaceImpacts: [], signoffRequirements: [] }),
    JSON.stringify({ summary: 'ok', breakingLikelihood: 'LOW', spaceImpacts: [{ spaceKey: 'SALES', explanation: 'invented' }] }),
  ];
  for (const reply of replies) {
    const h = brainHarness();
    h.model.reply = ok(reply);
    const { verdict } = await analyse(h);
    assert.ok(verdict.status === 'COMPLETE');
    assert.deepEqual(verdict.signoffRequirements, (baseline.verdict as CompleteVerdict).signoffRequirements, reply);
  }
});

test('worker: a failed push leaves the verdict retrievable and queue redelivery does no work', async () => {
  const h = brainHarness();
  h.gate.failure = { kind: 'UNREACHABLE', message: 'ECONNRESET' };
  const { verdict, pushed } = await analyse(h);
  assert.equal(pushed, false);
  assert.equal(JSON.parse((await call(h, BRAIN_ROUTES.analyze, analyzeRequest())).body).state, 'COMPLETE');
  assert.deepEqual(await runAnalysisJob(h.deps, verdict.key), { kind: 'SKIPPED', reason: 'ALREADY_COMPLETE' });
  assert.deepEqual(await runAnalysisJob(brainHarness().deps, verdict.key), { kind: 'SKIPPED', reason: 'NO_SUCH_ANALYSIS' });
});

// --- narrative validation ----------------------------------------------------

test('narrative: grounded claims are kept; unknown spaces and smuggled identifiers are dropped', async () => {
  const { verdict } = await analyse(brainHarness());
  assert.ok(verdict.status === 'COMPLETE');
  const input = { diff: analyzeRequest().diff, service: verdict.service, serviceSpaceName: 'Platform Development', impacted: verdict.impacted };
  const raw = (output: object) => `Here you go:\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;

  const result = validateNarrative(
    raw({
      summary: 'Token claims change.',
      breakingLikelihood: 'HIGH',
      spaceImpacts: [
        { spaceKey: 'MPLAT', explanation: 'validates claims' },
        { spaceKey: 'SALES', explanation: 'not a consumer' },
        { spaceKey: 'PLAT', explanation: 'the changed service itself is not impacted' },
        { spaceKey: 'MOB', explanation: `ask ${person('712020:93c2ce4f-41dd-44ad-bbb9-ccec58ad7112').accountId}` },
      ],
    }),
    input,
  );
  assert.ok(result.narrative.status === 'GROUNDED');
  assert.deepEqual(result.narrative.spaceImpacts, [{ spaceKey: 'MPLAT', explanation: 'validates claims' }]);
  assert.deepEqual(result.dropped.map((d) => d.kind), ['UNKNOWN_SPACE', 'UNKNOWN_SPACE', 'UNGROUNDED_REFERENCE']);

  for (const bad of ['not json', raw({ summary: 'x' }), raw({ summary: 'see ari:cloud:identity::team/abc', breakingLikelihood: 'LOW', spaceImpacts: [] })]) {
    assert.deepEqual(validateNarrative(bad, input).narrative, { status: 'UNAVAILABLE', reason: 'VALIDATION_REJECTED' });
  }
});

// --- sign-off and accept-risk -------------------------------------------------

const KEY = analyzeRequest().key;
const signoff = (h: BrainHarness, spaceKey: string, actor: { accountId: string; displayName: string }) =>
  call(h, BRAIN_ROUTES.signoff, { v: 'v1', key: KEY, spaceKey, actor }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
const acceptRisk = (h: BrainHarness, actor: { accountId: string; displayName: string }, justification = 'Hotfix for a production incident; consumers notified in #platform.') =>
  call(h, BRAIN_ROUTES.acceptRisk, { v: 'v1', key: KEY, actor, justification, dueDate: '2026-12-10' }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

test('sign-off: a roster member is recorded and pushed to Gate with the name Brain resolved', async () => {
  const h = brainHarness();
  await analyse(h);
  const result = await signoff(h, 'MPLAT', { accountId: MIA.accountId, displayName: 'spoofed name' });
  assert.deepEqual([result.body.outcome, result.body.gateState], ['RECORDED', 'SIGNOFF_REQUIRED']);
  const [decision] = h.gate.decisions;
  assert.ok(decision?.type === 'SIGNOFF');
  assert.deepEqual([decision.spaceKey, decision.signer, decision.authorization], ['MPLAT', MIA, 'ROSTER_MEMBER']);
});

test('sign-off: the PR author is refused even when they are on the roster (anti-rubber-stamping)', async () => {
  const h = brainHarness();
  h.graph.members.set(MOBILE_TEAM.teamAri, [MO, MIA, AUTHOR]);
  const { verdict } = await analyse(h);
  assert.ok(verdict.status === 'COMPLETE' && verdict.signoffRequirements[0]?.roster.status === 'VERIFIED');
  assert.ok(verdict.signoffRequirements[0].roster.members.some((m) => m.accountId === AUTHOR.accountId), 'author really is on the roster');
  assert.equal((await signoff(h, 'MPLAT', AUTHOR)).body.reason, 'AUTHOR_CANNOT_SIGN');

  // ...and also when the roster is degraded and would otherwise accept anyone.
  const degraded = brainHarness();
  degraded.spaces.spaces.clear();
  degraded.spaces.add('PLAT', 'Platform Development').add('MPLAT', 'Mobile Platform').add('MOB', 'Mobile Application');
  degraded.graph.spaceTeams.clear();
  await analyse(degraded);
  assert.equal((await signoff(degraded, 'MPLAT', AUTHOR)).body.reason, 'AUTHOR_CANNOT_SIGN');
  const stranger = await signoff(degraded, 'MPLAT', person('712020:someone', 'Some One'));
  assert.equal(stranger.body.outcome, 'RECORDED');
  assert.ok(degraded.gate.decisions[0]?.type === 'SIGNOFF' && degraded.gate.decisions[0].authorization === 'UNVERIFIED_ROSTER_DEGRADED');
  assert.equal(h.gate.decisions.length, 0);
});

test('sign-off: unknown author, non-members, unrequired spaces and unfinished analyses are refused', async () => {
  const h = brainHarness();
  await analyse(h);
  assert.equal((await signoff(h, 'MPLAT', person('712020:outsider'))).body.reason, 'NOT_ON_ROSTER');
  assert.equal((await signoff(h, 'MOB', MIA)).body.reason, 'NOT_ON_ROSTER', 'a member of one space cannot sign for another');
  assert.equal((await signoff(h, 'SALES', MIA)).body.reason, 'SPACE_NOT_REQUIRED');

  const anonymous = brainHarness();
  await analyse(anonymous, analyzeRequest((r) => ({ ...r, pullRequest: { ...r.pullRequest, authorAccountId: null } })));
  assert.equal((await signoff(anonymous, 'MPLAT', MIA)).body.reason, 'AUTHOR_UNKNOWN');

  const pending = brainHarness();
  await call(pending, BRAIN_ROUTES.analyze, analyzeRequest());
  assert.equal((await signoff(pending, 'MPLAT', MIA)).body.reason, 'ANALYSIS_NOT_COMPLETE');
  assert.equal(h.gate.decisions.length + anonymous.gate.decisions.length + pending.gate.decisions.length, 0);
});

test('sign-off: Gate refusing the push is reported, never swallowed', async () => {
  const h = brainHarness();
  await analyse(h);
  h.gate.decisionReply = (d) => ok({ v: 'v1', key: d.key, outcome: 'STALE_SHA' });
  assert.equal((await signoff(h, 'MPLAT', MIA)).body.reason, 'STALE_HEAD');
  h.gate.decisionReply = () => ({ ok: false, error: { kind: 'UNREACHABLE', message: 'ECONNRESET' } });
  const down = await signoff(h, 'MPLAT', MIA);
  assert.deepEqual([down.status, down.body.error.code], [502, 'GATE_PUSH_FAILED']);
});

test('accept-risk: the author files exactly one Jira ticket per commit and Gate is told', async () => {
  const h = brainHarness();
  await analyse(h);
  const first = await acceptRisk(h, AUTHOR);
  assert.deepEqual([first.body.outcome, first.body.ticket.issueKey, first.body.created, first.body.gateState], ['RECORDED', 'RISK-1', true, 'RISK_ACCEPTED']);
  const again = await acceptRisk(h, AUTHOR);
  assert.deepEqual([again.body.ticket.issueKey, again.body.created], ['RISK-1', false]);
  assert.equal(h.tickets.created.length, 1);

  const [issue] = h.tickets.created;
  assert.ok(issue);
  assert.deepEqual([issue.fields.project.key, issue.fields.duedate], ['RISK', '2026-12-10']);
  assert.ok(issue.fields.labels.includes('ripple-accepted-risk'));
  const description = JSON.stringify(issue.fields.description);
  for (const expected of ['Hotfix for a production incident', 'pull request author', 'MPLAT', 'MOB', KEY.headSha, 'pull-requests/7']) assert.ok(description.includes(expected), expected);
  const decision = h.gate.decisions[0];
  assert.ok(decision?.type === 'RISK_ACCEPTED' && decision.acceptedAs === 'PR_AUTHOR' && decision.ticket.issueKey === 'RISK-1');

  // The local record is lost: the label search still finds the ticket instead of filing a second one.
  h.store.exceptions.clear();
  assert.deepEqual([(await acceptRisk(h, AUTHOR)).body.created, h.tickets.created.length], [false, 1]);
});

test('accept-risk: only the author or the service-space lead may accept; justification is mandatory', async () => {
  const h = brainHarness();
  h.spaces.add('PLAT', 'Platform Development', person('712020:plat-lead', 'Pat Lead'));
  await analyse(h);
  assert.equal((await acceptRisk(h, MIA)).body.reason, 'NOT_AUTHORIZED');
  assert.equal((await acceptRisk(h, MO)).body.reason, 'NOT_AUTHORIZED', 'a downstream lead cannot waive their own sign-off for the author');
  assert.equal((await acceptRisk(h, AUTHOR, 'too short')).status, 400);
  assert.equal((await acceptRisk(h, AUTHOR, ' '.repeat(40))).status, 400);
  assert.equal(h.tickets.created.length, 0);
  const lead = await acceptRisk(h, person('712020:plat-lead', 'Pat Lead'));
  assert.equal(lead.body.outcome, 'RECORDED');
  assert.ok(h.gate.decisions[0]?.type === 'RISK_ACCEPTED' && h.gate.decisions[0].acceptedAs === 'SERVICE_LEAD');
});

test('accept-risk: no ticket means no override; nothing to accept when no sign-off is required', async () => {
  const h = brainHarness();
  await analyse(h);
  h.tickets.configured = false;
  const unconfigured = await acceptRisk(h, AUTHOR);
  assert.deepEqual([unconfigured.status, unconfigured.body.error.code], [502, 'JIRA_FAILED']);
  h.tickets.configured = true;
  h.tickets.failure = { kind: 'FORBIDDEN', message: 'create risk ticket: HTTP 403' };
  assert.equal((await acceptRisk(h, AUTHOR)).status, 502);
  assert.equal(h.gate.decisions.length, 0);

  const advisory = brainHarness();
  await analyse(advisory, analyzeRequest((r) => ({ ...r, service: { ...r.service, downstream: [] } })));
  assert.equal((await acceptRisk(advisory, AUTHOR)).body.reason, 'WRONG_STATE');
  void buildRiskIssue;
});
