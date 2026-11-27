import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GATE_ROUTES,
  decodeJson,
  signRequest,
  verdictSchema,
  type CompleteVerdict,
  type Verdict,
  type WebTriggerRequestShape,
} from '@ripple/contracts';
import { fixtureText } from '@ripple/contracts/fixtures';
import { CHECK_STATUS, evaluateMergeCheck, toMergeCheckResponse } from './merge-check.ts';
import { classifyDiff } from './noise-gate.ts';
import { handlePullRequestEvent } from './pr-hook.ts';
import { parseRippleYml } from './ripple-yml.ts';
import { requestAcceptRisk, requestSignoff } from './actions.ts';
import { handleGateRequest } from './router.ts';
import { DESTINATION_COMMIT, RIPPLE_YML, SHA_A, SHA_B, TEST_KEY, TEST_PR, TOKEN_DIFF, TYPO_DIFF, gateHarness, type GateHarness } from './testing/fakes.ts';
import { GATE_STORAGE, MERGE_OUTCOME, PENDING_STALE_MS, type GateState, type MergeCheckEvent, type PullRequestEvent } from './types.ts';

const wrapped = { workspace: { uuid: `{${TEST_PR.workspaceUuid}}` }, repository: { uuid: `{${TEST_PR.repoUuid}}` } };
const checkEvent: MergeCheckEvent = { ...wrapped, pullrequest: { id: TEST_PR.prId }, trigger: { type: 'on-merge' } };
const prEvent = {
  ...wrapped,
  eventType: 'avi:bitbucket:updated:pullrequest',
  pullrequest: { id: TEST_PR.prId },
} as unknown as PullRequestEvent;

function verdict(name: 'verdict-complete' | 'verdict-failed', headSha = SHA_A): Verdict {
  const decoded = decodeJson(verdictSchema, fixtureText(name));
  assert.ok(decoded.ok);
  return { ...decoded.value, key: { ...decoded.value.key, headSha } };
}

function push(h: GateHarness, v: Verdict, signedWith = TEST_KEY): Promise<{ statusCode: number; body: string }> {
  const body = JSON.stringify({ v: 'v1', verdict: v });
  const headers = signRequest({ method: 'POST', path: GATE_ROUTES.verdict, body }, signedWith, h.clock.now.getTime());
  const request: WebTriggerRequestShape = { method: 'POST', userPath: GATE_ROUTES.verdict, headers, body };
  return handleGateRequest(h.deps, request);
}

function sensitive(h: GateHarness): void {
  h.bitbucket.diff = TOKEN_DIFF;
  h.bitbucket.files.set('ripple.yml', RIPPLE_YML);
}

const stateOf = async (h: GateHarness, sha = SHA_A) => (await h.store.getRecord({ ...TEST_PR, headSha: sha }))?.state;

// --- noise gate (D1–D6) ------------------------------------------------------

const diffOf = (path: string, removed: string[], added: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ''].join('\n');

test('noise gate: each detector D1–D6 fires on its surface', () => {
  const cases: [string, string, string[], string[]][] = [
    ['D1.schema-migration', 'db/migrations/004_users.sql', [], ['ALTER TABLE users ADD COLUMN tenant_id uuid;']],
    ['D2.api-contract', 'api/openapi.yaml', [], ['      description: clarified']],
    ['D3.auth-token', 'src/auth/guard.ts', ['const a = 1;'], ['const a = 2;']],
    ['D4.config-contract', 'config/service.json', ['  "timeout": 5'], ['  "timeout": 10']],
    ['D5.shared-library', 'packages/money/src/index.ts', [], ['export { round } from "./round";']],
    ['D6a.destructive-sql', 'db/migrations/005_drop.sql', [], ['ALTER TABLE users DROP COLUMN legacy_token;']],
    ['D6b.contract-element-removed', 'api/openapi.yaml', ['  /v1/tokens/refresh:'], []],
    ['D6c.token-shape', 'src/users/login.ts', ["sign({ sub }, key, { expiresIn: '1h' })"], ["sign({ sub }, key, { expiresIn: '15m' })"]],
  ];
  for (const [ruleId, path, removed, added] of cases) {
    const summary = classifyDiff(diffOf(path, removed, added));
    assert.deepEqual(summary.findings.map((f) => f.ruleId), [ruleId], `${ruleId} on ${path}`);
  }
});

