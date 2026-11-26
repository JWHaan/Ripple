/**
 * Queue consumer: runs one analysis end to end and pushes the verdict to Gate.
 *
 * Every failure becomes a typed FAILED verdict that is stored and pushed, so Gate always
 * learns the outcome. Gate fails closed on FAILED; nothing here can produce a pass by accident.
 */
import {
  CONTRACT_VERSION,
  isoNow,
  type AnalysisErrorCode,
  type AnalysisKey,
  type AnalyzeRequest,
  type ImpactedSpace,
  type SignoffRequirement,
  type SpaceKey,
  type Verdict,
} from '@ripple/contracts';
import { generateNarrative } from './narrative.ts';
import { resolveOwnership } from './ownership.ts';
import type { BrainDeps, DirectoryError, JiraSpace } from './ports.ts';

export type WorkerOutcome =
  | { readonly kind: 'DONE'; readonly verdict: Verdict; readonly pushed: boolean }
  | { readonly kind: 'SKIPPED'; readonly reason: 'NO_SUCH_ANALYSIS' | 'ALREADY_COMPLETE' };

type Failure = { code: AnalysisErrorCode; message: string; retryable: boolean };

function directoryFailure(error: DirectoryError): Failure {
  switch (error.kind) {
    case 'FORBIDDEN':
      return { code: 'JIRA_FORBIDDEN', message: error.message, retryable: false };
    case 'UNAVAILABLE':
      return { code: 'JIRA_UNAVAILABLE', message: error.message, retryable: true };
    case 'MALFORMED':
      return { code: 'INTERNAL', message: error.message, retryable: false };
  }
}

async function analyse(deps: BrainDeps, request: AnalyzeRequest): Promise<Verdict> {
  const base = () => ({ v: CONTRACT_VERSION, key: request.key, analyzedAt: isoNow(deps.now()) });
  const failed = (error: Failure): Verdict => ({ ...base(), status: 'FAILED', error });

  /** A declared space that Jira does not know is a configuration error and blocks the merge. */
  const lookup = async (key: SpaceKey, role: string): Promise<JiraSpace | Failure> => {
    const space = await deps.spaces.getSpace(key);
    if (!space.ok) return directoryFailure(space.error);
    return space.value ?? { code: 'UNKNOWN_SPACE', message: `ripple.yml ${role} space ${key} does not exist in Jira`, retryable: false };
  };

  const serviceSpace = await lookup(request.service.spaceKey, 'service');
  if ('code' in serviceSpace) return failed(serviceSpace);

  // Blast radius = the declared downstream spaces. Ownership is resolved per space.
  const impacted: ImpactedSpace[] = [];
  const signoffRequirements: SignoffRequirement[] = [];
  for (const key of request.service.downstream) {
    const space = await lookup(key, 'downstream');
    if ('code' in space) return failed(space);
    const { ownership, roster } = await resolveOwnership(deps.graph, space);
    impacted.push({ spaceKey: key, name: space.name, ownership });
    signoffRequirements.push({ spaceKey: key, spaceName: space.name, ownership, roster });
  }

  // Everything that decides the gate is fixed before the model is asked anything.
  const narrative = await generateNarrative(deps.model, {
    diff: request.diff,
    service: request.service,
    serviceSpaceName: serviceSpace.name,
    impacted,
  });

  return { ...base(), status: 'COMPLETE', service: request.service, impacted, signoffRequirements, narrative };
}

export async function runAnalysisJob(deps: BrainDeps, key: AnalysisKey): Promise<WorkerOutcome> {
  const record = await deps.store.getAnalysis(key);
  if (record === null) return { kind: 'SKIPPED', reason: 'NO_SUCH_ANALYSIS' };
  // Queue redelivery: the work is already done.
  if (record.state === 'COMPLETE') return { kind: 'SKIPPED', reason: 'ALREADY_COMPLETE' };

  await deps.store.putAnalysis({ ...record, state: 'RUNNING', updatedAt: isoNow(deps.now()) });

  let verdict: Verdict;
  try {
    verdict = await analyse(deps, record.request);
  } catch (cause) {
    console.error('analysis crashed', cause instanceof Error ? cause.message : String(cause));
    verdict = {
      v: CONTRACT_VERSION,
      key,
      analyzedAt: isoNow(deps.now()),
      status: 'FAILED',
      error: { code: 'INTERNAL', message: 'analysis failed unexpectedly', retryable: true },
    };
  }

  const complete = { state: 'COMPLETE' as const, v: CONTRACT_VERSION, key, verdict, pullRequest: record.request.pullRequest };
  await deps.store.putAnalysis({ ...complete, pushedToGate: false, updatedAt: isoNow(deps.now()) });

  // If the push is lost, Gate re-requests the analysis and receives this verdict inline.
  const pushed = await deps.gate.pushVerdict(verdict);
  if (!pushed.ok) {
    console.error(`verdict push failed (${pushed.error.kind}): ${pushed.error.message}`);
    return { kind: 'DONE', verdict, pushed: false };
  }
  await deps.store.putAnalysis({ ...complete, pushedToGate: true, updatedAt: isoNow(deps.now()) });
  return { kind: 'DONE', verdict, pushed: true };
}
