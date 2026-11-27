/**
 * Wire-contract test across both apps: Gate's real client code talks to Brain's real
 * router and vice versa, over an in-memory transport that carries only what HTTP would
 * (URL, headers, body). Everything else — storage, Bitbucket, Compass, the model — is faked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRAIN_ROUTES,
  GATE_ROUTES,
  acceptRiskResponseSchema,
  analyzeResponseSchema,
  decisionPushResponseSchema,
  signoffResponseSchema,
  signedCall,
  verdictPushResponseSchema,
  type HttpPost,
  type SigningKey,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { handleBrainRequest } from '../apps/brain/src/router.ts';
import { AUTHOR, MIA, MO, brainHarness } from '../apps/brain/src/testing/fakes.ts';
import { runAnalysisJob } from '../apps/brain/src/worker.ts';
import { requestAcceptRisk, requestSignoff } from '../apps/gate/src/actions.ts';
import { evaluateMergeCheck } from '../apps/gate/src/merge-check.ts';
import { handlePullRequestEvent } from '../apps/gate/src/pr-hook.ts';
import { acceptRisk, getPanelView, panelContextFrom, submitSignoff, type PanelContext } from '../apps/gate/src/panel.ts';
import { handleGateRequest } from '../apps/gate/src/router.ts';
import { RIPPLE_YML, SHA_A, SHA_B, TEST_PR, TOKEN_DIFF, TYPO_DIFF, gateHarness } from '../apps/gate/src/testing/fakes.ts';
import type { MergeCheckEvent, PullRequestEvent } from '../apps/gate/src/types.ts';

const GATE_URL = 'https://gate-install.webtrigger.atlassian.app/public/gate-id';
const BRAIN_URL = 'https://brain-install.webtrigger.atlassian.app/public/brain-id';
const SHARED: SigningKey = { id: '2026-11', secret: 'shared-secret-'.repeat(4) };

type Router = (request: WebTriggerRequestShape) => Promise<WebTriggerResponseShape>;

/** Delivers a POST to whichever app owns the URL, the way Forge would. */
function transport(routers: Record<string, Router>, log: string[]): HttpPost {
  return async (url, init) => {
    const base = Object.keys(routers).find((candidate) => url.startsWith(candidate));
    assert.ok(base, `egress to unexpected host: ${url}`);
    const userPath = url.slice(base.length);
    const headers = Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name, [value]]));
    const response = await routers[base]!({ method: init.method, userPath, headers, body: init.body });
    log.push(`POST ${userPath} -> ${response.statusCode}`);
    return { status: response.statusCode, text: async () => response.body };
  };
}

function wire(gateKey: SigningKey = SHARED, brainKey: SigningKey = SHARED) {
  const log: string[] = [];
  const routers: Record<string, Router> = {};
  const post = transport(routers, log);
  const brain = brainHarness({
    pushVerdict: (verdict) => signedCall(post, GATE_URL, GATE_ROUTES.verdict, { v: 'v1', verdict }, verdictPushResponseSchema, brainKey, gate.clock.now.getTime()),
    pushDecision: (decision) => signedCall(post, GATE_URL, GATE_ROUTES.decision, { v: 'v1', decision }, decisionPushResponseSchema, brainKey, gate.clock.now.getTime()),
  });
  const gate = gateHarness({
    analyze: (request) => signedCall(post, BRAIN_URL, BRAIN_ROUTES.analyze, request, analyzeResponseSchema, gateKey, gate.clock.now.getTime()),
    signoff: (request) => signedCall(post, BRAIN_URL, BRAIN_ROUTES.signoff, request, signoffResponseSchema, gateKey, gate.clock.now.getTime()),
    acceptRisk: (request) => signedCall(post, BRAIN_URL, BRAIN_ROUTES.acceptRisk, request, acceptRiskResponseSchema, gateKey, gate.clock.now.getTime()),
  });
  const gateDeps = { ...gate.deps, verifyKeys: [gateKey] };
  const brainDeps = { ...brain.deps, verifyKeys: [brainKey], now: gate.deps.now };
  routers[GATE_URL] = (request) => handleGateRequest(gateDeps, request);
  routers[BRAIN_URL] = (request) => handleBrainRequest(brainDeps, request);
  return { gate, brain, gateDeps, brainDeps, log };
}

