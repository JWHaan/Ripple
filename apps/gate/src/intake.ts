/**
 * The single evaluation pipeline for a pull request head. Both the PR event hook and the
 * merge check call it, so a delayed or lost trigger can never leave a commit unclassified.
 *
 * Idempotent on {workspaceUuid, repoUuid, prId, headSha}: a head that already has a
 * decision is returned from storage without any further Bitbucket or Brain traffic.
 */
import {
  CONTRACT_VERSION,
  isoNow,
  type AnalysisKey,
  type AnalyzeRequest,
  type CallError,
  type DiffSummary,
  type PrRef,
} from '@ripple/contracts';
import { classifyDiff } from './noise-gate.ts';
import type { BitbucketError, GateDeps } from './ports.ts';
import { resolveServiceDeclaration } from './ripple-yml.ts';
import { EMPTY_DIFF, applyVerdict, failed, invalidatedBy, noRippleConfig, noSensitiveSurface, pending } from './state.ts';
import {
  MAX_ANALYSIS_ATTEMPTS,
  PENDING_STALE_MS,
  type AnalysisPendingRecord,
  type AuditEvent,
  type GateRecord,
  type PullRequestSnapshot,
} from './types.ts';

/** Log prefix matching Brain's `PR <id> @ <sha>` so the two apps' lines can be read together. */
export function logLabel(key: AnalysisKey): string {
  return `PR ${key.prId} @ ${key.headSha}`;
}

/** Another caller (hook or merge check) won the dispatch claim and owns the Brain request. */
interface AlreadyDispatched {
  readonly alreadyDispatched: AnalysisPendingRecord;
}

/** Diffs larger than this are classified on their first N characters and marked truncated. */
export const MAX_DIFF_CHARS = 2_000_000;

export type IntakeOutcome =
  | { readonly kind: 'EVALUATED'; readonly snapshot: PullRequestSnapshot; readonly record: GateRecord }
  | { readonly kind: 'NOT_OPEN'; readonly snapshot: PullRequestSnapshot }
  | { readonly kind: 'BITBUCKET_UNAVAILABLE'; readonly error: BitbucketError };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AuditInput = DistributiveOmit<AuditEvent, 'id' | 'pr' | 'headSha' | 'at'>;

async function audit(deps: GateDeps, key: AnalysisKey, event: AuditInput): Promise<void> {
  const { headSha, ...pr } = key;
  await deps.store.appendAudit({ ...event, id: deps.newId(), pr, headSha, at: isoNow(deps.now()) } as AuditEvent);
}

function needsDispatch(record: GateRecord, now: Date): boolean {
  if (record.state === 'ANALYSIS_PENDING') {
    return record.attempts < MAX_ANALYSIS_ATTEMPTS && now.getTime() - Date.parse(record.requestedAt) > PENDING_STALE_MS;
  }
  if (record.state === 'ANALYSIS_FAILED') {
    return record.failure.retryable && record.attempts < MAX_ANALYSIS_ATTEMPTS;
  }
  return false;
}

function brainFailure(error: CallError): { code: 'BRAIN_UNREACHABLE' | 'BRAIN_REJECTED'; message: string; retryable: boolean } {
  if (error.kind === 'REJECTED') {
    // 4xx means Brain understood and refused the request; resending the same bytes cannot help.
    return { code: 'BRAIN_REJECTED', message: error.message, retryable: error.status >= 500 };
  }
  return { code: 'BRAIN_UNREACHABLE', message: error.message, retryable: true };
}

async function supersedeIfHeadMoved(deps: GateDeps, key: AnalysisKey): Promise<void> {
  const { headSha, ...pr } = key;
  const pointer = await deps.store.getPointer(pr);
  if (pointer?.headSha === headSha) return;
  if (pointer !== null) {
    const old = await deps.store.getRecord({ ...pr, headSha: pointer.headSha });
    const invalidated = invalidatedBy(old);
    await audit(deps, { ...pr, headSha: pointer.headSha }, {
      type: 'HEAD_SUPERSEDED',
      newHeadSha: headSha,
      invalidatedSignoffs: invalidated.signoffs,
      invalidatedException: invalidated.exception,
    });
  }
  await deps.store.setPointer({ pr, headSha, updatedAt: isoNow(deps.now()) });
}

