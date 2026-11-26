/**
 * Runtime decoders for wire contract v1. Every payload that crosses the Gate <-> Brain
 * boundary is decoded with one of these before any handler touches it.
 *
 * Each schema is annotated with the hand-written interface from types.ts, so the
 * compiler rejects any drift between the two.
 */
import { z } from 'zod';
import {
  parseAccountId,
  parseCommitSha,
  parseIsoDate,
  parseIsoTimestamp,
  parseJiraIssueKey,
  parseRepoUuid,
  parseSpaceKey,
  parseTeamAri,
  parseWorkspaceUuid,
} from './ids.ts';
import { err, ok, type Result } from './result.ts';
import type { Decision, DecisionPushRequest, DecisionPushResponse, SignoffRequest, SignoffResponse } from './types.ts';
import {
  CONTRACT_VERSION,
  MAX_DOWNSTREAM_SPACES,
  MAX_EXCERPT_CHARS,
  MAX_FINDINGS,
  MAX_JUSTIFICATION_CHARS,
  MIN_JUSTIFICATION_CHARS,
  type AcceptRiskRequest,
  type AcceptRiskResponse,
  type AnalysisKey,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type ApiErrorResponse,
  type DiffSummary,
  type ImpactNarrative,
  type PullRequestDescriptor,
  type ServiceDeclaration,
  type SpaceKey,
  type SpaceOwnership,
  type SignoffRoster,
  type TeamRef,
  type Verdict,
  type VerdictPushRequest,
  type VerdictPushResponse,
  type VerdictQueryRequest,
  type VerdictQueryResponse,
} from './types.ts';

function branded<T>(parse: (raw: string) => T | null, label: string) {
  return z.string().transform((raw, ctx): T => {
    const value = parse(raw);
    if (value === null) {
      ctx.addIssue({ code: 'custom', message: `invalid ${label}` });
      return z.NEVER;
    }
    return value;
  });
}

function nonEmpty<S extends z.ZodType>(item: S) {
  return z.tuple([item], item);
}

const text = (max: number) => z.string().max(max);
const version = z.literal(CONTRACT_VERSION);

const workspaceUuid = branded(parseWorkspaceUuid, 'workspace uuid');
const repoUuid = branded(parseRepoUuid, 'repository uuid');
const commitSha = branded(parseCommitSha, '40-character commit sha');
const accountId = branded(parseAccountId, 'account id');
const spaceKey = branded(parseSpaceKey, 'Jira space key');
export const spaceKeySchema: z.ZodType<SpaceKey> = spaceKey;
const teamAri = branded(parseTeamAri, 'team ARI');
const isoTimestamp = branded(parseIsoTimestamp, 'ISO timestamp');
const isoDate = branded(parseIsoDate, 'ISO date');
const jiraIssueKey = branded(parseJiraIssueKey, 'Jira issue key');

export const analysisKeySchema: z.ZodType<AnalysisKey> = z.object({
  workspaceUuid,
  repoUuid,
  prId: z.number().int().positive(),
  headSha: commitSha,
});

const surfaceFinding = z.object({
  ruleId: text(100),
  kind: z.enum(['SCHEMA_MIGRATION', 'API_CONTRACT', 'AUTH_TOKEN', 'CONFIG_CONTRACT', 'SHARED_LIBRARY']),
  method: z.enum(['PATH_PATTERN', 'CONTENT_PATTERN', 'SPEC_AWARE']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  filePath: text(1000),
  statement: text(1000),
  excerpt: text(MAX_EXCERPT_CHARS),
  breaking: z.boolean().nullable(),
});

const diffSummary: z.ZodType<DiffSummary> = z.object({
  filesChanged: z.number().int().nonnegative(),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  findings: z.array(surfaceFinding).max(MAX_FINDINGS),
  truncated: z.boolean(),
});

const serviceDeclaration: z.ZodType<ServiceDeclaration> = z.object({
  id: z.string().min(1).max(100),
  spaceKey,
  downstream: z.array(spaceKey).max(MAX_DOWNSTREAM_SPACES),
  configPath: text(200),
  configSource: z.enum(['DESTINATION_BRANCH', 'PR_HEAD']),
});

const pullRequestDescriptor: z.ZodType<PullRequestDescriptor> = z.object({
  title: text(1000),
  url: z.url(),
  authorAccountId: accountId.nullable(),
  sourceBranch: text(500),
  destinationBranch: text(500),
});

const teamRef: z.ZodType<TeamRef> = z.object({ teamAri, displayName: text(300) });
const rosterMember = z.object({ accountId, displayName: text(300) });

const signoffRoster: z.ZodType<SignoffRoster> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('VERIFIED'), members: nonEmpty(rosterMember) }),
  z.object({ status: z.literal('DEGRADED'), reason: z.enum(['EMPTY_RESULT', 'GRAPH_ERROR']) }),
]);