test('noise gate: typos, docs, tests, lockfiles and comment-only edits produce no findings', () => {
  const quiet = [
    TYPO_DIFF,
    diffOf('src/auth/token.test.ts', ['expect(jwt.sign()).toBe(1)'], ['expect(jwt.sign()).toBe(2)']),
    diffOf('docs/auth/tokens.md', ['old'], ['new']),
    diffOf('package-lock.json', ['"a": "1"'], ['"a": "2"']),
    diffOf('src/auth/token.ts', ['// retuns a token'], ['// returns a token']),
    diffOf('src/ui/Button.tsx', ['color: red'], ['color: blue']),
  ];
  for (const diff of quiet) assert.deepEqual(classifyDiff(diff).findings, [], diff.split('\n')[0]);
});

test('noise gate: output is deterministic, bounded, severity-ordered and redacts secrets', () => {
  const diff = [
    diffOf('config/app.yaml', [], ['api_secret: hunter2-super-secret']),
    diffOf('db/migrations/9.sql', [], ['DROP TABLE sessions;', ...Array.from({ length: 200 }, (_, i) => `-- filler ${i} ${'x'.repeat(40)}`)]),
  ].join('');
  const first = classifyDiff(diff);
  assert.deepEqual(first, classifyDiff(diff));
  assert.deepEqual(first.findings.map((f) => f.severity), ['CRITICAL', 'MEDIUM']);
  assert.ok(first.findings.every((f) => f.excerpt.length <= 600 && f.breaking === null));
  assert.ok(!JSON.stringify(first).includes('hunter2'));
  assert.equal(first.filesChanged, 2);
});

test('ripple.yml: valid declarations parse; self-references and duplicates are dropped', () => {
  const parsed = parseRippleYml('service:\n  id: auth-service\n  jiraSpaceKey: PLAT\ndownstream: [MPLAT, PLAT, MOB, MPLAT]\n');
  assert.deepEqual(parsed, { ok: true, value: { id: 'auth-service', spaceKey: 'PLAT', downstream: ['MPLAT', 'MOB'] } });
  const none = parseRippleYml('service: { id: lib, jiraSpaceKey: PLAT }');
  assert.deepEqual(none.ok && none.value.downstream, []);
});

test('ripple.yml: malformed declarations are rejected with a reason', () => {
  for (const bad of ['::: not yaml [', 'service: {}', 'service: { id: x, jiraSpaceKey: plat }', 'service: { id: x, jiraSpaceKey: PLAT }\ndownstream: [ok-not]', 'downstream: [MOB]']) {
    assert.equal(parseRippleYml(bad).ok, false, bad);
  }
});

// --- PR hook -----------------------------------------------------------------

test('PR hook: a typo fix is recorded as NO_SENSITIVE_SURFACE and Brain is never called', async () => {
  const h = gateHarness();
  h.bitbucket.diff = TYPO_DIFF;
  await handlePullRequestEvent(h.deps, prEvent);
  assert.equal(await stateOf(h), 'NO_SENSITIVE_SURFACE');
  assert.equal(h.brain.requests.length, 0);
  assert.equal(h.bitbucket.calls.file, 0);
});

test('PR hook: a sensitive diff dispatches one analyze request keyed by the full head SHA', async () => {
  const h = gateHarness();
  sensitive(h);
  await handlePullRequestEvent(h.deps, prEvent);
  await handlePullRequestEvent(h.deps, prEvent); // redelivery
  assert.equal(await stateOf(h), 'ANALYSIS_PENDING');
  assert.equal(h.brain.requests.length, 1);
  const [request] = h.brain.requests;
  assert.ok(request);
  assert.equal(request.key.headSha, SHA_A);
  assert.equal(request.key.headSha.length, 40);
  assert.deepEqual(request.service, { id: 'auth-service', spaceKey: 'PLAT', downstream: ['MPLAT', 'MOB'], configPath: 'ripple.yml', configSource: 'DESTINATION_BRANCH' });
  assert.ok(request.diff.findings.length > 0);
  assert.ok([...h.store.records.keys()].every((k) => k.endsWith(SHA_A)));
  assert.ok(h.store.audit.every((e) => e.headSha.length === 40));
  assert.equal(GATE_STORAGE.record(request.key), `gate:${TEST_PR.workspaceUuid}:${TEST_PR.repoUuid}:7:${SHA_A}`);
});

