/**
 * Ripple wire contract v1 — the only types allowed to cross the Gate <-> Brain trust boundary.
 *
 * Gate  = Bitbucket workspace app (workspace scopes only).
 * Brain = Atlassian site app (Jira / Compass / Teamwork Graph scopes only).
 *
 * Everything here is JSON-serialisable. Nothing here may reference a Forge SDK type.
 */

export const CONTRACT_VERSION = 'v1' as const;
export type ContractVersion = typeof CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Bitbucket workspace UUID, lowercase, WITHOUT the surrounding `{}`. */
export type WorkspaceUuid = Brand<string, 'WorkspaceUuid'>;
/** Bitbucket repository UUID, lowercase, WITHOUT the surrounding `{}`. */
export type RepoUuid = Brand<string, 'RepoUuid'>;
/** Full 40-character lowercase hex git SHA. Never abbreviated, in memory or in storage keys. */
export type CommitSha = Brand<string, 'CommitSha'>;
/** Atlassian account id (the part after `ari:cloud:identity::user/`). */
export type AccountId = Brand<string, 'AccountId'>;
/** Jira space (project) key, e.g. `PLAT`. The unit of ownership and blast radius. */
export type SpaceKey = Brand<string, 'SpaceKey'>;
/** `ari:cloud:identity::team/{teamId}` */
export type TeamAri = Brand<string, 'TeamAri'>;
/** ISO-8601 UTC instant, e.g. `2026-11-26T10:43:00.000Z`. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;
/** Calendar date `YYYY-MM-DD` (Jira `duedate` format). */
export type IsoDate = Brand<string, 'IsoDate'>;
/** Jira issue key, e.g. `RISK-42`. */
export type JiraIssueKey = Brand<string, 'JiraIssueKey'>;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Identifies a pull request. UUID-based because the merge-check payload carries no slugs. */
export interface PrRef {
  readonly workspaceUuid: WorkspaceUuid;
  readonly repoUuid: RepoUuid;
  readonly prId: number;
}

/** Identifies one analysis. Every stored gate fact is bound to exactly one of these. */
export interface AnalysisKey extends PrRef {
  readonly headSha: CommitSha;
}

// ---------------------------------------------------------------------------
// Stage 1 output — deterministic diff classification (produced by Gate)
// ---------------------------------------------------------------------------

export type SurfaceKind =
  | 'SCHEMA_MIGRATION'
  | 'API_CONTRACT'
  | 'AUTH_TOKEN'
  | 'CONFIG_CONTRACT'
  | 'SHARED_LIBRARY';

export type DetectionMethod = 'PATH_PATTERN' | 'CONTENT_PATTERN' | 'SPEC_AWARE';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Maximum characters of diff text allowed in a single finding's `excerpt`. */
export const MAX_EXCERPT_CHARS = 600;
/** Maximum findings sent to Brain per analysis; extras set `DiffSummary.truncated`. */
export const MAX_FINDINGS = 50;

export interface SurfaceFinding {
  /** Stable detector rule id, e.g. `openapi.operation-removed`. */
  readonly ruleId: string;
  readonly kind: SurfaceKind;
  readonly method: DetectionMethod;
  readonly severity: Severity;
  readonly filePath: string;
  /** Deterministic, human-readable statement of what changed. Never LLM-written. */
  readonly statement: string;
  /** Bounded diff excerpt (<= MAX_EXCERPT_CHARS). The raw diff never leaves Gate. */
  readonly excerpt: string;
  /** `true`/`false` only when a spec-aware rule proved it; `null` = undetermined. */
  readonly breaking: boolean | null;
}