const spaceOwnership: z.ZodType<SpaceOwnership> = z.object({
  source: z.enum(['SPACE_TEAM', 'LEAD_TEAM', 'LEAD_ONLY', 'UNRESOLVED']),
  teams: z.array(teamRef).max(10),
  lead: rosterMember.nullable(),
});

const impactNarrative: z.ZodType<ImpactNarrative> = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('GROUNDED'),
    summary: text(4000),
    breakingLikelihood: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    spaceImpacts: z.array(z.object({ spaceKey, explanation: text(2000) })).max(MAX_DOWNSTREAM_SPACES),
    droppedClaims: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('UNAVAILABLE'),
    reason: z.enum(['LLM_ERROR', 'LLM_TIMEOUT', 'VALIDATION_REJECTED', 'MODERATION_BLOCKED']),
  }),
]);

const verdictBase = { v: version, key: analysisKeySchema, analyzedAt: isoTimestamp };

export const verdictSchema: z.ZodType<Verdict> = z.discriminatedUnion('status', [
  z.object({
    ...verdictBase,
    status: z.literal('COMPLETE'),
    service: serviceDeclaration,
    impacted: z.array(z.object({ spaceKey, name: text(300), ownership: spaceOwnership })).max(MAX_DOWNSTREAM_SPACES),
    signoffRequirements: z
      .array(z.object({ spaceKey, spaceName: text(300), ownership: spaceOwnership, roster: signoffRoster }))
      .max(MAX_DOWNSTREAM_SPACES),
    narrative: impactNarrative,
  }),
  z.object({
    ...verdictBase,
    status: z.literal('FAILED'),
    error: z.object({
      code: z.enum(['JIRA_UNAVAILABLE', 'JIRA_FORBIDDEN', 'UNKNOWN_SPACE', 'INTERNAL']),
      message: text(1000),
      retryable: z.boolean(),
    }),
  }),
]);

export const analyzeRequestSchema: z.ZodType<AnalyzeRequest> = z.object({
  v: version,
  key: analysisKeySchema,
  repo: z.object({ fullName: text(500), url: z.url() }),
  pullRequest: pullRequestDescriptor,
  diff: diffSummary,
  service: serviceDeclaration,
});

const keyed = { v: version, key: analysisKeySchema };

export const analyzeResponseSchema: z.ZodType<AnalyzeResponse> = z.discriminatedUnion('state', [
  z.object({ ...keyed, state: z.literal('ACCEPTED') }),
  z.object({ ...keyed, state: z.literal('IN_PROGRESS') }),
  z.object({ ...keyed, state: z.literal('COMPLETE'), verdict: verdictSchema }),
]);

export const verdictQueryRequestSchema: z.ZodType<VerdictQueryRequest> = z.object(keyed);

export const verdictQueryResponseSchema: z.ZodType<VerdictQueryResponse> = z.discriminatedUnion('state', [
  z.object({ ...keyed, state: z.literal('UNKNOWN') }),
  z.object({ ...keyed, state: z.literal('IN_PROGRESS') }),
  z.object({ ...keyed, state: z.literal('COMPLETE'), verdict: verdictSchema }),
]);