const wrapped = { workspace: { uuid: `{${TEST_PR.workspaceUuid}}` }, repository: { uuid: `{${TEST_PR.repoUuid}}` } };
const prEvent = { ...wrapped, eventType: 'avi:bitbucket:created:pullrequest', pullrequest: { id: TEST_PR.prId } } as unknown as PullRequestEvent;
const checkEvent: MergeCheckEvent = { ...wrapped, pullrequest: { id: TEST_PR.prId }, trigger: { type: 'on-merge' } };

test('end to end: PR opened -> analyze -> queue -> blast radius -> signed verdict -> merge blocked on sign-off', async () => {
  const { gate, brain, gateDeps, brainDeps, log } = wire();
  gate.bitbucket.diff = TOKEN_DIFF;
  gate.bitbucket.files.set('ripple.yml', RIPPLE_YML);

  await handlePullRequestEvent(gateDeps, prEvent);
  assert.deepEqual(log, ['POST /v1/analyze -> 202']);
  assert.equal((await evaluateMergeCheck(gateDeps, checkEvent)).state, 'ANALYSIS_PENDING');

  const [job] = brain.queue.jobs;
  assert.ok(job);
  assert.equal(job.headSha, SHA_A);
  const outcome = await runAnalysisJob(brainDeps, job);
  assert.ok(outcome.kind === 'DONE' && outcome.pushed);
  assert.deepEqual(log, ['POST /v1/analyze -> 202', 'POST /v1/verdict -> 200']);

  const record = await gate.store.getRecord({ ...TEST_PR, headSha: SHA_A });
  assert.ok(record?.state === 'SIGNOFF_REQUIRED');
  assert.deepEqual(record.verdict, outcome.verdict, 'Gate stored exactly what Brain produced');
  assert.deepEqual(
    record.verdict.signoffRequirements.map((r) => [r.spaceKey, r.ownership.source, r.roster.status]),
    [['MPLAT', 'SPACE_TEAM', 'VERIFIED'], ['MOB', 'LEAD_TEAM', 'VERIFIED']],
  );

  const check = await evaluateMergeCheck(gateDeps, checkEvent);
  assert.deepEqual([check.status, check.state], ['FAILED', 'SIGNOFF_REQUIRED']);
  assert.deepEqual(log.length, 2, 'the merge check made no call to Brain');
});

test('end to end: a typo fix never crosses the app boundary', async () => {
  const { gate, gateDeps, log } = wire();
  gate.bitbucket.diff = TYPO_DIFF;
  await handlePullRequestEvent(gateDeps, prEvent);
  assert.equal((await evaluateMergeCheck(gateDeps, checkEvent)).status, 'INELIGIBLE');
  assert.deepEqual(log, []);
});

test('end to end: mismatched secrets are rejected in both directions and the gate stays closed', async () => {
  const { gate, gateDeps, log } = wire(SHARED, { id: '2026-11', secret: 'a-different-secret-'.repeat(3) });
  gate.bitbucket.diff = TOKEN_DIFF;
  gate.bitbucket.files.set('ripple.yml', RIPPLE_YML);
  await handlePullRequestEvent(gateDeps, prEvent);
  assert.deepEqual(log, ['POST /v1/analyze -> 401']);
  const check = await evaluateMergeCheck(gateDeps, checkEvent);
  assert.deepEqual([check.status, check.state], ['FAILED', 'ANALYSIS_FAILED']);
  assert.match(check.message, /BRAIN_REJECTED/);
});

async function blockedLoop() {
  const wired = wire();
  wired.gate.bitbucket.diff = TOKEN_DIFF;
  wired.gate.bitbucket.files.set('ripple.yml', RIPPLE_YML);
  wired.gate.bitbucket.authorAccountId = AUTHOR.accountId;
  await handlePullRequestEvent(wired.gateDeps, prEvent);
  const [job] = wired.brain.queue.jobs;
  assert.ok(job);
  await runAnalysisJob(wired.brainDeps, job);
  wired.log.length = 0;
  return { ...wired, key: job };
}

