/**
 * PR overview panel resolver logic. Serves `PanelResolverApi` (types.ts) to the Custom UI
 * in `frontend/`; `forge/panel-resolver.ts` is the thin `@forge/resolver` adapter.
 *
 * Reading the panel runs the same idempotent evaluation as the PR hook and merge check, so
 * opening a PR whose trigger was lost still classifies it, and the dispatch claim keeps that
 * from double-sending to Brain.
 *
 * Trust: the PR and the viewer come only from the Forge invocation context. The browser
 * supplies nothing but the head SHA it rendered and the form fields, all re-validated here.
 * Brain remains the authority on who may sign or accept risk; this file only shapes requests
 * and reflects Brain's answer.
 */
import {
  MAX_JUSTIFICATION_CHARS,
  MIN_JUSTIFICATION_CHARS,
  err,
  ok,
  parseAccountId,
  parseCommitSha,
  parseIsoDate,
  parseRepoUuid,
  parseSpaceKey,
  parseWorkspaceUuid,
  type AccountId,
  type CallError,
  type PrRef,
  type Result,
  type RosterMember,
  type SpaceKey,
} from '@ripple/contracts';
import { z } from 'zod';
import { requestAcceptRisk, requestSignoff, type ActionError } from './actions.ts';
import { appendAudit, evaluateHead } from './intake.ts';
import { decide } from './merge-check.ts';
import type { GateDeps } from './ports.ts';
import {
  MAX_ANALYSIS_ATTEMPTS,
  type GateRecord,
  type PanelActionRejection,
  type PanelActionResult,
  type PanelView,
  type PullRequestSnapshot,
  type ViewerContext,
} from './types.ts';

export interface PanelContext {
  readonly pr: PrRef;
  readonly viewer: AccountId;
}

const contextSchema = z.object({
  accountId: z.string(),
  workspaceId: z.string().optional(),
  installContext: z.string().optional(),
  extension: z.object({
    repository: z.object({ uuid: z.string() }),
    pullRequest: z.object({ id: z.number().int().positive() }),
  }),
});

/** `ari:cloud:bitbucket::workspace/<uuid>` -> `<uuid>`. */
function workspaceFromInstallContext(installContext: string | undefined): string {
  return installContext?.match(/workspace\/(\{?[0-9a-f-]{36}\}?)$/i)?.[1] ?? '';
}

/** Parses the resolver invocation context. Anything unexpected fails closed. */
export function panelContextFrom(raw: unknown): Result<PanelContext, 'MALFORMED_CONTEXT'> {
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) return err('MALFORMED_CONTEXT');
  const context = parsed.data;
  const workspaceUuid =
    parseWorkspaceUuid(context.workspaceId ?? '') ?? parseWorkspaceUuid(workspaceFromInstallContext(context.installContext));
  const repoUuid = parseRepoUuid(context.extension.repository.uuid);
  const viewer = parseAccountId(context.accountId);
  if (workspaceUuid === null || repoUuid === null || viewer === null) return err('MALFORMED_CONTEXT');
  return ok({ pr: { workspaceUuid, repoUuid, prId: context.extension.pullRequest.id }, viewer });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function rosterMembers(record: GateRecord): readonly { spaceKey: SpaceKey; member: RosterMember }[] {
  if (record.state !== 'SIGNOFF_REQUIRED' && record.state !== 'CLEARED' && record.state !== 'RISK_ACCEPTED') return [];
  return record.verdict.signoffRequirements.flatMap((requirement) =>
    requirement.roster.status === 'VERIFIED' ? requirement.roster.members.map((member) => ({ spaceKey: requirement.spaceKey, member })) : [],
  );
}

/** Best display name Gate knows without a user-lookup scope; the account id is the identity of record. */
function displayNameOf(viewer: AccountId, snapshot: PullRequestSnapshot, record: GateRecord): string {
  if (snapshot.descriptor.authorAccountId === viewer && snapshot.authorDisplayName !== null) return snapshot.authorDisplayName;
  const onRoster = rosterMembers(record).find((entry) => entry.member.accountId === viewer);
  if (onRoster !== undefined) return onRoster.member.displayName;
  if ('verdict' in record) {
    const lead = record.verdict.impacted.map((space) => space.ownership.lead).find((member) => member?.accountId === viewer);
    if (lead !== undefined && lead !== null) return lead.displayName;
  }
  return 'Bitbucket user';
}

