/**
 * Sign-off and accept-risk. Brain is the authority on eligibility because it holds the
 * verdict (rosters) and the pull request author; Gate applies whatever Brain pushes.
 *
 * Rules, all deterministic:
 *   - The pull request author can never sign off, on any space, whatever roster they are on.
 *     If the author is unknown the rule cannot be enforced, so sign-off is refused.
 *   - A sign-off must come from the VERIFIED roster of a space that requires one. A DEGRADED
 *     roster accepts any non-author signer and is flagged as unverified.
 *   - Risk may be accepted only by the pull request author or the lead of the changed
 *     service's Jira space, with a justification, and always leaves a Jira ticket behind.
 */
import {
  CONTRACT_VERSION,
  acceptRiskRequestSchema,
  apiError,
  decodeJson,
  isoNow,
  jsonResponse,
  signoffRequestSchema,
  type AcceptRiskRequest,
  type AcceptRiskResponse,
  type AnalysisKey,
  type CompleteVerdict,
  type Decision,
  type DecisionRejection,
  type GateDecisionState,
  type PullRequestDescriptor,
  type Result,
  type RiskTicket,
  type RosterMember,
  type SignoffRequest,
  type SignoffResponse,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import type { BrainDeps, TicketError } from './ports.ts';
import { riskTicketLabel, type AdfBlock, type AdfInline, type JiraCreateIssueRequest } from './types.ts';

interface Subject {
  readonly verdict: CompleteVerdict;
  readonly pullRequest: PullRequestDescriptor;
}

async function subject(deps: BrainDeps, key: AnalysisKey): Promise<Subject | null> {
  const record = await deps.store.getAnalysis(key);
  if (record === null || record.state !== 'COMPLETE' || record.verdict.status !== 'COMPLETE') return null;
  return { verdict: record.verdict, pullRequest: record.pullRequest };
}

type Eligibility<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: DecisionRejection };

/** Pure: may `actor` sign off for `spaceKey`? */
export function signoffEligibility(
  { verdict, pullRequest }: Subject,
  spaceKey: SignoffRequest['spaceKey'],
  actor: RosterMember,
): Eligibility<Pick<Extract<Decision, { type: 'SIGNOFF' }>, 'signer' | 'authorization'>> {
  if (pullRequest.authorAccountId === null) return { ok: false, reason: 'AUTHOR_UNKNOWN' };
  if (actor.accountId === pullRequest.authorAccountId) return { ok: false, reason: 'AUTHOR_CANNOT_SIGN' };
  const requirement = verdict.signoffRequirements.find((entry) => entry.spaceKey === spaceKey);
  if (requirement === undefined) return { ok: false, reason: 'SPACE_NOT_REQUIRED' };
  if (requirement.roster.status === 'DEGRADED') return { ok: true, value: { signer: actor, authorization: 'UNVERIFIED_ROSTER_DEGRADED' } };
  // Record the name Brain resolved, not whatever the caller supplied.
  const member = requirement.roster.members.find((entry) => entry.accountId === actor.accountId);
  return member === undefined ? { ok: false, reason: 'NOT_ON_ROSTER' } : { ok: true, value: { signer: member, authorization: 'ROSTER_MEMBER' } };
}

type Pushed = { readonly ok: true; readonly gateState: GateDecisionState } | { readonly ok: false; readonly reason: DecisionRejection } | { readonly ok: false; readonly transport: string };

async function push(deps: BrainDeps, decision: Decision): Promise<Pushed> {
  const response = await deps.gate.pushDecision(decision);
  if (!response.ok) return { ok: false, transport: `${response.error.kind}: ${response.error.message}` };
  switch (response.value.outcome) {
    case 'APPLIED':
      return { ok: true, gateState: response.value.state };
    case 'STALE_SHA':
      return { ok: false, reason: 'STALE_HEAD' };
    case 'WRONG_STATE':
      return { ok: false, reason: 'WRONG_STATE' };
  }
}