export interface DiffSummary {
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly findings: readonly SurfaceFinding[];
  /** True when findings or excerpts were cut to respect the bounds above. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Service declaration — ripple.yml at the repo root (read and validated by Gate)
// ---------------------------------------------------------------------------

export const RIPPLE_CONFIG_PATHS = ['ripple.yml', 'ripple.yaml'] as const;
export const MAX_DOWNSTREAM_SPACES = 25;

/**
 * service:
 *   id: auth-service
 *   jiraSpaceKey: PLAT
 * downstream: [MPLAT, MOB, SECOPS]
 */
export interface ServiceDeclaration {
  /** Human identifier of the service, from `service.id`. */
  readonly id: string;
  /** Jira space that owns the service, from `service.jiraSpaceKey`. */
  readonly spaceKey: SpaceKey;
  /** Jira spaces that consume this service; each must sign off on sensitive changes. */
  readonly downstream: readonly SpaceKey[];
  readonly configPath: string;
  /**
   * Which commit the declaration was read from. The destination branch is preferred so a
   * pull request cannot weaken its own gate; PR_HEAD is used only when the destination has none.
   */
  readonly configSource: 'DESTINATION_BRANCH' | 'PR_HEAD';
}

export interface RepoDescriptor {
  /** `{workspace-slug}/{repo-slug}` as returned by Bitbucket REST `full_name`. */
  readonly fullName: string;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Stage 2/3 output — the verdict (produced by Brain, cached by Gate)
// ---------------------------------------------------------------------------

export interface TeamRef {
  readonly teamAri: TeamAri;
  readonly displayName: string;
}

export interface RosterMember {
  readonly accountId: AccountId;
  readonly displayName: string;
}

export type RosterDegradedReason =
  /** Query succeeded but returned nothing — ambiguous with a missing graph scope. */
  | 'EMPTY_RESULT'
  /** Teamwork Graph call errored or could not be made. */
  | 'GRAPH_ERROR';

/**
 * Who may sign for a space. Resolved once, at analysis time, so Gate can authorise a
 * signoff click locally. DEGRADED never means "nobody may sign" and never means "pass".
 */
export type SignoffRoster =
  | { readonly status: 'VERIFIED'; readonly members: readonly [RosterMember, ...RosterMember[]] }
  | { readonly status: 'DEGRADED'; readonly reason: RosterDegradedReason };

/**
 * How ownership of a space was established, strongest first:
 *   SPACE_TEAM  teams linked to the space in the Teamwork Graph
 *   LEAD_TEAM   no linked team; the Jira project lead's team (inferred, weaker)
 *   LEAD_ONLY   no team could be resolved; the project lead alone
 *   UNRESOLVED  the space has no lead and no team
 */
export type OwnershipSource = 'SPACE_TEAM' | 'LEAD_TEAM' | 'LEAD_ONLY' | 'UNRESOLVED';

export interface SpaceOwnership {
  readonly source: OwnershipSource;
  readonly teams: readonly TeamRef[];
  readonly lead: RosterMember | null;
}

export interface ImpactedSpace {
  readonly spaceKey: SpaceKey;
  readonly name: string;
  readonly ownership: SpaceOwnership;
}

/** One per impacted downstream space. */
export interface SignoffRequirement {
  readonly spaceKey: SpaceKey;
  readonly spaceName: string;
  readonly ownership: SpaceOwnership;
  readonly roster: SignoffRoster;
}

export type Likelihood = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * LLM-written explanation, already validated entity-by-entity against retrieved facts.
 * Display-only: no gate decision may read this type.
 */
export type ImpactNarrative =
  | {
      readonly status: 'GROUNDED';
      readonly summary: string;
      readonly breakingLikelihood: Likelihood;
      readonly spaceImpacts: readonly { readonly spaceKey: SpaceKey; readonly explanation: string }[];
      /** Count of LLM claims discarded because they referenced unretrieved entities. */
      readonly droppedClaims: number;
    }
  | {
      readonly status: 'UNAVAILABLE';
      readonly reason: 'LLM_ERROR' | 'LLM_TIMEOUT' | 'VALIDATION_REJECTED' | 'MODERATION_BLOCKED';
    };

export type AnalysisErrorCode =
  | 'JIRA_UNAVAILABLE'
  | 'JIRA_FORBIDDEN'
  /** ripple.yml names a Jira space that does not exist (or the app cannot see). */
  | 'UNKNOWN_SPACE'
  | 'INTERNAL';

interface VerdictBase {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
  readonly analyzedAt: IsoTimestamp;
}

export interface CompleteVerdict extends VerdictBase {
  readonly status: 'COMPLETE';
  readonly service: ServiceDeclaration;
  readonly impacted: readonly ImpactedSpace[];
  /** Deterministically derived from `impacted`. Empty = advisory pass. */
  readonly signoffRequirements: readonly SignoffRequirement[];
  readonly narrative: ImpactNarrative;
}

export interface FailedVerdict extends VerdictBase {
  readonly status: 'FAILED';
  readonly error: {
    readonly code: AnalysisErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type Verdict = CompleteVerdict | FailedVerdict;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** All routes are POST so the signed canonical string never involves a query string. */
export const BRAIN_ROUTES = {
  analyze: '/v1/analyze',
  verdict: '/v1/verdict',
  signoff: '/v1/signoff',
  acceptRisk: '/v1/accept-risk',
} as const;

export const GATE_ROUTES = {
  verdict: '/v1/verdict',
  decision: '/v1/decision',
} as const;

export type BrainRoute = (typeof BRAIN_ROUTES)[keyof typeof BRAIN_ROUTES];
export type GateRoute = (typeof GATE_ROUTES)[keyof typeof GATE_ROUTES];

// ---------------------------------------------------------------------------
// Gate -> Brain: POST /v1/analyze   (idempotent on `key`)
// ---------------------------------------------------------------------------

export interface PullRequestDescriptor {
  readonly title: string;
  readonly url: string;
  readonly authorAccountId: AccountId | null;
  readonly sourceBranch: string;
  readonly destinationBranch: string;
}

export interface AnalyzeRequest {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
  readonly repo: RepoDescriptor;
  readonly pullRequest: PullRequestDescriptor;
  readonly diff: DiffSummary;
  /** The validated ripple.yml declaration for this repository. */
  readonly service: ServiceDeclaration;
}

export type AnalyzeResponse =
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly state: 'ACCEPTED' }
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly state: 'IN_PROGRESS' }
  | {
      readonly v: ContractVersion;
      readonly key: AnalysisKey;
      readonly state: 'COMPLETE';
      readonly verdict: Verdict;
    };

// ---------------------------------------------------------------------------
// Gate -> Brain: POST /v1/verdict   (pull fallback if a push was lost; Brain's own URL)
// ---------------------------------------------------------------------------

export interface VerdictQueryRequest {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
}

export type VerdictQueryResponse =
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly state: 'UNKNOWN' }
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly state: 'IN_PROGRESS' }
  | {
      readonly v: ContractVersion;
      readonly key: AnalysisKey;
      readonly state: 'COMPLETE';
      readonly verdict: Verdict;
    };

