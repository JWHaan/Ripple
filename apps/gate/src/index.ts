/**
 * Ripple Gate — Forge entry points. Each export is referenced by `handler: index.<name>`
 * in manifest.yml. All logic lives in the modules these delegate to.
 */
import { apiError, type WebTriggerRequestShape, type WebTriggerResponseShape } from '@ripple/contracts';
import { loadGateDeps } from './forge/deps.ts';
import { SYNTHETIC_PATHS, handleSyntheticRequest } from './forge/synthetic.ts';
import { evaluateMergeCheck, toMergeCheckResponse } from './merge-check.ts';
import { handlePullRequestEvent } from './pr-hook.ts';
import { handleGateRequest } from './router.ts';
import type { MergeCheckEvent, MergeCheckResponse, PullRequestEvent } from './types.ts';

export async function onPullRequestEvent(event: PullRequestEvent): Promise<void> {
  console.log(`pr event ${event.eventType} pr=${event.pullrequest?.id} repo=${event.repository?.uuid}`);
  const deps = loadGateDeps();
  if (!deps.ok) {
    console.error(`ripple gate misconfigured: ${deps.error.missing} is not set`);
    return;
  }
  const result = await handlePullRequestEvent(deps.value, event);
  if (!result.ok) console.error('ripple gate ignored a malformed pull request event');
  else if (result.value.kind === 'BITBUCKET_UNAVAILABLE') console.error(`ripple gate: ${result.value.error.message}`);
}

export async function runMergeCheck(event: MergeCheckEvent): Promise<MergeCheckResponse> {
  const deps = loadGateDeps();
  if (!deps.ok) {
    // Fail closed: an unconfigured gate must not wave merges through.
    return { success: false, message: `[FAILED] Ripple is not configured: ${deps.error.missing} is not set.` };
  }
  const outcome = await evaluateMergeCheck(deps.value, event);
  console.log(`merge check ${event.trigger?.type} pr=${event.pullrequest?.id} -> ${outcome.status} (${outcome.state ?? 'no record'}): ${outcome.message}`);
  return toMergeCheckResponse(outcome);
}

export async function gateApi(request: WebTriggerRequestShape): Promise<WebTriggerResponseShape> {
  const deps = loadGateDeps();
  if (!deps.ok) return apiError('INTERNAL', 'gate is not configured');
  // Smoke-test diagnostic routes; see forge/synthetic.ts.
  if (Object.values<string>(SYNTHETIC_PATHS).includes(request.userPath)) {
    return handleSyntheticRequest(deps.value, request);
  }
  return handleGateRequest(deps.value, request);
}
