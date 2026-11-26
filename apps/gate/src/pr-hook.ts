/** Bitbucket PR created / updated hook: classify the head commit and dispatch analysis if needed. */
import { err, ok, parseRepoUuid, parseWorkspaceUuid, type PrRef, type Result } from '@ripple/contracts';
import { evaluateHead, type IntakeOutcome } from './intake.ts';
import type { GateDeps } from './ports.ts';
import type { MergeCheckEvent, PullRequestEvent } from './types.ts';

export type EventRejection = 'MALFORMED_EVENT';

/** Both invocation payloads identify the PR the same way: wrapped UUIDs plus a numeric id. */
export function prRefFromEvent(event: Pick<MergeCheckEvent, 'workspace' | 'repository' | 'pullrequest'>): Result<PrRef, EventRejection> {
  const workspaceUuid = parseWorkspaceUuid(event.workspace?.uuid ?? '');
  const repoUuid = parseRepoUuid(event.repository?.uuid ?? '');
  const prId = event.pullrequest?.id;
  if (workspaceUuid === null || repoUuid === null || !Number.isInteger(prId) || prId <= 0) {
    return err('MALFORMED_EVENT');
  }
  return ok({ workspaceUuid, repoUuid, prId });
}

/**
 * The event's own commit hash is deliberately ignored: delivery can lag by minutes, so the
 * head is always re-read from Bitbucket and resolved to a full SHA.
 */
export async function handlePullRequestEvent(
  deps: GateDeps,
  event: PullRequestEvent,
): Promise<Result<IntakeOutcome, EventRejection>> {
  const pr = prRefFromEvent(event);
  if (!pr.ok) return pr;
  return ok(await evaluateHead(deps, pr.value));
}