// ---------------------------------------------------------------------------
// Decisions — sign-off and accepted risk. Brain verifies, Gate applies.
// ---------------------------------------------------------------------------

export const MIN_JUSTIFICATION_CHARS = 20;
export const MAX_JUSTIFICATION_CHARS = 2000;

export interface RiskTicket {
  readonly issueKey: JiraIssueKey;
  readonly issueUrl: string;
}

export type SignoffAuthorization =
  /** The signer is on the VERIFIED roster Brain resolved for this space and commit. */
  | 'ROSTER_MEMBER'
  /** The roster was DEGRADED; accepted, and flagged in the audit trail. */
  | 'UNVERIFIED_ROSTER_DEGRADED';

export type DecisionRejection =
  /** Anti-rubber-stamping: the pull request author may never sign off on their own change. */
  | 'AUTHOR_CANNOT_SIGN'
  /** The author is not known, so author exclusion cannot be enforced. Fails closed. */
  | 'AUTHOR_UNKNOWN'
  | 'NOT_ON_ROSTER'
  | 'SPACE_NOT_REQUIRED'
  /** Only the pull request author or the lead of the changed service's space may accept risk. */
  | 'NOT_AUTHORIZED'
  | 'ANALYSIS_NOT_COMPLETE'
  | 'STALE_HEAD'
  | 'WRONG_STATE';

/** A verified decision, pushed from Brain to Gate. */
export type Decision =
  | {
      readonly type: 'SIGNOFF';
      readonly key: AnalysisKey;
      readonly spaceKey: SpaceKey;
      readonly signer: RosterMember;
      readonly authorization: SignoffAuthorization;
      readonly decidedAt: IsoTimestamp;
    }
  | {
      readonly type: 'RISK_ACCEPTED';
      readonly key: AnalysisKey;
      readonly acceptedBy: RosterMember;
      readonly acceptedAs: 'PR_AUTHOR' | 'SERVICE_LEAD';
      readonly justification: string;
      readonly dueDate: IsoDate;
      readonly ticket: RiskTicket;
      readonly decidedAt: IsoTimestamp;
    };

