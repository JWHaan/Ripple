/**
 * Merge check evaluator. The decision is a pure function of the stored GateRecord for the
 * current head SHA; Brain is never consulted on the merge path and no LLM output is read.
 *
 *   PASSED      the gate applied and is satisfied
 *   FAILED      the gate applies and is not satisfied (or its state cannot be established)
 *   INELIGIBLE  the gate does not apply to this pull request; merging is not blocked
 */
import type { GateDeps } from './ports.ts';
import { appendAudit, evaluateHead } from './intake.ts';
import { prRefFromEvent } from './pr-hook.ts';
import type { GateRecord, GateState, MergeCheckEvent, MergeCheckResponse } from './types.ts';

export type MergeCheckStatus = 'PASSED' | 'FAILED' | 'INELIGIBLE';

export const CHECK_STATUS = {
  NO_SENSITIVE_SURFACE: 'INELIGIBLE',
  NOT_IN_CATALOG: 'INELIGIBLE',
  ANALYSIS_PENDING: 'FAILED',
  ANALYSIS_FAILED: 'FAILED',
  SIGNOFF_REQUIRED: 'FAILED',
  CLEARED: 'PASSED',
  RISK_ACCEPTED: 'PASSED',
} as const satisfies Record<GateState, MergeCheckStatus>;

export interface MergeCheckOutcome {
  readonly status: MergeCheckStatus;
  /** null when no record could be established (malformed event, Bitbucket down, PR not open). */
  readonly state: GateState | null;
  readonly message: string;
}

export function outstandingSpaces(record: Extract<GateRecord, { state: 'SIGNOFF_REQUIRED' }>): string[] {
  const signed = new Set(record.signoffs.map((signoff) => signoff.spaceKey));
  return record.verdict.signoffRequirements
    .filter((requirement) => !signed.has(requirement.spaceKey))
    .map((requirement) => {
      const owners = requirement.ownership.teams.map((team) => team.displayName).join(' / ') || requirement.ownership.lead?.displayName;
      return owners === undefined ? requirement.spaceKey : `${requirement.spaceKey} (${owners})`;
    });
}

/** Pure: stored record -> outcome. */
export function decide(record: GateRecord): MergeCheckOutcome {
  const status = CHECK_STATUS[record.state];
  const of = (message: string): MergeCheckOutcome => ({ status, state: record.state, message });
  switch (record.state) {
    case 'NO_SENSITIVE_SURFACE':
      return of('No cross-cutting surface touched; Ripple does not apply to this pull request.');
    case 'NOT_IN_CATALOG':
      return of('This repository has no ripple.yml, so no blast radius can be computed. Add one to bring it under the gate.');
    case 'ANALYSIS_PENDING':
      return of('Blast-radius analysis for the current commit is in progress. Re-run this check shortly.');
    case 'ANALYSIS_FAILED':
      return of(`Blast-radius analysis failed (${record.failure.code}): ${record.failure.message}`);
    case 'SIGNOFF_REQUIRED':
      return of(`Sign-off required from: ${outstandingSpaces(record).join(', ')}. Alternatively the author can accept the risk in the Ripple panel.`);
    case 'CLEARED':
      return of(
        record.verdict.signoffRequirements.length === 0
          ? 'Sensitive surface touched, but no downstream owner requires sign-off.'
          : 'Every downstream space has signed off on this commit.',
      );
    case 'RISK_ACCEPTED':
      return of(`Risk accepted by ${record.exception.acceptedBy.displayName}; tracked in ${record.exception.ticket.issueKey}.`);
  }
}

export async function evaluateMergeCheck(deps: GateDeps, event: MergeCheckEvent): Promise<MergeCheckOutcome> {
  const pr = prRefFromEvent(event);
  if (!pr.ok) {
    return { status: 'FAILED', state: null, message: 'Ripple could not identify this pull request from the merge check payload.' };
  }

  const intake = await evaluateHead(deps, pr.value);
  if (intake.kind === 'BITBUCKET_UNAVAILABLE') {
    // Fail closed: without the head SHA there is no way to know which record applies.
    return { status: 'FAILED', state: null, message: `Ripple could not read this pull request from Bitbucket: ${intake.error.message}` };
  }
  if (intake.kind === 'NOT_OPEN') {
    return { status: 'INELIGIBLE', state: null, message: 'Pull request is not open.' };
  }

  const outcome = decide(intake.record);
  await appendAudit(deps, intake.record.key, {
    type: 'MERGE_CHECK_EVALUATED',
    trigger: event.trigger?.type ?? 'unknown',
    state: intake.record.state,
    passed: outcome.status !== 'FAILED',
  });
  return outcome;
}

/** Forge only understands success / failure: INELIGIBLE does not block the merge. */
export function toMergeCheckResponse(outcome: MergeCheckOutcome): MergeCheckResponse {
  return { success: outcome.status !== 'FAILED', message: `[${outcome.status}] ${outcome.message}` };
}