test('PR hook and merge check racing on the same head send Brain exactly one analyze request', async () => {
  const h = gateHarness();
  sensitive(h);
  const [, outcome] = await Promise.all([handlePullRequestEvent(h.deps, prEvent), evaluateMergeCheck(h.deps, checkEvent)]);
  assert.equal(h.brain.requests.length, 1);
  assert.equal(outcome.state, 'ANALYSIS_PENDING');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(await stateOf(h), 'ANALYSIS_PENDING');

  // A retry after the pending analysis goes stale is a new attempt with its own claim.
  h.clock.now = new Date(h.clock.now.getTime() + PENDING_STALE_MS + 1);
  await Promise.all([handlePullRequestEvent(h.deps, prEvent), evaluateMergeCheck(h.deps, checkEvent)]);
  assert.equal(h.brain.requests.length, 2);
});

test('PR hook: Brain being unreachable or Bitbucket failing mid-way fails closed, and retries are capped', async () => {
  const h = gateHarness();
  sensitive(h);
  h.brain.respond = () => ({ ok: false, error: { kind: 'UNREACHABLE', message: 'timeout' } });
  for (let i = 0; i < 5; i += 1) await handlePullRequestEvent(h.deps, prEvent);
  assert.equal(await stateOf(h), 'ANALYSIS_FAILED');
  assert.equal(h.brain.requests.length, 3);

  const b = gateHarness();
  b.bitbucket.diff = TOKEN_DIFF;
  b.bitbucket.getFile = async () => ({ ok: false, error: { kind: 'UPSTREAM', message: 'read file: HTTP 503' } });
  await handlePullRequestEvent(b.deps, prEvent);
  // A ripple.yml read failure must not be mistaken for "repo has no declaration".
  assert.equal(await stateOf(b), 'ANALYSIS_FAILED');
  assert.equal(b.brain.requests.length, 0);
});

test('PR hook: malformed events are rejected without side effects', async () => {
  const h = gateHarness();
  const result = await handlePullRequestEvent(h.deps, { ...prEvent, workspace: { uuid: 'nope' } });
  assert.deepEqual(result, { ok: false, error: 'MALFORMED_EVENT' });
  assert.equal(h.bitbucket.calls.pullRequest, 0);
});

test('PR hook: the destination branch declaration wins, so a PR cannot shrink its own blast radius', async () => {
  const h = gateHarness();
  h.bitbucket.diff = TOKEN_DIFF;
  h.bitbucket.files.set(`${DESTINATION_COMMIT}:ripple.yml`, RIPPLE_YML);
  h.bitbucket.files.set(`${SHA_A}:ripple.yml`, 'service: { id: auth-service, jiraSpaceKey: PLAT }\ndownstream: []\n');
  await handlePullRequestEvent(h.deps, prEvent);
  assert.deepEqual(h.brain.requests[0]?.service.downstream, ['MPLAT', 'MOB']);
  assert.equal(h.brain.requests[0]?.service.configSource, 'DESTINATION_BRANCH');

  const first = gateHarness();
  first.bitbucket.diff = TOKEN_DIFF;
  first.bitbucket.files.set(`${SHA_A}:ripple.yml`, RIPPLE_YML);
  await handlePullRequestEvent(first.deps, prEvent);
  assert.equal(first.brain.requests[0]?.service.configSource, 'PR_HEAD');
});

