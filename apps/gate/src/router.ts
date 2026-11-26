/** Gate web trigger router: the inbound half of the contract (Brain -> Gate). */
import {
  CONTRACT_VERSION,
  GATE_ROUTES,
  apiError,
  authenticate,
  decisionPushRequestSchema,
  decodeJson,
  type DecisionPushResponse,
  errorMessage,
  isoNow,
  jsonResponse,
  verdictPushRequestSchema,
  type VerdictPushResponse,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { appendAudit } from './intake.ts';
import type { GateDeps } from './ports.ts';
import { applyDecision, applyVerdict, awaitsVerdict } from './state.ts';

async function storeVerdict(deps: GateDeps, body: string): Promise<WebTriggerResponseShape> {
  const decoded = decodeJson(verdictPushRequestSchema, body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);

  const { verdict } = decoded.value;
  const { headSha, ...pr } = verdict.key;
  const reply = (outcome: VerdictPushResponse['outcome']) =>
    jsonResponse(200, { v: CONTRACT_VERSION, key: verdict.key, outcome } satisfies VerdictPushResponse);

  // A verdict for anything but the current head is discarded: it can never gate a merge.
  const pointer = await deps.store.getPointer(pr);
  if (pointer !== null && pointer.headSha !== headSha) return reply('STALE_SHA');

  const record = await deps.store.getRecord(verdict.key);
  // Gate only accepts verdicts for analyses it asked for.
  if (record === null || record.state === 'NO_SENSITIVE_SURFACE') {
    return apiError('ANALYSIS_NOT_FOUND', 'no analysis was requested for this commit');
  }
  // Redelivery after a decision exists must not reset sign-offs or an accepted risk.
  if (!awaitsVerdict(record)) return reply('STORED');

  await deps.store.putRecord(applyVerdict(record, verdict, isoNow(deps.now())));
  await appendAudit(deps, verdict.key, { type: 'VERDICT_RECEIVED', status: verdict.status });
  return reply('STORED');
}

async function storeDecision(deps: GateDeps, body: string): Promise<WebTriggerResponseShape> {
  const decoded = decodeJson(decisionPushRequestSchema, body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const { decision } = decoded.value;
  const { headSha, ...pr } = decision.key;
  const reply = (response: DecisionPushResponse) => jsonResponse(200, response);
  const keyed = { v: CONTRACT_VERSION, key: decision.key };

  // A decision about anything but the current head can never unblock a merge.
  const pointer = await deps.store.getPointer(pr);
  if (pointer !== null && pointer.headSha !== headSha) return reply({ ...keyed, outcome: 'STALE_SHA' });
  const record = await deps.store.getRecord(decision.key);
  if (record === null) return apiError('ANALYSIS_NOT_FOUND', 'no analysis exists for this commit');

  const effect = applyDecision(record, decision);
  if (effect.kind === 'WRONG_STATE') return reply({ ...keyed, outcome: 'WRONG_STATE' });
  const next = effect.record;
  if (effect.changed) {
    await deps.store.putRecord(next);
    if (decision.type === 'SIGNOFF' && 'signoffs' in next) {
      const signoff = next.signoffs.find((entry) => entry.spaceKey === decision.spaceKey);
      if (signoff !== undefined) await appendAudit(deps, decision.key, { type: 'SIGNOFF_RECORDED', signoff });
    }
    if (next.state === 'RISK_ACCEPTED') await appendAudit(deps, decision.key, { type: 'RISK_ACCEPTED', exception: next.exception });
  }
  if (next.state !== 'SIGNOFF_REQUIRED' && next.state !== 'CLEARED' && next.state !== 'RISK_ACCEPTED') {
    return reply({ ...keyed, outcome: 'WRONG_STATE' });
  }
  return reply({ ...keyed, outcome: 'APPLIED', state: next.state });
}

export async function handleGateRequest(
  deps: GateDeps,
  request: WebTriggerRequestShape,
): Promise<WebTriggerResponseShape> {
  try {
    const authenticated = authenticate(request, deps.verifyKeys, deps.now().getTime());
    if (!authenticated.ok) return authenticated.error;
    switch (authenticated.value.path) {
      case GATE_ROUTES.verdict:
        return await storeVerdict(deps, authenticated.value.body);
      case GATE_ROUTES.decision:
        return await storeDecision(deps, authenticated.value.body);
      default:
        return apiError('UNKNOWN_ROUTE', 'no such route');
    }
  } catch (cause) {
    console.error('gate router failure', errorMessage(cause));
    return apiError('INTERNAL', 'internal error');
  }
}