export function viewerContext(viewer: AccountId, snapshot: PullRequestSnapshot, record: GateRecord): ViewerContext {
  return {
    accountId: viewer,
    displayName: displayNameOf(viewer, snapshot, record),
    isPrAuthor: snapshot.descriptor.authorAccountId === viewer,
    rosterSpaceKeys: [...new Set(rosterMembers(record).filter((entry) => entry.member.accountId === viewer).map((entry) => entry.spaceKey))],
  };
}

interface Loaded {
  readonly view: PanelView;
  readonly ready: { readonly snapshot: PullRequestSnapshot; readonly record: GateRecord; readonly viewer: ViewerContext } | null;
}

async function load(deps: GateDeps, context: PanelContext): Promise<Loaded> {
  const intake = await evaluateHead(deps, context.pr);
  if (intake.kind === 'BITBUCKET_UNAVAILABLE') {
    return { view: { status: 'UNAVAILABLE', message: `Ripple could not read this pull request from Bitbucket: ${intake.error.message}` }, ready: null };
  }
  if (intake.kind === 'NOT_OPEN') return { view: { status: 'NOT_OPEN', prState: intake.snapshot.state }, ready: null };

  const { snapshot, record } = intake;
  const viewer = viewerContext(context.viewer, snapshot, record);
  const outcome = decide(record);
  const view: PanelView = {
    status: 'READY',
    headSha: snapshot.headSha,
    pullRequest: {
      title: snapshot.descriptor.title,
      url: snapshot.descriptor.url,
      authorDisplayName: snapshot.authorDisplayName,
      sourceBranch: snapshot.descriptor.sourceBranch,
      destinationBranch: snapshot.descriptor.destinationBranch,
    },
    record,
    check: { status: outcome.status, message: outcome.message },
    outstandingSpaceKeys: record.state === 'SIGNOFF_REQUIRED' ? outstandingSpaceKeys(record) : [],
    willRetry: record.state === 'ANALYSIS_FAILED' && record.failure.retryable && record.attempts < MAX_ANALYSIS_ATTEMPTS,
    viewer,
  };
  return { view, ready: { snapshot, record, viewer } };
}

function outstandingSpaceKeys(record: Extract<GateRecord, { state: 'SIGNOFF_REQUIRED' }>): SpaceKey[] {
  const signed = new Set(record.signoffs.map((signoff) => signoff.spaceKey));
  return record.verdict.signoffRequirements.map((requirement) => requirement.spaceKey).filter((key) => !signed.has(key));
}

