/**
 * Everything Gate's logic needs from the outside world. Handlers depend only on these
 * interfaces; `forge/` supplies the real implementations and `testing/` the fakes.
 */
import type {
  AcceptRiskRequest,
  AcceptRiskResponse,
  SignoffRequest,
  SignoffResponse,
  AnalysisKey,
  AnalyzeRequest,
  AnalyzeResponse,
  CallError,
  PrRef,
  Result,
  SigningKey,
} from '@ripple/contracts';
import type { AuditEvent, GateRecord, PrPointer, PullRequestSnapshot } from './types.ts';

export interface GateStore {
  getPointer(pr: PrRef): Promise<PrPointer | null>;
  setPointer(pointer: PrPointer): Promise<void>;
  getRecord(key: AnalysisKey): Promise<GateRecord | null>;
  putRecord(record: GateRecord): Promise<void>;
  /**
   * Atomically claims the right to send analysis `attempt` for `key` to Brain. Exactly one
   * concurrent caller gets `true`. Claims expire after DISPATCH_CLAIM_TTL_SECONDS, so a
   * claimant that dies before writing a record cannot block the head forever.
   */
  claimDispatch(key: AnalysisKey, attempt: number): Promise<boolean>;
  appendAudit(event: AuditEvent): Promise<void>;
}

export interface BitbucketError {
  readonly kind: 'NOT_FOUND' | 'FORBIDDEN' | 'RATE_LIMITED' | 'UPSTREAM' | 'MALFORMED';
  readonly message: string;
}

export interface BitbucketPort {
  /** Live PR state with the head resolved to a full 40-character SHA. */
  getPullRequest(pr: PrRef): Promise<Result<PullRequestSnapshot, BitbucketError>>;
  /** Unified diff of exactly `snapshot.headSha` against the destination. */
  getDiff(snapshot: PullRequestSnapshot): Promise<Result<string, BitbucketError>>;
  /** File content at a commit (full or abbreviated hash); `null` when the file does not exist there. */
  getFile(pr: PrRef, commit: string, path: string): Promise<Result<string | null, BitbucketError>>;
}

export interface BrainClient {
  analyze(request: AnalyzeRequest): Promise<Result<AnalyzeResponse, CallError>>;
  signoff(request: SignoffRequest): Promise<Result<SignoffResponse, CallError>>;
  acceptRisk(request: AcceptRiskRequest): Promise<Result<AcceptRiskResponse, CallError>>;
}

export interface GateDeps {
  readonly store: GateStore;
  readonly bitbucket: BitbucketPort;
  readonly brain: BrainClient;
  /** Accepted keys for inbound requests: current first, then previous during rotation. */
  readonly verifyKeys: readonly SigningKey[];
  readonly now: () => Date;
  readonly newId: () => string;
}
