/** In-memory implementations of Gate's ports, for unit and cross-app tests. */
import {
  analysisKeyString,
  err,
  ok,
  parseCommitSha,
  parseRepoUuid,
  parseWorkspaceUuid,
  prKeyString,
  type AcceptRiskRequest,
  type AcceptRiskResponse,
  type SignoffRequest,
  type AccountId,
  type AnalysisKey,
  type SignoffResponse,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type CallError,
  type CommitSha,
  type PrRef,
  type Result,
  type SigningKey,
} from '@ripple/contracts';
import type { BitbucketError, BitbucketPort, BrainClient, GateDeps, GateStore } from '../ports.ts';
import type { AuditEvent, GateRecord, PrPointer, PullRequestSnapshot } from '../types.ts';

function must<T>(value: T | null): T {
  if (value === null) throw new Error('invalid test fixture value');
  return value;
}

export const TEST_PR: PrRef = {
  workspaceUuid: must(parseWorkspaceUuid('{11111111-1111-4111-8111-111111111111}')),
  repoUuid: must(parseRepoUuid('{22222222-2222-4222-8222-222222222222}')),
  prId: 7,
};
export const SHA_A: CommitSha = must(parseCommitSha('a'.repeat(40)));
export const SHA_B: CommitSha = must(parseCommitSha('b'.repeat(40)));
export const TEST_KEY: SigningKey = { id: 'test', secret: 'k'.repeat(64) };

export class MemoryGateStore implements GateStore {
  readonly pointers = new Map<string, PrPointer>();
  readonly records = new Map<string, GateRecord>();
  readonly audit: AuditEvent[] = [];
  async getPointer(pr: PrRef): Promise<PrPointer | null> {
    return this.pointers.get(prKeyString(pr)) ?? null;
  }
  async setPointer(pointer: PrPointer): Promise<void> {
    this.pointers.set(prKeyString(pointer.pr), pointer);
  }
  async getRecord(key: AnalysisKey): Promise<GateRecord | null> {
    return this.records.get(analysisKeyString(key)) ?? null;
  }
  async putRecord(record: GateRecord): Promise<void> {
    this.records.set(analysisKeyString(record.key), record);
  }
  readonly claims = new Set<string>();
  async claimDispatch(key: AnalysisKey, attempt: number): Promise<boolean> {
    const claimKey = `${analysisKeyString(key)}:${attempt}`;
    if (this.claims.has(claimKey)) return false;
    this.claims.add(claimKey);
    return true;
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }
}

export class FakeBitbucket implements BitbucketPort {
  headSha: CommitSha = SHA_A;
  state: PullRequestSnapshot['state'] = 'OPEN';
  diff = '';
  readonly files = new Map<string, string>();
  failure: BitbucketError | null = null;
  authorAccountId: AccountId | null = null;
  calls = { pullRequest: 0, diff: 0, file: 0 };

  snapshot(pr: PrRef): PullRequestSnapshot {
    return {
      ref: pr,
      headSha: this.headSha,
      destinationCommit: DESTINATION_COMMIT,
      state: this.state,
      repo: { fullName: 'acme/auth-service', url: 'https://bitbucket.org/acme/auth-service' },
      descriptor: {
        title: 'Change token format',
        url: 'https://bitbucket.org/acme/auth-service/pull-requests/7',
        authorAccountId: this.authorAccountId,
        sourceBranch: 'feature/token',
        destinationBranch: 'main',
      },
    };
  }
  async getPullRequest(pr: PrRef): Promise<Result<PullRequestSnapshot, BitbucketError>> {
    this.calls.pullRequest += 1;
    return this.failure === null ? ok(this.snapshot(pr)) : err(this.failure);
  }
  async getDiff(): Promise<Result<string, BitbucketError>> {
    this.calls.diff += 1;
    return this.failure === null ? ok(this.diff) : err(this.failure);
  }
  async getFile(_pr: PrRef, commit: string, path: string): Promise<Result<string | null, BitbucketError>> {
    this.calls.file += 1;
    if (this.failure !== null) return err(this.failure);
    // `path` alone = present at every commit; `commit:path` = present at that commit only.
    return ok(this.files.get(`${commit}:${path}`) ?? this.files.get(path) ?? null);
  }
}

export class FakeBrain implements BrainClient {
  readonly requests: AnalyzeRequest[] = [];
  respond: (request: AnalyzeRequest) => Result<AnalyzeResponse, CallError> = (request) =>
    ok({ v: 'v1', key: request.key, state: 'ACCEPTED' });
  async signoff(_request: SignoffRequest): Promise<Result<SignoffResponse, CallError>> {
    return err({ kind: 'UNREACHABLE', message: 'not wired' });
  }
  async acceptRisk(_request: AcceptRiskRequest): Promise<Result<AcceptRiskResponse, CallError>> {
    return err({ kind: 'UNREACHABLE', message: 'not wired' });
  }
  async analyze(request: AnalyzeRequest): Promise<Result<AnalyzeResponse, CallError>> {
    this.requests.push(request);
    return this.respond(request);
  }
}

export interface GateHarness {
  readonly deps: GateDeps;
  readonly store: MemoryGateStore;
  readonly bitbucket: FakeBitbucket;
  readonly brain: FakeBrain;
  readonly clock: { now: Date };
}

export function gateHarness(brain: BrainClient & Partial<FakeBrain> = new FakeBrain()): GateHarness {
  const store = new MemoryGateStore();
  const bitbucket = new FakeBitbucket();
  const clock = { now: new Date('2026-11-26T10:00:00.000Z') };
  let id = 0;
  return {
    deps: { store, bitbucket, brain, verifyKeys: [TEST_KEY], now: () => clock.now, newId: () => `audit-${(id += 1)}` },
    store,
    bitbucket,
    brain: brain as FakeBrain,
    clock,
  };
}

export const TOKEN_DIFF = [
  'diff --git a/src/auth/token.ts b/src/auth/token.ts',
  '--- a/src/auth/token.ts',
  '+++ b/src/auth/token.ts',
  '@@ -10,3 +10,3 @@',
  "-  return jwt.sign({ sub: user.id }, key, { expiresIn: '1h' });",
  "+  return jwt.sign({ sub: user.id, tenant: user.tenantId }, key, { expiresIn: '15m' });",
  '',
].join('\n');

export const TYPO_DIFF = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-Teh auth service',
  '+The auth service',
  '',
].join('\n');

export const DESTINATION_COMMIT = 'c0ffee000000';

export const RIPPLE_YML = ['service:', '  id: auth-service', '  jiraSpaceKey: PLAT', 'downstream: [MPLAT, MOB]', ''].join('\n');
