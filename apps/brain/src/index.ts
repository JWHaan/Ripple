/**
 * Ripple Brain — Forge entry points. Each export is referenced by `handler: index.<name>`
 * in manifest.yml. All logic lives in the modules these delegate to.
 */
import {
  analysisKeySchema,
  apiError,
  decodeValue,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { z } from 'zod';
import { loadBrainDeps } from './forge/deps.ts';
import { PROBE_PATH, handleProbeRequest, probeJobSchema, runGraphProbe } from './forge/probe.ts';
import { store } from './forge/store.ts';
import { handleBrainRequest } from './router.ts';
import { runAnalysisJob } from './worker.ts';

export async function brainApi(request: WebTriggerRequestShape, context: unknown): Promise<WebTriggerResponseShape> {
  const deps = loadBrainDeps(context, null);
  if (!deps.ok) {
    console.error(`ripple brain misconfigured: ${deps.error.missing} is not set`);
    return apiError('INTERNAL', 'brain is not configured');
  }
  // Smoke-test diagnostic route; see forge/probe.ts.
  if (request.userPath === PROBE_PATH) return handleProbeRequest(request, deps.value.verifyKeys);
  return handleBrainRequest(deps.value, request);
}

const jobSchema = z.object({ body: z.object({ key: analysisKeySchema }) });

export async function runAnalysis(event: unknown, context: unknown): Promise<void> {
  const probe = decodeValue(probeJobSchema, event);
  if (probe.ok) return runGraphProbe(probe.value.body.probe);

  const job = decodeValue(jobSchema, event);
  if (!job.ok) {
    console.error(`ripple brain dropped a malformed analysis job: ${job.error.message}`);
    return;
  }
  const { key } = job.value.body;
  const record = await store.getAnalysis(key);
  const author = record !== null && record.state !== 'COMPLETE' ? record.request.pullRequest.authorAccountId : null;

  const deps = loadBrainDeps(context, author);
  if (!deps.ok) {
    console.error(`ripple brain misconfigured: ${deps.error.missing} is not set`);
    return;
  }
  const outcome = await runAnalysisJob(deps.value, key);
  console.log(
    outcome.kind === 'DONE'
      ? `analysis ${outcome.verdict.status} for PR ${key.prId} @ ${key.headSha} (pushed: ${outcome.pushed})`
      : `analysis skipped: ${outcome.reason}`,
  );
}