const rejection = z.enum([
  'AUTHOR_CANNOT_SIGN',
  'AUTHOR_UNKNOWN',
  'NOT_ON_ROSTER',
  'SPACE_NOT_REQUIRED',
  'NOT_AUTHORIZED',
  'ANALYSIS_NOT_COMPLETE',
  'STALE_HEAD',
  'WRONG_STATE',
]);
const gateState = z.enum(['SIGNOFF_REQUIRED', 'CLEARED', 'RISK_ACCEPTED']);
const riskTicket = z.object({ issueKey: jiraIssueKey, issueUrl: z.url() });
const justification = z.string().trim().min(MIN_JUSTIFICATION_CHARS).max(MAX_JUSTIFICATION_CHARS);
const rejected = z.object({ ...keyed, outcome: z.literal('REJECTED'), reason: rejection });

export const signoffRequestSchema: z.ZodType<SignoffRequest> = z.object({ ...keyed, spaceKey, actor: rosterMember });

export const signoffResponseSchema: z.ZodType<SignoffResponse> = z.discriminatedUnion('outcome', [
  z.object({ ...keyed, outcome: z.literal('RECORDED'), gateState }),
  rejected,
]);

export const acceptRiskRequestSchema: z.ZodType<AcceptRiskRequest> = z.object({
  ...keyed,
  actor: rosterMember,
  justification,
  dueDate: isoDate,
});

export const acceptRiskResponseSchema: z.ZodType<AcceptRiskResponse> = z.discriminatedUnion('outcome', [
  z.object({ ...keyed, outcome: z.literal('RECORDED'), ticket: riskTicket, created: z.boolean(), gateState }),
  rejected,
]);

export const decisionSchema: z.ZodType<Decision> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SIGNOFF'),
    key: analysisKeySchema,
    spaceKey,
    signer: rosterMember,
    authorization: z.enum(['ROSTER_MEMBER', 'UNVERIFIED_ROSTER_DEGRADED']),
    decidedAt: isoTimestamp,
  }),
  z.object({
    type: z.literal('RISK_ACCEPTED'),
    key: analysisKeySchema,
    acceptedBy: rosterMember,
    acceptedAs: z.enum(['PR_AUTHOR', 'SERVICE_LEAD']),
    justification,
    dueDate: isoDate,
    ticket: riskTicket,
    decidedAt: isoTimestamp,
  }),
]);

export const decisionPushRequestSchema: z.ZodType<DecisionPushRequest> = z.object({ v: version, decision: decisionSchema });

export const decisionPushResponseSchema: z.ZodType<DecisionPushResponse> = z.discriminatedUnion('outcome', [
  z.object({ ...keyed, outcome: z.literal('APPLIED'), state: gateState }),
  z.object({ ...keyed, outcome: z.literal('STALE_SHA') }),
  z.object({ ...keyed, outcome: z.literal('WRONG_STATE') }),
]);

export const verdictPushRequestSchema: z.ZodType<VerdictPushRequest> = z.object({
  v: version,
  verdict: verdictSchema,
});

export const verdictPushResponseSchema: z.ZodType<VerdictPushResponse> = z.discriminatedUnion('outcome', [
  z.object({ ...keyed, outcome: z.literal('STORED') }),
  z.object({ ...keyed, outcome: z.literal('STALE_SHA') }),
]);

export const apiErrorResponseSchema: z.ZodType<ApiErrorResponse> = z.object({
  v: version,
  error: z.object({
    code: z.enum([
      'UNAUTHENTICATED',
      'UNSUPPORTED_VERSION',
      'MALFORMED_PAYLOAD',
      'UNKNOWN_ROUTE',
      'METHOD_NOT_ALLOWED',
      'ANALYSIS_NOT_FOUND',
      'JIRA_FAILED',
      'GATE_PUSH_FAILED',
      'INTERNAL',
    ]),
    message: text(2000),
  }),
});

export interface DecodeError {
  readonly kind: 'INVALID_JSON' | 'SCHEMA_MISMATCH';
  readonly message: string;
}

/** Validates an already-parsed value. */
export function decodeValue<T>(schema: z.ZodType<T>, value: unknown): Result<T, DecodeError> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? '' : `${issue.path.join('.')}: ${issue.message}`;
  return err({ kind: 'SCHEMA_MISMATCH', message: where });
}

/** Parses and validates a raw JSON body. */
export function decodeJson<T>(schema: z.ZodType<T>, raw: string): Result<T, DecodeError> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return err({ kind: 'INVALID_JSON', message: 'body is not valid JSON' });
  }
  return decodeValue(schema, value);
}