/** Gate -> Brain: POST /v1/signoff */
export interface SignoffRequest {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
  readonly spaceKey: SpaceKey;
  /** The acting user, as established by Gate from the Forge invocation context. */
  readonly actor: RosterMember;
}

export type GateDecisionState = 'SIGNOFF_REQUIRED' | 'CLEARED' | 'RISK_ACCEPTED';

export type SignoffResponse =
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'RECORDED'; readonly gateState: GateDecisionState }
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'REJECTED'; readonly reason: DecisionRejection };

/** Gate -> Brain: POST /v1/accept-risk   (idempotent on `key`: one Jira ticket per commit) */
export interface AcceptRiskRequest {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
  readonly actor: RosterMember;
  readonly justification: string;
  readonly dueDate: IsoDate;
}

export type AcceptRiskResponse =
  | {
      readonly v: ContractVersion;
      readonly key: AnalysisKey;
      readonly outcome: 'RECORDED';
      readonly ticket: RiskTicket;
      /** false = an earlier request for this commit already created the ticket. */
      readonly created: boolean;
      readonly gateState: GateDecisionState;
    }
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'REJECTED'; readonly reason: DecisionRejection };

/** Brain -> Gate: POST /v1/decision   (idempotent) */
export interface DecisionPushRequest {
  readonly v: ContractVersion;
  readonly decision: Decision;
}

export type DecisionPushResponse =
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'APPLIED'; readonly state: GateDecisionState }
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'STALE_SHA' }
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'WRONG_STATE' };

// ---------------------------------------------------------------------------
// Brain -> Gate: POST /v1/verdict   (upsert; idempotent on `verdict.key`)
// ---------------------------------------------------------------------------

export interface VerdictPushRequest {
  readonly v: ContractVersion;
  readonly verdict: Verdict;
}

export type VerdictPushResponse =
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'STORED' }
  /** Head moved on since the analysis started; Gate kept nothing. Not an error. */
  | { readonly v: ContractVersion; readonly key: AnalysisKey; readonly outcome: 'STALE_SHA' };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED_PAYLOAD'
  | 'UNKNOWN_ROUTE'
  | 'METHOD_NOT_ALLOWED'
  | 'ANALYSIS_NOT_FOUND'
  | 'JIRA_FAILED'
  | 'GATE_PUSH_FAILED'
  | 'INTERNAL';

export const API_ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  UNSUPPORTED_VERSION: 400,
  MALFORMED_PAYLOAD: 400,
  UNKNOWN_ROUTE: 404,
  METHOD_NOT_ALLOWED: 405,
  ANALYSIS_NOT_FOUND: 404,
  JIRA_FAILED: 502,
  GATE_PUSH_FAILED: 502,
  INTERNAL: 500,
} as const satisfies Record<ApiErrorCode, number>;

export interface ApiErrorResponse {
  readonly v: ContractVersion;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}

// ---------------------------------------------------------------------------
// Typed route maps — handlers and clients are both derived from these
// ---------------------------------------------------------------------------

export interface BrainApi {
  readonly [BRAIN_ROUTES.analyze]: { readonly request: AnalyzeRequest; readonly response: AnalyzeResponse };
  readonly [BRAIN_ROUTES.verdict]: { readonly request: VerdictQueryRequest; readonly response: VerdictQueryResponse };
  readonly [BRAIN_ROUTES.signoff]: { readonly request: SignoffRequest; readonly response: SignoffResponse };
  readonly [BRAIN_ROUTES.acceptRisk]: { readonly request: AcceptRiskRequest; readonly response: AcceptRiskResponse };
}

export interface GateApi {
  readonly [GATE_ROUTES.decision]: { readonly request: DecisionPushRequest; readonly response: DecisionPushResponse };
  readonly [GATE_ROUTES.verdict]: { readonly request: VerdictPushRequest; readonly response: VerdictPushResponse };
}

/** Shape Forge passes to a web trigger function (subset Ripple relies on). */
export interface WebTriggerRequestShape {
  readonly method: string;
  readonly userPath: string;
  /** Forge delivers arrays; plain strings are accepted so test clients need no adapter. */
  readonly headers?: Readonly<Record<string, readonly string[] | string | undefined>>;
  readonly body?: string;
}

/** Shape a dynamic web trigger function must return. */
export interface WebTriggerResponseShape {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: string;
}
