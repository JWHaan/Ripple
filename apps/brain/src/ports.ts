/**
 * Everything Brain's logic needs from the outside world. `forge/` supplies the real
 * implementations and `testing/` the fakes.
 */
import type {
  AccountId,
  AnalysisKey,
  CallError,
  Decision,
  DecisionPushResponse,
  RiskTicket,
  Result,
  RosterMember,
  SigningKey,
  SpaceKey,
  TeamAri,
  TeamRef,
  Verdict,
  VerdictPushResponse,
} from '@ripple/contracts';
import type { AnalysisRecord, JiraCreateIssueRequest, RiskExceptionRecord } from './types.ts';

export interface BrainStore {
  getAnalysis(key: AnalysisKey): Promise<AnalysisRecord | null>;
  putAnalysis(record: AnalysisRecord): Promise<void>;
  getException(key: AnalysisKey): Promise<RiskExceptionRecord | null>;
  putException(record: RiskExceptionRecord): Promise<void>;
}

export interface JobQueue {
  enqueue(key: AnalysisKey): Promise<Result<void, string>>;
}

// --- Jira: which spaces exist, and who leads them ---------------------------

export interface DirectoryError {
  readonly kind: 'FORBIDDEN' | 'UNAVAILABLE' | 'MALFORMED';
  readonly message: string;
}

export interface JiraSpace {
  readonly key: SpaceKey;
  /** Numeric Jira project id, needed to build the space ARI. */
  readonly id: string;
  readonly name: string;
  readonly lead: RosterMember | null;
}

export interface SpaceDirectory {
  /** `null` when the space does not exist or the app cannot see it. */
  getSpace(key: SpaceKey): Promise<Result<JiraSpace | null, DirectoryError>>;
}

// --- Teamwork Graph: who owns a space, and who is on a team ------------------

export interface GraphError {
  readonly kind:
    /** Teamwork Graph is user-only and the pull request has no known author to act as. */
    | 'NO_ACTOR'
    | 'NO_CLOUD_ID'
    | 'FAILED';
  readonly message: string;
}

/**
 * An empty list is never proof of absence: a scope the admin did not grant returns empty
 * results rather than an error. Callers must treat empty as "unknown" and fall back.
 */
export interface TeamGraph {
  teamsForSpace(space: JiraSpace): Promise<Result<readonly TeamRef[], GraphError>>;
  teamsForUser(accountId: AccountId): Promise<Result<readonly TeamRef[], GraphError>>;
  membersOf(teamAri: TeamAri): Promise<Result<readonly RosterMember[], GraphError>>;
}

// --- everything else --------------------------------------------------------

export type NarrativeModelError = 'LLM_ERROR' | 'LLM_TIMEOUT' | 'MODERATION_BLOCKED';

export interface NarrativeModel {
  /** Returns the model's raw text. It is untrusted until validated. */
  complete(system: string, user: string): Promise<Result<string, NarrativeModelError>>;
}

export interface TicketError {
  readonly kind: 'NOT_CONFIGURED' | 'FORBIDDEN' | 'FAILED';
  readonly message: string;
}

/** Jira issue tracker for accepted-risk tickets. */
export interface RiskTickets {
  /** Project and issue type the ticket goes to; an error when Brain is not configured for it. */
  target(): Result<{ readonly projectKey: string; readonly issueType: string }, TicketError>;
  /** An existing ticket carrying this idempotency label, if any. */
  findByLabel(label: string): Promise<Result<RiskTicket | null, TicketError>>;
  create(issue: JiraCreateIssueRequest): Promise<Result<RiskTicket, TicketError>>;
}

export interface GateClient {
  pushVerdict(verdict: Verdict): Promise<Result<VerdictPushResponse, CallError>>;
  pushDecision(decision: Decision): Promise<Result<DecisionPushResponse, CallError>>;
}

export interface BrainDeps {
  readonly store: BrainStore;
  readonly queue: JobQueue;
  readonly spaces: SpaceDirectory;
  readonly graph: TeamGraph;
  readonly model: NarrativeModel;
  readonly gate: GateClient;
  readonly tickets: RiskTickets;
  /** Accepted keys for inbound requests: current first, then previous during rotation. */
  readonly verifyKeys: readonly SigningKey[];
  readonly now: () => Date;
}