test('PR hook: no ripple.yml is NOT_IN_CATALOG without calling Brain; a broken one fails closed', async () => {
  const none = gateHarness();
  none.bitbucket.diff = TOKEN_DIFF;
  await handlePullRequestEvent(none.deps, prEvent);
  const record = await none.store.getRecord({ ...TEST_PR, headSha: SHA_A });
  assert.ok(record?.state === 'NOT_IN_CATALOG' && record.reason === 'NO_RIPPLE_CONFIG');
  assert.equal(none.brain.requests.length, 0);

  const broken = gateHarness();
  broken.bitbucket.diff = TOKEN_DIFF;
  broken.bitbucket.files.set('ripple.yml', 'service: { id: x, jiraSpaceKey: nope }');
  await handlePullRequestEvent(broken.deps, prEvent);
  const failed = await broken.store.getRecord({ ...TEST_PR, headSha: SHA_A });
  assert.ok(failed?.state === 'ANALYSIS_FAILED' && failed.failure.code === 'INVALID_RIPPLE_CONFIG' && !failed.failure.retryable);
  assert.equal((await evaluateMergeCheck(broken.deps, checkEvent)).status, 'FAILED');
  assert.equal(broken.brain.requests.length, 0);
});

// --- verdict web trigger -----------------------------------------------------

test('router: a signed verdict is stored with its sign-off roster and unblocks nothing by itself', async () => {
  const h = gateHarness();
  sensitive(h);
  await handlePullRequestEvent(h.deps, prEvent);
  const response = await push(h, verdict('verdict-complete'));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).outcome, 'STORED');
  const record = await h.store.getRecord({ ...TEST_PR, headSha: SHA_A });
  assert.ok(record?.state === 'SIGNOFF_REQUIRED');
  assert.deepEqual(record.verdict.signoffRequirements.map((r) => [r.spaceKey, r.ownership.source, r.roster.status]), [['MPLAT', 'SPACE_TEAM', 'VERIFIED'], ['MOB', 'UNRESOLVED', 'DEGRADED']]);
  assert.deepEqual(record.signoffs, []);
});

test('router: unsigned, wrongly signed, malformed and unknown-route requests are refused', async () => {
  const h = gateHarness();
  sensitive(h);
  await handlePullRequestEvent(h.deps, prEvent);
  const body = JSON.stringify({ v: 'v1', verdict: verdict('verdict-complete') });
  const at = h.clock.now.getTime();

  const unsigned = await handleGateRequest(h.deps, { method: 'POST', userPath: GATE_ROUTES.verdict, body });
  const forged = await push(h, verdict('verdict-complete'), { id: 'test', secret: 'x'.repeat(64) });
  const bad = '{"v":"v1","verdict":{"status":"COMPLETE"}}';
  const malformed = await handleGateRequest(h.deps, { method: 'POST', userPath: GATE_ROUTES.verdict, body: bad, headers: signRequest({ method: 'POST', path: GATE_ROUTES.verdict, body: bad }, TEST_KEY, at) });
  const unknown = await handleGateRequest(h.deps, { method: 'POST', userPath: '/v1/nope', body, headers: signRequest({ method: 'POST', path: '/v1/nope', body }, TEST_KEY, at) });

  assert.deepEqual([unsigned.statusCode, forged.statusCode, malformed.statusCode, unknown.statusCode], [401, 401, 400, 404]);
  assert.equal(await stateOf(h), 'ANALYSIS_PENDING');
});

test('router: verdicts for a superseded head or an unrequested analysis are not stored', async () => {
  const h = gateHarness();
  sensitive(h);
  await handlePullRequestEvent(h.deps, prEvent);
  h.bitbucket.headSha = SHA_B;
  await handlePullRequestEvent(h.deps, prEvent);

  const stale = await push(h, verdict('verdict-complete', SHA_A));
  assert.equal(JSON.parse(stale.body).outcome, 'STALE_SHA');
  assert.equal(await stateOf(h, SHA_A), 'ANALYSIS_PENDING');

  const fresh = gateHarness();
  assert.equal((await push(fresh, verdict('verdict-complete'))).statusCode, 404);
});

test('router: redelivering a verdict never resets an existing decision', async () => {
  const h = gateHarness();
  sensitive(h);
  await handlePullRequestEvent(h.deps, prEvent);
  await push(h, verdict('verdict-complete'));
  const before = await h.store.getRecord({ ...TEST_PR, headSha: SHA_A });
  const again = await push(h, verdict('verdict-failed'));
  assert.equal(JSON.parse(again.body).outcome, 'STORED');
  assert.deepEqual(await h.store.getRecord({ ...TEST_PR, headSha: SHA_A }), before);
});