export async function handleSignoff(deps: BrainDeps, body: string): Promise<WebTriggerResponseShape> {
  const decoded = decodeJson(signoffRequestSchema, body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const { key, spaceKey, actor } = decoded.value;
  const keyed = { v: CONTRACT_VERSION, key };
  const reject = (reason: DecisionRejection) => jsonResponse(200, { ...keyed, outcome: 'REJECTED', reason } satisfies SignoffResponse);

  const target = await subject(deps, key);
  if (target === null) return reject('ANALYSIS_NOT_COMPLETE');
  const eligible = signoffEligibility(target, spaceKey, actor);
  if (!eligible.ok) return reject(eligible.reason);

  const pushed = await push(deps, { type: 'SIGNOFF', key, spaceKey, ...eligible.value, decidedAt: isoNow(deps.now()) });
  if (pushed.ok) return jsonResponse(200, { ...keyed, outcome: 'RECORDED', gateState: pushed.gateState } satisfies SignoffResponse);
  return 'reason' in pushed ? reject(pushed.reason) : apiError('GATE_PUSH_FAILED', pushed.transport);
}

// --- accept risk ---------------------------------------------------------------

const text = (value: string, strong = false): AdfInline => (strong ? { type: 'text', text: value, marks: [{ type: 'strong' }] } : { type: 'text', text: value });
const paragraph = (...content: AdfInline[]): Extract<AdfBlock, { type: 'paragraph' }> => ({ type: 'paragraph', content });
const heading = (value: string): AdfBlock => ({ type: 'heading', attrs: { level: 3 }, content: [text(value)] });

/** Pure: the Jira issue that records an accepted risk. */
export function buildRiskIssue(
  { verdict, pullRequest }: Subject,
  request: AcceptRiskRequest,
  acceptedAs: 'PR_AUTHOR' | 'SERVICE_LEAD',
  target: { readonly projectKey: string; readonly issueType: string },
): JiraCreateIssueRequest {
  const role = acceptedAs === 'PR_AUTHOR' ? 'pull request author' : `lead of ${verdict.service.spaceKey}`;
  return {
    fields: {
      project: { key: target.projectKey },
      issuetype: { name: target.issueType },
      summary: `Accepted risk: ${verdict.service.id} PR #${request.key.prId} merged without downstream sign-off`.slice(0, 250),
      duedate: request.dueDate,
      labels: ['ripple-accepted-risk', riskTicketLabel(request.key)],
      description: {
        type: 'doc',
        version: 1,
        content: [
          paragraph(text('Ripple blast-radius gate: risk accepted by '), text(request.actor.displayName, true), text(` (${role}).`)),
          heading('Justification'),
          paragraph(text(request.justification)),
          heading('Pull request'),
          paragraph({ type: 'text', text: pullRequest.title, marks: [{ type: 'link', attrs: { href: pullRequest.url } }] }, text(` — commit ${request.key.headSha}`)),
          heading('Downstream spaces that had not signed off'),
          {
            type: 'bulletList',
            content: verdict.signoffRequirements.map((requirement) => ({
              type: 'listItem' as const,
              content: [
                paragraph(
                  text(`${requirement.spaceKey} — ${requirement.spaceName}`, true),
                  text(`: ${requirement.ownership.teams.map((team) => team.displayName).join(', ') || requirement.ownership.lead?.displayName || 'no owner resolved'}`),
                ),
              ],
            })),
          },
        ],
      },
    },
  };
}

async function ticketFor(deps: BrainDeps, target: Subject, request: AcceptRiskRequest, acceptedAs: 'PR_AUTHOR' | 'SERVICE_LEAD'): Promise<Result<{ ticket: RiskTicket; created: boolean }, TicketError>> {
  // One ticket per commit: first the local record, then Jira itself in case that write was lost.
  const known = await deps.store.getException(request.key);
  if (known !== null) return { ok: true, value: { ticket: known.ticket, created: false } };
  const project = deps.tickets.target();
  if (!project.ok) return project;
  const existing = await deps.tickets.findByLabel(riskTicketLabel(request.key));
  if (!existing.ok) return existing;
  let ticket = existing.value;
  const created = ticket === null;
  if (ticket === null) {
    const made = await deps.tickets.create(buildRiskIssue(target, request, acceptedAs, project.value));
    if (!made.ok) return made;
    ticket = made.value;
  }
  await deps.store.putException({ v: CONTRACT_VERSION, key: request.key, acceptedBy: request.actor, ticket, createdAt: isoNow(deps.now()) });
  return { ok: true, value: { ticket, created } };
}

export async function handleAcceptRisk(deps: BrainDeps, body: string): Promise<WebTriggerResponseShape> {
  const decoded = decodeJson(acceptRiskRequestSchema, body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const request = decoded.value;
  const keyed = { v: CONTRACT_VERSION, key: request.key };
  const reject = (reason: DecisionRejection) => jsonResponse(200, { ...keyed, outcome: 'REJECTED', reason } satisfies AcceptRiskResponse);

  const target = await subject(deps, request.key);
  if (target === null) return reject('ANALYSIS_NOT_COMPLETE');
  if (target.verdict.signoffRequirements.length === 0) return reject('WRONG_STATE');

  let acceptedAs: 'PR_AUTHOR' | 'SERVICE_LEAD';
  if (request.actor.accountId === target.pullRequest.authorAccountId) {
    acceptedAs = 'PR_AUTHOR';
  } else {
    const serviceSpace = await deps.spaces.getSpace(target.verdict.service.spaceKey);
    if (!serviceSpace.ok) return apiError('JIRA_FAILED', serviceSpace.error.message);
    if (serviceSpace.value?.lead?.accountId !== request.actor.accountId) return reject('NOT_AUTHORIZED');
    acceptedAs = 'SERVICE_LEAD';
  }

  const ticket = await ticketFor(deps, target, request, acceptedAs);
  if (!ticket.ok) return apiError('JIRA_FAILED', `${ticket.error.kind}: ${ticket.error.message}`);

  const pushed = await push(deps, {
    type: 'RISK_ACCEPTED',
    key: request.key,
    acceptedBy: request.actor,
    acceptedAs,
    justification: request.justification,
    dueDate: request.dueDate,
    ticket: ticket.value.ticket,
    decidedAt: isoNow(deps.now()),
  });
  if (pushed.ok) return jsonResponse(200, { ...keyed, outcome: 'RECORDED', ...ticket.value, gateState: pushed.gateState } satisfies AcceptRiskResponse);
  return 'reason' in pushed ? reject(pushed.reason) : apiError('GATE_PUSH_FAILED', pushed.transport);
}
