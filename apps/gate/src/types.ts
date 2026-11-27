/**
 * Ripple Gate — internal contracts.
 *
 * Covers: Forge/Bitbucket invocation payloads, the gate state machine, Forge KVS
 * schemas, the append-only audit log, and the panel <-> resolver contract.
 * Wire types shared with Brain live in @ripple/contracts.
 */
import type {
  AccountId,
  AnalysisErrorCode,
  AnalysisKey,
  CommitSha,
  CompleteVerdict,
  DecisionRejection,
  ContractVersion,
  DiffSummary,
  IsoDate,
  IsoTimestamp,
  PrRef,
  PullRequestDescriptor,
  RepoDescriptor,
  RiskTicket,
  RosterMember,
  SignoffAuthorization,
  SpaceKey,
} from '@ripple/contracts';
import { analysisKeyString, prKeyString } from '@ripple/contracts';

/** Analysis attempts per head SHA before Gate stops re-dispatching and stays failed. */
export const MAX_ANALYSIS_ATTEMPTS = 3;
/** A pending analysis older than this is assumed lost and re-dispatched on the next evaluation. */
export const PENDING_STALE_MS = 3 * 60 * 1000;
/** Lifetime of a dispatch claim; matches PENDING_STALE_MS so a lost claimant is retried on the same schedule. */
export const DISPATCH_CLAIM_TTL_SECONDS = PENDING_STALE_MS / 1000;