// --- merge check -------------------------------------------------------------

test('merge check: status table agrees with MERGE_OUTCOME and never passes an undecided state', () => {
  for (const state of Object.keys(CHECK_STATUS) as GateState[]) {
    assert.equal(CHECK_STATUS[state] === 'FAILED', MERGE_OUTCOME[state] === 'FAIL', state);
  }
  assert.deepEqual([CHECK_STATUS.ANALYSIS_PENDING, CHECK_STATUS.ANALYSIS_FAILED, CHECK_STATUS.SIGNOFF_REQUIRED], ['FAILED', 'FAILED', 'FAILED']);
});

test('merge check: INELIGIBLE for a typo fix even when the PR event never arrived', async () => {
  const h = gateHarness();
  h.bitbucket.diff = TYPO_DIFF;
  const outcome = await evaluateMergeCheck(h.deps, checkEvent);
  assert.deepEqual([outcome.status, outcome.state], ['INELIGIBLE', 'NO_SENSITIVE_SURFACE']);
  assert.equal(toMergeCheckResponse(outcome).success, true);
});

test('merge check: FAILED while analysis is pending, then FAILED naming the teams that must sign', async () => {
  const h = gateHarness();
  sensitive(h);
  const pending = await evaluateMergeCheck(h.deps, checkEvent);
  assert.deepEqual([pending.status, pending.state], ['FAILED', 'ANALYSIS_PENDING']);

  await push(h, verdict('verdict-complete'));
  const blocked = await evaluateMergeCheck(h.deps, checkEvent);
  assert.deepEqual([blocked.status, blocked.state], ['FAILED', 'SIGNOFF_REQUIRED']);
  assert.match(blocked.message, /MPLAT \(Mobile\), MOB/);
  assert.equal(toMergeCheckResponse(blocked).success, false);
  // Steady state: one PR read, then local storage only.
  const before = { ...h.bitbucket.calls };
  await evaluateMergeCheck(h.deps, checkEvent);
  assert.deepEqual(h.bitbucket.calls, { ...before, pullRequest: before.pullRequest + 1 });
  assert.equal(h.brain.requests.length, 1);
});

test('merge check: PASSED when no space must sign, INELIGIBLE without ripple.yml, FAILED on analysis failure', async () => {
  const cleared = gateHarness();
  sensitive(cleared);
  await evaluateMergeCheck(cleared.deps, checkEvent);
  const advisory = { ...(verdict('verdict-complete') as CompleteVerdict), signoffRequirements: [] };
  await push(cleared, advisory);
  assert.equal((await evaluateMergeCheck(cleared.deps, checkEvent)).status, 'PASSED');

  const undeclared = gateHarness();
  undeclared.bitbucket.diff = TOKEN_DIFF;
  assert.equal((await evaluateMergeCheck(undeclared.deps, checkEvent)).status, 'INELIGIBLE');

  const broken = gateHarness();
  sensitive(broken);
  await evaluateMergeCheck(broken.deps, checkEvent);
  await push(broken, verdict('verdict-failed'));
  const outcome = await evaluateMergeCheck(broken.deps, checkEvent);
  assert.equal(outcome.status, 'FAILED');
  assert.equal(broken.brain.requests.length, 2, 'a retryable failure is re-dispatched');
});

test('merge check: a new commit re-blocks, invalidates the old decision and keeps the audit trail', async () => {
  const h = gateHarness();
  sensitive(h);
  await evaluateMergeCheck(h.deps, checkEvent);
  await push(h, { ...(verdict('verdict-complete') as CompleteVerdict), signoffRequirements: [] });
  assert.equal((await evaluateMergeCheck(h.deps, checkEvent)).status, 'PASSED');

  h.bitbucket.headSha = SHA_B;
  const after = await evaluateMergeCheck(h.deps, checkEvent);
  assert.deepEqual([after.status, after.state], ['FAILED', 'ANALYSIS_PENDING']);
  assert.equal(await stateOf(h, SHA_A), 'CLEARED', 'old record is preserved, not deleted');
  const superseded = h.store.audit.find((e) => e.type === 'HEAD_SUPERSEDED');
  assert.ok(superseded?.type === 'HEAD_SUPERSEDED');
  assert.deepEqual([superseded.headSha, superseded.newHeadSha], [SHA_A, SHA_B]);
});

