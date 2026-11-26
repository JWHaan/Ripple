/**
 * Pure gate-state transitions. No I/O: every function maps (record, input) -> record,
 * so the whole state machine is unit-testable and deterministic.
 */
import {
  CONTRACT_VERSION,
  type AnalysisKey,
  type Decision,
  type DiffSummary,
  type IsoTimestamp,
  type Verdict,
} from '@ripple/contracts';
import type {
  AnalysisFailedRecord,
  NotInCatalogRecord,
  AnalysisPendingRecord,
  GateRecord,
  NoSensitiveSurfaceRecord,
} from './types.ts';

export const EMPTY_DIFF: DiffSummary = {
  filesChanged: 0,
  linesAdded: 0,
  linesRemoved: 0,
  findings: [],
  truncated: false,
};

export function noSensitiveSurface(key: AnalysisKey, at: IsoTimestamp): NoSensitiveSurfaceRecord {
  return { v: CONTRACT_VERSION, key, state: 'NO_SENSITIVE_SURFACE', createdAt: at, updatedAt: at };
}

export function pending(key: AnalysisKey, diff: DiffSummary, attempts: number, at: IsoTimestamp): AnalysisPendingRecord {
  return {
    v: CONTRACT_VERSION,
    key,
    state: 'ANALYSIS_PENDING',
    diff,
    requestedAt: at,
    attempts,
    createdAt: at,
    updatedAt: at,
  };
}

export function failed(
  key: AnalysisKey,
  diff: DiffSummary,
  attempts: number,
  failure: Omit<AnalysisFailedRecord['failure'], 'failedAt'>,
  at: IsoTimestamp,
): AnalysisFailedRecord {
  return {
    v: CONTRACT_VERSION,
    key,
    state: 'ANALYSIS_FAILED',
    diff,
    attempts,
    failure: { ...failure, failedAt: at },
    createdAt: at,
    updatedAt: at,
  };
}

export function noRippleConfig(key: AnalysisKey, diff: DiffSummary, at: IsoTimestamp): NotInCatalogRecord {
  return {
    v: CONTRACT_VERSION,
    key,
    state: 'NOT_IN_CATALOG',
    diff,
    reason: 'NO_RIPPLE_CONFIG',
    createdAt: at,
    updatedAt: at,
  };
}

/** Records that a verdict may still be applied to. Anything else already holds a decision. */
export function awaitsVerdict(record: GateRecord): record is AnalysisPendingRecord | AnalysisFailedRecord {
  return record.state === 'ANALYSIS_PENDING' || record.state === 'ANALYSIS_FAILED';
}

/** Applies Brain's verdict. The narrative inside the verdict is never consulted. */
export function applyVerdict(
  record: AnalysisPendingRecord | AnalysisFailedRecord,
  verdict: Verdict,
  at: IsoTimestamp,
): GateRecord {
  const base = { v: record.v, key: record.key, diff: record.diff, createdAt: record.createdAt, updatedAt: at };
  switch (verdict.status) {
    case 'FAILED':
      return {
        ...base,
        state: 'ANALYSIS_FAILED',
        attempts: record.attempts,
        failure: { ...verdict.error, failedAt: at },
      };
    case 'COMPLETE':
      return verdict.signoffRequirements.length === 0
        ? { ...base, state: 'CLEARED', verdict, signoffs: [] }
        : { ...base, state: 'SIGNOFF_REQUIRED', verdict, signoffs: [] };
  }
}

/** What a new head SHA invalidates on the record it supersedes (for the audit log). */
export function invalidatedBy(record: GateRecord | null): { signoffs: number; exception: boolean } {
  if (record === null) return { signoffs: 0, exception: false };
  const signoffs = 'signoffs' in record ? record.signoffs.length : 0;
  return { signoffs, exception: record.state === 'RISK_ACCEPTED' };
}

export type DecisionEffect =
  | { readonly kind: 'APPLIED'; readonly record: GateRecord; readonly changed: boolean }
  | { readonly kind: 'WRONG_STATE' };

/** Applies a decision Brain has already verified. Idempotent: replays change nothing. */
export function applyDecision(record: GateRecord, decision: Decision): DecisionEffect {
  const unchanged: DecisionEffect = { kind: 'APPLIED', record, changed: false };
  if (decision.type === 'RISK_ACCEPTED') {
    if (record.state === 'RISK_ACCEPTED') return unchanged;
    if (record.state !== 'SIGNOFF_REQUIRED') return { kind: 'WRONG_STATE' };
    const signed = new Set(record.signoffs.map((signoff) => signoff.spaceKey));
    return {
      kind: 'APPLIED',
      changed: true,
      record: {
        ...record,
        state: 'RISK_ACCEPTED',
        updatedAt: decision.decidedAt,
        exception: {
          acceptedBy: decision.acceptedBy,
          acceptedAs: decision.acceptedAs,
          justification: decision.justification,
          dueDate: decision.dueDate,
          outstandingSpaces: record.verdict.signoffRequirements.map((r) => r.spaceKey).filter((key) => !signed.has(key)),
          ticket: decision.ticket,
          headSha: record.key.headSha,
          acceptedAt: decision.decidedAt,
        },
      },
    };
  }

  if (record.state !== 'SIGNOFF_REQUIRED' && record.state !== 'CLEARED') return { kind: 'WRONG_STATE' };
  if (!record.verdict.signoffRequirements.some((requirement) => requirement.spaceKey === decision.spaceKey)) return { kind: 'WRONG_STATE' };
  if (record.signoffs.some((signoff) => signoff.spaceKey === decision.spaceKey)) return unchanged;
  if (record.state === 'CLEARED') return unchanged;

  const signoffs = [
    ...record.signoffs,
    { spaceKey: decision.spaceKey, signer: decision.signer, authorization: decision.authorization, headSha: record.key.headSha, signedAt: decision.decidedAt },
  ];
  const complete = record.verdict.signoffRequirements.every((r) => signoffs.some((signoff) => signoff.spaceKey === r.spaceKey));
  return {
    kind: 'APPLIED',
    changed: true,
    record: { ...record, state: complete ? 'CLEARED' : 'SIGNOFF_REQUIRED', signoffs, updatedAt: decision.decidedAt },
  };
}