export interface DispatchClaim {
  readonly attempt: number;
  readonly claimedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Environment (set with `forge variables set`, never committed)
// ---------------------------------------------------------------------------

export const GATE_ENV = {
  /** Brain's web trigger URL, from `forge webtrigger create` in apps/brain. */
  brainApiUrl: 'RIPPLE_BRAIN_API_URL',
  /** Current shared secret as `{keyId}:{secret}`. Set with `--encrypt`. */
  signingKey: 'RIPPLE_SIGNING_KEY',
  /** Optional previous secret, same format, accepted during rotation. */
  previousSigningKey: 'RIPPLE_SIGNING_KEY_PREVIOUS',
} as const;

// ---------------------------------------------------------------------------
// Forge invocation payloads (as documented; UUIDs arrive wrapped in `{}`)
// ---------------------------------------------------------------------------

export interface BitbucketActor {
  readonly type: string;
  readonly accountId: string;
  readonly uuid: string;
}

export interface BitbucketBranchRef {
  readonly branch: string;
  readonly commit: { readonly hash: string };
}

export type PullRequestEventType =
  | 'avi:bitbucket:created:pullrequest'
  | 'avi:bitbucket:updated:pullrequest';

/** https://developer.atlassian.com/platform/forge/events-reference/bitbucket/ */
export interface PullRequestEvent {
  readonly eventType: PullRequestEventType;
  readonly timestamp: string;
  readonly selfGenerated?: boolean;
  readonly actor: BitbucketActor;
  readonly workspace: { readonly uuid: string };
  readonly project: { readonly uuid: string };
  readonly repository: { readonly uuid: string; readonly slug?: string };
  readonly pullrequest: {
    readonly id: number;
    readonly state: string;
    readonly source: BitbucketBranchRef;
    readonly destination: BitbucketBranchRef;
    readonly title?: { readonly truncated: boolean; readonly value: string };
    readonly author?: BitbucketActor & { readonly displayName: string };
    readonly updatedOn?: string;
    readonly createdOn?: string;
  };
}

export type MergeCheckTriggerType = 'on-code-pushed' | 'on-merge';

/**
 * https://developer.atlassian.com/platform/forge/manifest-reference/modules/bitbucket-merge-check/
 * Carries NO commit hash and NO slugs: the head SHA must be read from Bitbucket REST.
 */
export interface MergeCheckEvent {
  readonly workspace: { readonly uuid: string };
  readonly repository: { readonly uuid: string };
  readonly pullrequest: { readonly id: number };
  readonly trigger: { readonly type: string };
  readonly mergeProperties?: {
    readonly commitMessage: string;
    readonly commitMessageTruncated: boolean;
    readonly mergeStrategy: string;
    readonly closeSourceBranch: boolean;
  };
}

export interface MergeCheckResponse {
  readonly success: boolean;
  readonly message?: string;
}

/** Extension context of `bitbucket:repoPullRequestOverviewPanel`. */
export interface PanelExtensionContext {
  readonly type: string;
  readonly repository: { readonly uuid: string };
  readonly pullRequest: { readonly id: number };
  readonly location: string;
}

/** Live PR facts Gate reads from `GET /2.0/repositories/{ws}/{repo}/pullrequests/{id}`. */
export interface PullRequestSnapshot {
  readonly ref: PrRef;
  /** Always the full 40-character SHA; the adapter resolves Bitbucket's abbreviated hash. */
  readonly headSha: CommitSha;
  /** Destination branch tip as Bitbucket reports it (may be abbreviated); used only as a diff spec. */
  readonly destinationCommit: string;
  readonly state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  readonly repo: RepoDescriptor;
  readonly descriptor: PullRequestDescriptor;
  /** Author's Bitbucket display name; Gate-only, for the panel and decision records. */
  readonly authorDisplayName: string | null;
}

// ---------------------------------------------------------------------------
// Gate state machine
// ---------------------------------------------------------------------------

export type GateState =
  | 'NO_SENSITIVE_SURFACE'
  | 'ANALYSIS_PENDING'
  | 'ANALYSIS_FAILED'
  | 'NOT_IN_CATALOG'
  | 'SIGNOFF_REQUIRED'
  | 'CLEARED'
  | 'RISK_ACCEPTED';

/**
 * The whole merge decision. A missing record for the current head SHA is treated as
 * ANALYSIS_PENDING, so an unclassified commit can never pass.
 */
export const MERGE_OUTCOME = {
  NO_SENSITIVE_SURFACE: 'PASS',
  ANALYSIS_PENDING: 'FAIL',
  ANALYSIS_FAILED: 'FAIL',
  NOT_IN_CATALOG: 'PASS',
  SIGNOFF_REQUIRED: 'FAIL',
  CLEARED: 'PASS',
  RISK_ACCEPTED: 'PASS',
} as const satisfies Record<GateState, 'PASS' | 'FAIL'>;

export interface SignoffRecord {
  readonly spaceKey: SpaceKey;
  readonly signer: RosterMember;
  readonly authorization: SignoffAuthorization;
  readonly headSha: CommitSha;
  readonly signedAt: IsoTimestamp;
}

export interface RiskExceptionRecord {
  readonly acceptedBy: RosterMember;
  readonly acceptedAs: 'PR_AUTHOR' | 'SERVICE_LEAD';
  readonly justification: string;
  readonly dueDate: IsoDate;
  readonly outstandingSpaces: readonly SpaceKey[];
  readonly ticket: RiskTicket;
  readonly headSha: CommitSha;
  readonly acceptedAt: IsoTimestamp;
}

interface GateRecordBase {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

interface SensitiveRecordBase extends GateRecordBase {
  readonly diff: DiffSummary;
}

export interface NoSensitiveSurfaceRecord extends GateRecordBase {
  readonly state: 'NO_SENSITIVE_SURFACE';
}

export interface AnalysisPendingRecord extends SensitiveRecordBase {
  readonly state: 'ANALYSIS_PENDING';
  readonly requestedAt: IsoTimestamp;
  readonly attempts: number;
}

export interface AnalysisFailedRecord extends SensitiveRecordBase {
  readonly state: 'ANALYSIS_FAILED';
  readonly attempts: number;
  readonly failure: {
    readonly code: AnalysisErrorCode | 'BRAIN_UNREACHABLE' | 'BRAIN_REJECTED' | 'DIFF_UNAVAILABLE' | 'INVALID_RIPPLE_CONFIG';
    readonly message: string;
    readonly retryable: boolean;
    readonly failedAt: IsoTimestamp;
  };
}

export interface NotInCatalogRecord extends SensitiveRecordBase {
  readonly state: 'NOT_IN_CATALOG';
  /** Decided by Gate alone: the repository declares no service, so Brain is never asked. */
  readonly reason: 'NO_RIPPLE_CONFIG';
}

export interface SignoffRequiredRecord extends SensitiveRecordBase {
  readonly state: 'SIGNOFF_REQUIRED';
  readonly verdict: CompleteVerdict;
  /** At most one per space; fewer than `verdict.signoffRequirements.length`. */
  readonly signoffs: readonly SignoffRecord[];
}

/** Every required team signed, or the verdict required no signoff (advisory). */
export interface ClearedRecord extends SensitiveRecordBase {
  readonly state: 'CLEARED';
  readonly verdict: CompleteVerdict;
  readonly signoffs: readonly SignoffRecord[];
}

export interface RiskAcceptedRecord extends SensitiveRecordBase {
  readonly state: 'RISK_ACCEPTED';
  readonly verdict: CompleteVerdict;
  readonly signoffs: readonly SignoffRecord[];
  readonly exception: RiskExceptionRecord;
}

export type GateRecord =
  | NoSensitiveSurfaceRecord
  | AnalysisPendingRecord
  | AnalysisFailedRecord
  | NotInCatalogRecord
  | SignoffRequiredRecord
  | ClearedRecord
  | RiskAcceptedRecord;

// ---------------------------------------------------------------------------
// Audit log — append-only; a new head SHA supersedes records, it never deletes them
// ---------------------------------------------------------------------------

interface AuditEventBase {
  readonly id: string;
  readonly pr: PrRef;
  readonly headSha: CommitSha;
  readonly at: IsoTimestamp;
}

export type AuditEvent =
  | (AuditEventBase & { readonly type: 'CLASSIFIED'; readonly sensitive: boolean; readonly findingCount: number })
  | (AuditEventBase & { readonly type: 'ANALYSIS_REQUESTED'; readonly attempt: number })
  | (AuditEventBase & { readonly type: 'VERDICT_RECEIVED'; readonly status: 'COMPLETE' | 'FAILED' })
  | (AuditEventBase & { readonly type: 'SIGNOFF_RECORDED'; readonly signoff: SignoffRecord })
  | (AuditEventBase & {
      readonly type: 'SIGNOFF_REJECTED';
      readonly spaceKey: SpaceKey;
      readonly actor: AccountId;
      readonly reason: PanelActionRejection;
    })
  | (AuditEventBase & { readonly type: 'RISK_ACCEPTED'; readonly exception: RiskExceptionRecord })
  | (AuditEventBase & {
      readonly type: 'HEAD_SUPERSEDED';
      readonly newHeadSha: CommitSha;
      readonly invalidatedSignoffs: number;
      readonly invalidatedException: boolean;
    })
  | (AuditEventBase & { readonly type: 'MERGE_CHECK_EVALUATED'; readonly trigger: string; readonly state: GateState; readonly passed: boolean });

// ---------------------------------------------------------------------------
// Forge KVS layout
// ---------------------------------------------------------------------------

/** Latest head Gate has seen for a PR; lets a new push detect what it supersedes. */
export interface PrPointer {
  readonly pr: PrRef;
  readonly headSha: CommitSha;
  readonly updatedAt: IsoTimestamp;
}

export const GATE_STORAGE = {
  /** -> PrPointer */
  pointer: (pr: PrRef): string => `pr:${prKeyString(pr)}`,
  /** -> GateRecord */
  record: (key: AnalysisKey): string => `gate:${analysisKeyString(key)}`,
  /** -> DispatchClaim. Written once with FAIL_IF_EXISTS; expires after DISPATCH_CLAIM_TTL_SECONDS. */
  claim: (key: AnalysisKey, attempt: number): string => `claim:${analysisKeyString(key)}:${attempt}`,
  /** -> AuditEvent. Sorts chronologically under `auditPrefix`. */
  audit: (event: Pick<AuditEvent, 'pr' | 'at' | 'id'>): string =>
    `audit:${prKeyString(event.pr)}:${event.at.replace(/[^0-9]/g, '')}:${event.id}`,
  auditPrefix: (pr: PrRef): string => `audit:${prKeyString(pr)}:`,
} as const;

// ---------------------------------------------------------------------------
// Panel <-> resolver contract (apps/gate/src/panel.ts <-> apps/gate/src/frontend)
// ---------------------------------------------------------------------------

/** Why the panel could not perform an action. Brain's reasons pass through unchanged. */
export type PanelActionRejection =
  | DecisionRejection
  /** The payload did not parse (bad SHA, space key, justification or date). */
  | 'INVALID_REQUEST'
  /** Brain or Bitbucket could not be reached or refused the call; `message` has detail. */
  | 'UNAVAILABLE';

export interface ViewerContext {
  readonly accountId: AccountId;
  readonly displayName: string;
  readonly isPrAuthor: boolean;
  /** Spaces whose VERIFIED roster lists the viewer, for the current record. */
  readonly rosterSpaceKeys: readonly SpaceKey[];
}

export interface PanelPullRequest {
  readonly title: string;
  readonly url: string;
  readonly authorDisplayName: string | null;
  readonly sourceBranch: string;
  readonly destinationBranch: string;
}

export type PanelView =
  /** Bitbucket could not be read, so the current head is unknown. */
  | { readonly status: 'UNAVAILABLE'; readonly message: string }
  | { readonly status: 'NOT_OPEN'; readonly prState: PullRequestSnapshot['state'] }
  | {
      readonly status: 'READY';
      readonly headSha: CommitSha;
      readonly pullRequest: PanelPullRequest;
      readonly record: GateRecord;
      /** Exactly what the merge check returns for this record right now. */
      readonly check: { readonly status: 'PASSED' | 'FAILED' | 'INELIGIBLE'; readonly message: string };
      /** Required spaces with no sign-off yet (empty outside SIGNOFF_REQUIRED). */
      readonly outstandingSpaceKeys: readonly SpaceKey[];
      /** ANALYSIS_FAILED only: true when Ripple will retry this commit by itself. */
      readonly willRetry: boolean;
      readonly viewer: ViewerContext;
    };

export type PanelActionResult =
  | { readonly ok: true; readonly view: PanelView }
  | { readonly ok: false; readonly reason: PanelActionRejection; readonly message: string; readonly view: PanelView };

/** Every mutating call echoes the head SHA the UI rendered, so a stale tab is rejected. */
export interface PanelResolverApi {
  readonly getPanelView: { readonly payload: Record<string, never>; readonly result: PanelView };
  readonly submitSignoff: {
    readonly payload: { readonly headSha: string; readonly spaceKey: string };
    readonly result: PanelActionResult;
  };
  readonly acceptRisk: {
    readonly payload: { readonly headSha: string; readonly justification: string; readonly dueDate: string };
    readonly result: PanelActionResult;
  };
}

export type PanelResolverMethod = keyof PanelResolverApi;