test('merge check: a lost verdict push is recovered by re-dispatching once the pending record is stale', async () => {
  const h = gateHarness();
  sensitive(h);
  await evaluateMergeCheck(h.deps, checkEvent);
  await evaluateMergeCheck(h.deps, checkEvent);
  assert.equal(h.brain.requests.length, 1);

  h.clock.now = new Date(h.clock.now.getTime() + PENDING_STALE_MS + 1);
  h.brain.respond = (request) => ({ ok: true, value: { v: 'v1', key: request.key, state: 'COMPLETE', verdict: verdict('verdict-complete') } });
  const outcome = await evaluateMergeCheck(h.deps, checkEvent);
  assert.equal(h.brain.requests.length, 2);
  assert.equal(outcome.state, 'SIGNOFF_REQUIRED');
});

test('merge check: fails closed when Bitbucket is unreachable or the payload is malformed', async () => {
  const h = gateHarness();
  h.bitbucket.failure = { kind: 'UPSTREAM', message: 'read pull request: HTTP 502' };
  const down = await evaluateMergeCheck(h.deps, checkEvent);
  assert.deepEqual([down.status, down.state], ['FAILED', null]);
  const malformed = await evaluateMergeCheck(h.deps, { ...checkEvent, repository: { uuid: '' } });
  assert.equal(malformed.status, 'FAILED');

  const merged = gateHarness();
  merged.bitbucket.state = 'MERGED';
  assert.equal((await evaluateMergeCheck(merged.deps, checkEvent)).status, 'INELIGIBLE');
});

// --- decisions (sign-off / accepted risk) -------------------------------------

type Decision = import('@ripple/contracts').Decision;
const KEY_A = { ...TEST_PR, headSha: SHA_A };
const who = (id: string) => ({ accountId: id, displayName: id }) as unknown as import('@ripple/contracts').RosterMember;
const at = '2026-11-26T10:05:00.000Z' as import('@ripple/contracts').IsoTimestamp;
const signoffDecision = (spaceKey: string, key = KEY_A): Decision =>
  ({ type: 'SIGNOFF', key, spaceKey, signer: who('712020:mob-lead'), authorization: 'ROSTER_MEMBER', decidedAt: at }) as unknown as Decision;
const riskDecision = (key = KEY_A): Decision =>
  ({ type: 'RISK_ACCEPTED', key, acceptedBy: who('712020:author'), acceptedAs: 'PR_AUTHOR', justification: 'Hotfix for a production incident.', dueDate: '2026-12-10', ticket: { issueKey: 'RISK-1', issueUrl: 'https://acme.atlassian.net/browse/RISK-1' }, decidedAt: at }) as unknown as Decision;