test('end to end: stakeholders sign off space by space; the author cannot; the gate clears on the last one', async () => {
  const { gate, gateDeps, log, key } = await blockedLoop();
  const mplat = gate.store.records.values().next().value;
  assert.ok(mplat?.state === 'SIGNOFF_REQUIRED');
  const [first, second] = mplat.verdict.signoffRequirements;
  assert.ok(first && second && second.roster.status === 'VERIFIED');

  const self = await requestSignoff(gateDeps, key, first.spaceKey, AUTHOR);
  assert.deepEqual(self.ok && self.value, { v: 'v1', key, outcome: 'REJECTED', reason: 'AUTHOR_CANNOT_SIGN' });
  assert.deepEqual(log, ['POST /v1/signoff -> 200'], 'a refused sign-off never reaches Gate storage');

  const one = await requestSignoff(gateDeps, key, first.spaceKey, MIA);
  assert.deepEqual(one.ok && one.value.outcome === 'RECORDED' && one.value.gateState, 'SIGNOFF_REQUIRED');
  assert.equal((await evaluateMergeCheck(gateDeps, checkEvent)).status, 'FAILED');
  const two = await requestSignoff(gateDeps, key, second.spaceKey, second.roster.members[0]);
  assert.deepEqual(two.ok && two.value.outcome === 'RECORDED' && two.value.gateState, 'CLEARED');
  assert.equal((await evaluateMergeCheck(gateDeps, checkEvent)).status, 'PASSED');
  assert.deepEqual(log.slice(1), ['POST /v1/decision -> 200', 'POST /v1/signoff -> 200', 'POST /v1/decision -> 200', 'POST /v1/signoff -> 200']);
  void MO;
});

test('end to end: the author accepts risk; a Jira ticket is filed and the merge check passes citing it', async () => {
  const { brain, gateDeps, key } = await blockedLoop();
  const refused = await requestAcceptRisk(gateDeps, key, MIA, 'I would like to merge this without asking anyone.', '2026-12-10');
  assert.deepEqual(refused.ok && refused.value.outcome === 'REJECTED' && refused.value.reason, 'NOT_AUTHORIZED');
  const accepted = await requestAcceptRisk(gateDeps, key, AUTHOR, 'Hotfix for a production incident; consumers notified.', '2026-12-10');
  assert.ok(accepted.ok && accepted.value.outcome === 'RECORDED');
  assert.deepEqual([accepted.value.ticket.issueKey, accepted.value.gateState, brain.tickets.created.length], ['RISK-1', 'RISK_ACCEPTED', 1]);
  const check = await evaluateMergeCheck(gateDeps, checkEvent);
  assert.deepEqual([check.status, check.state], ['PASSED', 'RISK_ACCEPTED']);
  assert.match(check.message, /RISK-1/);
});

// --- PR overview panel (resolver logic over the real Brain) ------------------------

function panelAs(accountId: string, installContext = false): PanelContext {
  const parsed = panelContextFrom({
    accountId,
    ...(installContext ? { installContext: `ari:cloud:bitbucket::workspace/${TEST_PR.workspaceUuid}` } : { workspaceId: `{${TEST_PR.workspaceUuid}}` }),
    extension: { repository: { uuid: `{${TEST_PR.repoUuid}}` }, pullRequest: { id: TEST_PR.prId } },
  });
  assert.ok(parsed.ok);
  return parsed.value;
}

test('panel: the invocation context identifies PR and viewer; anything malformed fails closed', () => {
  assert.deepEqual(panelAs(MIA.accountId).pr, TEST_PR);
  assert.deepEqual(panelAs(MIA.accountId, true).pr, TEST_PR);
  assert.equal(panelContextFrom({ extension: { repository: { uuid: `{${TEST_PR.repoUuid}}` }, pullRequest: { id: 7 } } }).ok, false);
  assert.equal(panelContextFrom({ accountId: MIA.accountId, workspaceId: 'nope', extension: { repository: { uuid: 'x' }, pullRequest: { id: 7 } } }).ok, false);
});