export async function getPanelView(deps: GateDeps, context: PanelContext): Promise<PanelView> {
  return (await load(deps, context)).view;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const signoffPayload = z.object({ headSha: z.string(), spaceKey: z.string() });
const acceptRiskPayload = z.object({
  headSha: z.string(),
  justification: z.string().trim().min(MIN_JUSTIFICATION_CHARS).max(MAX_JUSTIFICATION_CHARS),
  dueDate: z.string(),
});

const REJECTION_MESSAGES: Record<PanelActionRejection, string> = {
  AUTHOR_CANNOT_SIGN: 'The pull request author cannot sign off on their own change. You can accept the risk instead.',
  AUTHOR_UNKNOWN: 'The pull request author is unknown, so sign-off cannot be checked against them.',
  NOT_ON_ROSTER: 'You are not on the owning team for this space.',
  SPACE_NOT_REQUIRED: 'This space does not need a sign-off for this commit.',
  NOT_AUTHORIZED: "Only the pull request author or the lead of the service's Jira space can accept the risk.",
  ANALYSIS_NOT_COMPLETE: 'Analysis for this commit has not finished yet.',
  STALE_HEAD: 'A newer commit was pushed. The panel has been refreshed; review it and try again.',
  WRONG_STATE: 'This pull request is no longer waiting on that action.',
  INVALID_REQUEST: 'The request was incomplete or invalid.',
  UNAVAILABLE: 'Ripple could not complete the request right now. Try again shortly.',
};

function callErrorMessage(error: CallError): string {
  return error.kind === 'REJECTED' ? `Brain refused the request (HTTP ${error.status}): ${error.message}` : `Brain unreachable: ${error.message}`;
}

type Prepared =
  | { readonly kind: 'GO'; readonly loaded: Loaded & { readonly ready: NonNullable<Loaded['ready']> } }
  | { readonly kind: 'STOP'; readonly result: PanelActionResult };

/** Loads the current head, then refuses if the browser rendered a different one. */
async function prepare(deps: GateDeps, context: PanelContext, renderedSha: string): Promise<Prepared> {
  const loaded = await load(deps, context);
  const stop = (reason: PanelActionRejection, message = REJECTION_MESSAGES[reason]): Prepared => ({
    kind: 'STOP',
    result: { ok: false, reason, message, view: loaded.view },
  });
  if (loaded.ready === null) return stop('UNAVAILABLE', loaded.view.status === 'UNAVAILABLE' ? loaded.view.message : 'The pull request is not open.');
  const sha = parseCommitSha(renderedSha);
  if (sha === null) return stop('INVALID_REQUEST');
  if (sha !== loaded.ready.snapshot.headSha) return stop('STALE_HEAD');
  return { kind: 'GO', loaded: { ...loaded, ready: loaded.ready } };
}

async function finish(
  deps: GateDeps,
  context: PanelContext,
  outcome: Result<{ outcome: 'RECORDED' } | { outcome: 'REJECTED'; reason: PanelActionRejection }, ActionError>,
): Promise<PanelActionResult> {
  // Brain pushes the decision to Gate before replying, so a fresh load already reflects it.
  const { view } = await load(deps, context);
  if (outcome.ok) {
    if (outcome.value.outcome === 'RECORDED') return { ok: true, view };
    return { ok: false, reason: outcome.value.reason, message: REJECTION_MESSAGES[outcome.value.reason], view };
  }
  const failure = outcome.error;
  if (failure.kind === 'REJECTED') {
    const reason: PanelActionRejection = failure.reason === 'INVALID_DUE_DATE' ? 'INVALID_REQUEST' : failure.reason;
    return { ok: false, reason, message: failure.reason === 'INVALID_DUE_DATE' ? 'The due date is not a valid date.' : REJECTION_MESSAGES[reason], view };
  }
  return { ok: false, reason: 'UNAVAILABLE', message: callErrorMessage(failure.error), view };
}

export async function submitSignoff(deps: GateDeps, context: PanelContext, payload: unknown): Promise<PanelActionResult> {
  const parsed = signoffPayload.safeParse(payload);
  const prepared = await prepare(deps, context, parsed.success ? parsed.data.headSha : '');
  if (prepared.kind === 'STOP') return prepared.result;
  const { snapshot, viewer } = prepared.loaded.ready;
  const spaceKey = parsed.success ? parseSpaceKey(parsed.data.spaceKey) : null;
  if (spaceKey === null) return { ok: false, reason: 'INVALID_REQUEST', message: REJECTION_MESSAGES.INVALID_REQUEST, view: prepared.loaded.view };

  const key = { ...context.pr, headSha: snapshot.headSha };
  const outcome = await requestSignoff(deps, key, spaceKey, { accountId: viewer.accountId, displayName: viewer.displayName });
  if (outcome.ok && outcome.value.outcome === 'REJECTED') {
    await appendAudit(deps, key, { type: 'SIGNOFF_REJECTED', spaceKey, actor: viewer.accountId, reason: outcome.value.reason });
  }
  return finish(deps, context, outcome);
}

export async function acceptRisk(deps: GateDeps, context: PanelContext, payload: unknown): Promise<PanelActionResult> {
  const parsed = acceptRiskPayload.safeParse(payload);
  const prepared = await prepare(deps, context, parsed.success ? parsed.data.headSha : '');
  if (prepared.kind === 'STOP') return prepared.result;
  if (!parsed.success || parseIsoDate(parsed.data.dueDate) === null) {
    const message = parsed.success
      ? 'The due date is not a valid date.'
      : `Give a justification of ${MIN_JUSTIFICATION_CHARS}–${MAX_JUSTIFICATION_CHARS} characters and a due date.`;
    return { ok: false, reason: 'INVALID_REQUEST', message, view: prepared.loaded.view };
  }
  const { snapshot, viewer } = prepared.loaded.ready;
  const key = { ...context.pr, headSha: snapshot.headSha };
  const outcome = await requestAcceptRisk(
    deps,
    key,
    { accountId: viewer.accountId, displayName: viewer.displayName },
    parsed.data.justification,
    parsed.data.dueDate,
  );
  return finish(deps, context, outcome);
}

