/**
 * SMOKE-TEST DIAGNOSTIC — not part of the product. Remove once a real pull request has
 * exercised the loop. Both routes are HMAC-signed like every other route.
 *
 * POST /v1/diagnostics/synthetic-pr  stands in for the Bitbucket PR hook: runs the real noise
 *   gate and ripple.yml parser on supplied text, seeds the pending record, calls Brain.
 * POST /v1/diagnostics/record        reads the record back and runs the real merge-check decision.
 */
import {
  CONTRACT_VERSION,
  analysisKeySchema,
  apiError,
  authenticate,
  decodeJson,
  isoNow,
  jsonResponse,
  parseAccountId,
  type AnalyzeRequest,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { WhereConditions, kvs } from '@forge/kvs';
import { z } from 'zod';
import { appendAudit } from '../intake.ts';
import { decide } from '../merge-check.ts';
import { classifyDiff } from '../noise-gate.ts';
import type { GateDeps } from '../ports.ts';
import { parseRippleYml } from '../ripple-yml.ts';
import { pending } from '../state.ts';
import type { GateRecord } from '../types.ts';

export const SYNTHETIC_PATHS = { seed: '/v1/diagnostics/synthetic-pr', record: '/v1/diagnostics/record', list: '/v1/diagnostics/list' } as const;

const seedSchema = z.object({ key: analysisKeySchema, authorAccountId: z.string(), rippleYml: z.string(), diff: z.string() });
const readSchema = z.object({ key: analysisKeySchema });

export async function handleSyntheticRequest(deps: GateDeps, request: WebTriggerRequestShape): Promise<WebTriggerResponseShape> {
  const authenticated = authenticate(request, deps.verifyKeys);
  if (!authenticated.ok) return authenticated.error;

  if (authenticated.value.path === SYNTHETIC_PATHS.list) {
    // Everything Gate has stored: PR pointers, gate records (with the merge decision) and the audit trail.
    const page = async (prefix: string) => (await kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100).getMany<unknown>()).results;
    const records = (await page('gate:')).map((entry) => {
      const record = entry.value as GateRecord;
      return { key: entry.key, state: record.state, record, mergeCheck: decide(record) };
    });
    return jsonResponse(200, { pointers: await page('pr:'), records, audit: await page('audit:') });
  }

  if (authenticated.value.path === SYNTHETIC_PATHS.record) {
    const decoded = decodeJson(readSchema, authenticated.value.body);
    if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
    const record = await deps.store.getRecord(decoded.value.key);
    return jsonResponse(200, { record, mergeCheck: record === null ? null : decide(record) });
  }

  const decoded = decodeJson(seedSchema, authenticated.value.body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const { key } = decoded.value;
  const declared = parseRippleYml(decoded.value.rippleYml);
  if (!declared.ok) return apiError('MALFORMED_PAYLOAD', declared.error);
  const diff = classifyDiff(decoded.value.diff);
  if (diff.findings.length === 0) return jsonResponse(200, { seeded: false, reason: 'noise gate found no sensitive surface' });

  const { headSha, ...pr } = key;
  await deps.store.setPointer({ pr, headSha, updatedAt: isoNow(deps.now()) });
  await deps.store.putRecord(pending(key, diff, 1, isoNow(deps.now())));
  await appendAudit(deps, key, { type: 'ANALYSIS_REQUESTED', attempt: 1 });

  const analyze: AnalyzeRequest = {
    v: CONTRACT_VERSION,
    key,
    repo: { fullName: 'synthetic/auth-service', url: 'https://bitbucket.org/synthetic/auth-service' },
    pullRequest: {
      title: 'Synthetic pull request',
      url: `https://bitbucket.org/synthetic/auth-service/pull-requests/${key.prId}`,
      authorAccountId: parseAccountId(decoded.value.authorAccountId),
      sourceBranch: 'synthetic',
      destinationBranch: 'main',
    },
    diff,
    service: { ...declared.value, configPath: 'ripple.yml', configSource: 'PR_HEAD' },
  };
  const response = await deps.brain.analyze(analyze);
  return jsonResponse(200, { seeded: true, findings: diff.findings.map((f) => f.ruleId), service: analyze.service, brain: response });
}