async function analyse(
  deps: GateDeps,
  snapshot: PullRequestSnapshot,
  key: AnalysisKey,
  attempt: number,
): Promise<GateRecord | AlreadyDispatched> {
  const at = () => isoNow(deps.now());
  const fail = (diff: DiffSummary, error: BitbucketError) =>
    failed(key, diff, attempt, { code: 'DIFF_UNAVAILABLE', message: error.message, retryable: error.kind !== 'FORBIDDEN' }, at());

  const diffText = await deps.bitbucket.getDiff(snapshot);
  if (!diffText.ok) return fail(EMPTY_DIFF, diffText.error);

  const oversized = diffText.value.length > MAX_DIFF_CHARS;
  const diff = classifyDiff(oversized ? diffText.value.slice(0, MAX_DIFF_CHARS) : diffText.value, oversized);
  await audit(deps, key, { type: 'CLASSIFIED', sensitive: diff.findings.length > 0, findingCount: diff.findings.length });
  const hits = [...new Set(diff.findings.map((finding) => `${finding.ruleId} (${finding.filePath})`))];
  console.log(
    `classified ${logLabel(key)}: ${diff.findings.length} finding(s)` +
      (hits.length > 0 ? `: ${hits.join(', ')}` : '') +
      (oversized ? ' [diff truncated]' : ''),
  );

  // Blast radius is zero by construction: nothing sensitive was touched.
  if (diff.findings.length === 0) return noSensitiveSurface(key, at());

  const declared = await resolveServiceDeclaration(deps.bitbucket, snapshot);
  if (!declared.ok) {
    if (declared.error.kind === 'BITBUCKET') return fail(diff, declared.error.error);
    // A broken declaration blocks until fixed; it must not degrade to "not in catalog".
    return failed(key, diff, attempt, { code: 'INVALID_RIPPLE_CONFIG', message: declared.error.message, retryable: false }, at());
  }
  if (declared.value === null) return noRippleConfig(key, diff, at());

  const request: AnalyzeRequest = {
    v: CONTRACT_VERSION,
    key,
    repo: snapshot.repo,
    pullRequest: snapshot.descriptor,
    diff,
    service: declared.value,
  };

  const waiting = pending(key, diff, attempt, at());
  // The PR hook and the merge check usually evaluate a new head within seconds of each
  // other; only the first to claim this attempt calls Brain.
  if (!(await deps.store.claimDispatch(key, attempt))) {
    console.log(`analysis attempt ${attempt} for ${logLabel(key)} already dispatched by another invocation; not sending again`);
    return { alreadyDispatched: waiting };
  }

  // Persist PENDING before the call so a verdict push that races the response finds a record.
  await deps.store.putRecord(waiting);
  await audit(deps, key, { type: 'ANALYSIS_REQUESTED', attempt });
  console.log(`analysis attempt ${attempt} requested from Brain for ${logLabel(key)}`);

  const response = await deps.brain.analyze(request);
  if (!response.ok) return failed(key, diff, attempt, brainFailure(response.error), at());
  if (response.value.state !== 'COMPLETE') return waiting;

  await audit(deps, key, { type: 'VERDICT_RECEIVED', status: response.value.verdict.status });
  const decided = applyVerdict(waiting, response.value.verdict, at());
  console.log(`verdict for ${logLabel(key)} (in response): ${waiting.state} -> ${decided.state} (${response.value.verdict.status})`);
  return decided;
}

export async function evaluateHead(deps: GateDeps, pr: PrRef): Promise<IntakeOutcome> {
  const fetched = await deps.bitbucket.getPullRequest(pr);
  if (!fetched.ok) return { kind: 'BITBUCKET_UNAVAILABLE', error: fetched.error };
  const snapshot = fetched.value;
  if (snapshot.state !== 'OPEN') return { kind: 'NOT_OPEN', snapshot };

  const key: AnalysisKey = { ...snapshot.ref, headSha: snapshot.headSha };
  await supersedeIfHeadMoved(deps, key);

  const existing = await deps.store.getRecord(key);
  if (existing !== null && !needsDispatch(existing, deps.now())) {
    return { kind: 'EVALUATED', snapshot, record: existing };
  }

  const attempt = existing !== null && 'attempts' in existing ? existing.attempts + 1 : 1;
  const analysed = await analyse(deps, snapshot, key, attempt);
  if ('alreadyDispatched' in analysed) {
    // The claimant owns the record; report what it has stored so far without writing.
    const latest = await deps.store.getRecord(key);
    return { kind: 'EVALUATED', snapshot, record: latest ?? analysed.alreadyDispatched };
  }
  const record = analysed;

  // A verdict push may have landed while we were waiting on Brain; never overwrite a decision.
  const latest = await deps.store.getRecord(key);
  if (latest !== null && latest.state !== 'ANALYSIS_PENDING' && latest.state !== 'ANALYSIS_FAILED' && record.state === 'ANALYSIS_PENDING') {
    return { kind: 'EVALUATED', snapshot, record: latest };
  }
  await deps.store.putRecord(record);
  return { kind: 'EVALUATED', snapshot, record };
}

export { audit as appendAudit };