async function decide(h: GateHarness, decision: Decision, key = TEST_KEY) {
  const body = JSON.stringify({ v: 'v1', decision });
  const headers = signRequest({ method: 'POST', path: GATE_ROUTES.decision, body }, key, h.clock.now.getTime());
  const response = await handleGateRequest(h.deps, { method: 'POST', userPath: GATE_ROUTES.decision, headers, body });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

async function blocked(): Promise<GateHarness> {
  const h = gateHarness();
  sensitive(h);
  await handlePullRequestEvent(h.deps, prEvent);
  await push(h, verdict('verdict-complete'));
  return h;
}

test('decision: sign-offs accumulate per space and the gate clears only when every space has signed', async () => {
  const h = await blocked();
  assert.deepEqual((await decide(h, signoffDecision('MPLAT'))).body, { v: 'v1', key: KEY_A, outcome: 'APPLIED', state: 'SIGNOFF_REQUIRED' });
  const partial = await evaluateMergeCheck(h.deps, checkEvent);
  assert.equal(partial.status, 'FAILED');
  assert.match(partial.message, /from: MOB\./);

  assert.equal((await decide(h, signoffDecision('MPLAT'))).body.state, 'SIGNOFF_REQUIRED', 'replay changes nothing');
  assert.equal((await decide(h, signoffDecision('MOB'))).body.state, 'CLEARED');
  const record = await h.store.getRecord(KEY_A);
  assert.ok(record?.state === 'CLEARED');
  assert.deepEqual(record.signoffs.map((s) => [s.spaceKey, s.headSha]), [['MPLAT', SHA_A], ['MOB', SHA_A]]);
  assert.equal((await evaluateMergeCheck(h.deps, checkEvent)).status, 'PASSED');
  assert.equal(h.store.audit.filter((e) => e.type === 'SIGNOFF_RECORDED').length, 2);
});

test('decision: accepted risk passes the gate, names the ticket and records what was outstanding', async () => {
  const h = await blocked();
  await decide(h, signoffDecision('MPLAT'));
  assert.equal((await decide(h, riskDecision())).body.state, 'RISK_ACCEPTED');
  const record = await h.store.getRecord(KEY_A);
  assert.ok(record?.state === 'RISK_ACCEPTED');
  assert.deepEqual([record.exception.outstandingSpaces, record.exception.ticket.issueKey, record.exception.acceptedAs], [['MOB'], 'RISK-1', 'PR_AUTHOR']);
  const check = await evaluateMergeCheck(h.deps, checkEvent);
  assert.equal(check.status, 'PASSED');
  assert.match(check.message, /RISK-1/);
  assert.equal((await decide(h, riskDecision())).body.state, 'RISK_ACCEPTED', 'replay changes nothing');
  assert.equal(h.store.audit.filter((e) => e.type === 'RISK_ACCEPTED').length, 1);
});

test('decision: unsigned, stale-head, wrong-state and unknown-space decisions never change the gate', async () => {
  const h = await blocked();
  assert.equal((await decide(h, signoffDecision('MPLAT'), { id: 'test', secret: 'x'.repeat(64) })).status, 401);
  assert.equal((await decide(h, signoffDecision('SALES'))).body.outcome, 'WRONG_STATE');
  assert.equal((await stateOf(h)), 'SIGNOFF_REQUIRED');

  const pendingOnly = gateHarness();
  sensitive(pendingOnly);
  await handlePullRequestEvent(pendingOnly.deps, prEvent);
  assert.equal((await decide(pendingOnly, riskDecision())).body.outcome, 'WRONG_STATE');
  assert.equal((await decide(gateHarness(), signoffDecision('MPLAT'))).status, 404);

  // A new commit invalidates everything: decisions for the old head are refused.
  await decide(h, signoffDecision('MPLAT'));
  h.bitbucket.headSha = SHA_B;
  await handlePullRequestEvent(h.deps, prEvent);
  assert.equal((await decide(h, signoffDecision('MOB'))).body.outcome, 'STALE_SHA');
  assert.equal((await decide(h, riskDecision())).body.outcome, 'STALE_SHA');
  assert.equal((await evaluateMergeCheck(h.deps, checkEvent)).status, 'FAILED');
});

test('actions: Gate refuses stale or wrong-state requests locally and never writes KVS itself', async () => {
  const h = await blocked();
  const actor = who('712020:mob-lead');
  const before = JSON.stringify(await h.store.getRecord(KEY_A));
  const sent = await requestSignoff(h.deps, KEY_A, 'MPLAT' as never, actor);
  assert.deepEqual(sent, { ok: false, error: { kind: 'BRAIN', error: { kind: 'UNREACHABLE', message: 'not wired' } } });
  assert.equal(JSON.stringify(await h.store.getRecord(KEY_A)), before);
  assert.deepEqual(await requestSignoff(h.deps, { ...TEST_PR, headSha: SHA_B }, 'MPLAT' as never, actor), { ok: false, error: { kind: 'REJECTED', reason: 'STALE_HEAD' } });
  assert.deepEqual(await requestAcceptRisk(h.deps, KEY_A, actor, 'x'.repeat(30), 'next week'), { ok: false, error: { kind: 'REJECTED', reason: 'INVALID_DUE_DATE' } });
  await decide(h, riskDecision());
  assert.deepEqual(await requestAcceptRisk(h.deps, KEY_A, actor, 'x'.repeat(30), '2026-12-10'), { ok: false, error: { kind: 'REJECTED', reason: 'WRONG_STATE' } });
});