test('panel: the blocked PR shows its findings, outstanding spaces, and who the viewer is', async () => {
  const { gateDeps } = await blockedLoop();
  const view = await getPanelView(gateDeps, panelAs(AUTHOR.accountId));
  assert.ok(view.status === 'READY');
  assert.equal(view.headSha, SHA_A);
  assert.equal(view.record.state, 'SIGNOFF_REQUIRED');
  assert.equal(view.check.status, 'FAILED');
  assert.deepEqual(view.outstandingSpaceKeys, ['MPLAT', 'MOB']);
  assert.ok('diff' in view.record && view.record.diff.findings.length > 0);
  assert.deepEqual([view.viewer.isPrAuthor, view.viewer.displayName, view.viewer.rosterSpaceKeys], [true, 'Pat Author', []]);

  const mia = await getPanelView(gateDeps, panelAs(MIA.accountId));
  assert.ok(mia.status === 'READY');
  assert.deepEqual([mia.viewer.isPrAuthor, mia.viewer.displayName, mia.viewer.rosterSpaceKeys], [false, 'Mia Dev', ['MPLAT']]);
});

test('panel: the author is refused sign-off; a roster member signs and the view updates in the same call', async () => {
  const { gateDeps, log } = await blockedLoop();
  const self = await submitSignoff(gateDeps, panelAs(AUTHOR.accountId), { headSha: SHA_A, spaceKey: 'MPLAT' });
  assert.ok(!self.ok);
  assert.equal(self.reason, 'AUTHOR_CANNOT_SIGN');
  assert.match(self.message, /accept the risk/);

  const signed = await submitSignoff(gateDeps, panelAs(MIA.accountId), { headSha: SHA_A, spaceKey: 'MPLAT' });
  assert.ok(signed.ok && signed.view.status === 'READY');
  assert.deepEqual(signed.view.outstandingSpaceKeys, ['MOB']);
  assert.ok(signed.view.record.state === 'SIGNOFF_REQUIRED');
  assert.deepEqual(signed.view.record.signoffs.map((s) => [s.spaceKey, s.signer.displayName]), [['MPLAT', 'Mia Dev']]);
  assert.deepEqual(log, ['POST /v1/signoff -> 200', 'POST /v1/decision -> 200', 'POST /v1/signoff -> 200'], 'the refused sign-off never reached Gate storage');
});

test('panel: a stale tab or a malformed payload is refused before Brain is asked', async () => {
  const { gateDeps, log } = await blockedLoop();
  const stale = await submitSignoff(gateDeps, panelAs(MIA.accountId), { headSha: SHA_B, spaceKey: 'MPLAT' });
  assert.ok(!stale.ok && stale.reason === 'STALE_HEAD' && stale.view.status === 'READY');
  const junk = await submitSignoff(gateDeps, panelAs(MIA.accountId), { headSha: SHA_A, spaceKey: 'not a key!' });
  assert.ok(!junk.ok && junk.reason === 'INVALID_REQUEST');
  const short = await acceptRisk(gateDeps, panelAs(AUTHOR.accountId), { headSha: SHA_A, justification: 'meh', dueDate: '2026-12-10' });
  assert.ok(!short.ok && short.reason === 'INVALID_REQUEST');
  const badDate = await acceptRisk(gateDeps, panelAs(AUTHOR.accountId), { headSha: SHA_A, justification: 'Hotfix for a production incident; consumers notified.', dueDate: '10/12/2026' });
  assert.ok(!badDate.ok && badDate.reason === 'INVALID_REQUEST');
  assert.deepEqual(log, []);
});

test('panel: the author accepts risk and the returned view carries the Jira ticket', async () => {
  const { gateDeps } = await blockedLoop();
  const result = await acceptRisk(gateDeps, panelAs(AUTHOR.accountId), {
    headSha: SHA_A,
    justification: 'Hotfix for a production incident; consumers notified.',
    dueDate: '2026-12-10',
  });
  assert.ok(result.ok && result.view.status === 'READY');
  assert.ok(result.view.record.state === 'RISK_ACCEPTED');
  assert.equal(result.view.record.exception.ticket.issueKey, 'RISK-1');
  assert.equal(result.view.check.status, 'PASSED');
  assert.deepEqual(result.view.outstandingSpaceKeys, []);
});
