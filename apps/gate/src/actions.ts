/**
 * Sign-off and accept-risk, as Gate sees them: check the request is about the current
 * head and the right state, then ask Brain. Brain verifies eligibility (roster, author
 * exclusion) and pushes the decision back; Gate's KVS only changes through that push.
 *
 * `actor` must come from the Forge invocation context, never from user-supplied input.
 */
import {
  CONTRACT_VERSION,
  parseIsoDate,
  type AcceptRiskResponse,
  type AnalysisKey,
  type CallError,
  type DecisionRejection,
  type Result,
  type RosterMember,
  type SignoffResponse,
  type SpaceKey,
} from '@ripple/contracts';
import type { GateDeps } from './ports.ts';

export type ActionError = { readonly kind: 'REJECTED'; readonly reason: DecisionRejection | 'INVALID_DUE_DATE' } | { readonly kind: 'BRAIN'; readonly error: CallError };

async function precheck(deps: GateDeps, key: AnalysisKey): Promise<DecisionRejection | null> {
  const { headSha, ...pr } = key;
  const pointer = await deps.store.getPointer(pr);
  if (pointer?.headSha !== headSha) return 'STALE_HEAD';
  const record = await deps.store.getRecord(key);
  return record?.state === 'SIGNOFF_REQUIRED' ? null : 'WRONG_STATE';
}

export async function requestSignoff(deps: GateDeps, key: AnalysisKey, spaceKey: SpaceKey, actor: RosterMember): Promise<Result<SignoffResponse, ActionError>> {
  const refused = await precheck(deps, key);
  if (refused !== null) return { ok: false, error: { kind: 'REJECTED', reason: refused } };
  const response = await deps.brain.signoff({ v: CONTRACT_VERSION, key, spaceKey, actor });
  return response.ok ? response : { ok: false, error: { kind: 'BRAIN', error: response.error } };
}

export async function requestAcceptRisk(
  deps: GateDeps,
  key: AnalysisKey,
  actor: RosterMember,
  justification: string,
  dueDate: string,
): Promise<Result<AcceptRiskResponse, ActionError>> {
  const refused = await precheck(deps, key);
  if (refused !== null) return { ok: false, error: { kind: 'REJECTED', reason: refused } };
  const due = parseIsoDate(dueDate);
  if (due === null) return { ok: false, error: { kind: 'REJECTED', reason: 'INVALID_DUE_DATE' } };
  const response = await deps.brain.acceptRisk({ v: CONTRACT_VERSION, key, actor, justification, dueDate: due });
  return response.ok ? response : { ok: false, error: { kind: 'BRAIN', error: response.error } };
}
