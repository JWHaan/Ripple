/** Brain web trigger router: the inbound half of the contract (Gate -> Brain). */
import {
  BRAIN_ROUTES,
  CONTRACT_VERSION,
  analyzeRequestSchema,
  apiError,
  authenticate,
  decodeJson,
  errorMessage,
  isoNow,
  jsonResponse,
  verdictQueryRequestSchema,
  type AnalyzeResponse,
  type Verdict,
  type VerdictQueryResponse,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { handleAcceptRisk, handleSignoff } from './decisions.ts';
import type { BrainDeps } from './ports.ts';
import { ANALYSIS_STUCK_MS, type AnalysisRecord } from './types.ts';

function isStuck(record: AnalysisRecord, now: Date): boolean {
  return record.state !== 'COMPLETE' && now.getTime() - Date.parse(record.updatedAt) > ANALYSIS_STUCK_MS;
}

/** A finished analysis is final unless it failed in a way worth retrying. */
function finalVerdict(record: AnalysisRecord): Verdict | null {
  if (record.state !== 'COMPLETE') return null;
  return record.verdict.status === 'FAILED' && record.verdict.error.retryable ? null : record.verdict;
}

async function analyze(deps: BrainDeps, body: string): Promise<WebTriggerResponseShape> {
  const decoded = decodeJson(analyzeRequestSchema, body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const request = decoded.value;
  const reply = (status: number, response: AnalyzeResponse) => jsonResponse(status, response);
  const keyed = { v: CONTRACT_VERSION, key: request.key };

  const existing = await deps.store.getAnalysis(request.key);
  if (existing !== null) {
    const final = finalVerdict(existing);
    if (final !== null) return reply(200, { ...keyed, state: 'COMPLETE', verdict: final });
    if (existing.state !== 'COMPLETE' && !isStuck(existing, deps.now())) return reply(200, { ...keyed, state: 'IN_PROGRESS' });
  }

  // Stored before enqueueing so the consumer can never run ahead of its own input.
  await deps.store.putAnalysis({ state: 'QUEUED', v: CONTRACT_VERSION, key: request.key, request, updatedAt: isoNow(deps.now()) });
  const queued = await deps.queue.enqueue(request.key);
  if (!queued.ok) {
    console.error(`enqueue failed: ${queued.error}`);
    return apiError('INTERNAL', 'analysis could not be queued');
  }
  return reply(202, { ...keyed, state: 'ACCEPTED' });
}

async function verdict(deps: BrainDeps, body: string): Promise<WebTriggerResponseShape> {
  const decoded = decodeJson(verdictQueryRequestSchema, body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const keyed = { v: CONTRACT_VERSION, key: decoded.value.key };
  const record = await deps.store.getAnalysis(decoded.value.key);
  const response: VerdictQueryResponse =
    record === null
      ? { ...keyed, state: 'UNKNOWN' }
      : record.state === 'COMPLETE'
        ? { ...keyed, state: 'COMPLETE', verdict: record.verdict }
        : { ...keyed, state: 'IN_PROGRESS' };
  return jsonResponse(200, response);
}

export async function handleBrainRequest(
  deps: BrainDeps,
  request: WebTriggerRequestShape,
): Promise<WebTriggerResponseShape> {
  try {
    const authenticated = authenticate(request, deps.verifyKeys, deps.now().getTime());
    if (!authenticated.ok) return authenticated.error;
    switch (authenticated.value.path) {
      case BRAIN_ROUTES.analyze:
        return await analyze(deps, authenticated.value.body);
      case BRAIN_ROUTES.verdict:
        return await verdict(deps, authenticated.value.body);
      case BRAIN_ROUTES.signoff:
        return await handleSignoff(deps, authenticated.value.body);
      case BRAIN_ROUTES.acceptRisk:
        return await handleAcceptRisk(deps, authenticated.value.body);
      default:
        return apiError('UNKNOWN_ROUTE', 'no such route');
    }
  } catch (cause) {
    console.error('brain router failure', errorMessage(cause));
    return apiError('INTERNAL', 'internal error');
  }
}
