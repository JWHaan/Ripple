/** In-memory implementations of Brain's ports, for unit and cross-app tests. */
import {
  analysisKeyString,
  err,
  ok,
  parseAccountId,
  parseJiraIssueKey,
  parseSpaceKey,
  parseTeamAri,
  type AccountId,
  type AnalysisKey,
  type CallError,
  type Decision,
  type DecisionPushResponse,
  type RiskTicket,
  type Result,
  type RosterMember,
  type SigningKey,
  type SpaceKey,
  type TeamAri,
  type TeamRef,
  type Verdict,
  type VerdictPushResponse,
} from '@ripple/contracts';
import type {
  BrainDeps,
  BrainStore,
  DirectoryError,
  GateClient,
  GraphError,
  JiraSpace,
  JobQueue,
  NarrativeModel,
  NarrativeModelError,
  RiskTickets,
  TicketError,
  SpaceDirectory,
  TeamGraph,
} from '../ports.ts';
import type { AnalysisRecord, JiraCreateIssueRequest, RiskExceptionRecord } from '../types.ts';

function must<T>(value: T | null): T {
  if (value === null) throw new Error('invalid test fixture value');
  return value;
}

export const space = (key: string): SpaceKey => must(parseSpaceKey(key));
export const team = (id: string, displayName = id): TeamRef => ({ teamAri: must(parseTeamAri(`ari:cloud:identity::team/${id}`)), displayName });
export const person = (id: string, displayName = id): RosterMember => ({ accountId: must(parseAccountId(id)), displayName });
export const TEST_KEY: SigningKey = { id: 'test', secret: 'k'.repeat(64) };

export class MemorySpaces implements SpaceDirectory {
  readonly spaces = new Map<SpaceKey, JiraSpace>();
  failure: DirectoryError | null = null;
  add(key: string, name: string, lead: RosterMember | null = null): this {
    this.spaces.set(space(key), { key: space(key), id: String(10000 + this.spaces.size), name, lead });
    return this;
  }
  async getSpace(key: SpaceKey): Promise<Result<JiraSpace | null, DirectoryError>> {
    return this.failure === null ? ok(this.spaces.get(key) ?? null) : err(this.failure);
  }
}

export class MemoryGraph implements TeamGraph {
  readonly spaceTeams = new Map<SpaceKey, TeamRef[]>();
  readonly userTeams = new Map<AccountId, TeamRef[]>();
  readonly members = new Map<TeamAri, RosterMember[]>();
  failure: GraphError | null = null;
  async teamsForSpace(target: JiraSpace): Promise<Result<readonly TeamRef[], GraphError>> {
    return this.failure === null ? ok(this.spaceTeams.get(target.key) ?? []) : err(this.failure);
  }
  async teamsForUser(accountId: AccountId): Promise<Result<readonly TeamRef[], GraphError>> {
    return this.failure === null ? ok(this.userTeams.get(accountId) ?? []) : err(this.failure);
  }
  async membersOf(teamAri: TeamAri): Promise<Result<readonly RosterMember[], GraphError>> {
    return this.failure === null ? ok(this.members.get(teamAri) ?? []) : err(this.failure);
  }
}

export class MemoryBrainStore implements BrainStore {
  readonly analyses = new Map<string, AnalysisRecord>();
  async getAnalysis(key: AnalysisKey): Promise<AnalysisRecord | null> {
    return this.analyses.get(analysisKeyString(key)) ?? null;
  }
  async putAnalysis(record: AnalysisRecord): Promise<void> {
    this.analyses.set(analysisKeyString(record.key), record);
  }
  readonly exceptions = new Map<string, RiskExceptionRecord>();
  async getException(key: AnalysisKey): Promise<RiskExceptionRecord | null> {
    return this.exceptions.get(analysisKeyString(key)) ?? null;
  }
  async putException(record: RiskExceptionRecord): Promise<void> {
    this.exceptions.set(analysisKeyString(record.key), record);
  }
}

export class MemoryQueue implements JobQueue {
  readonly jobs: AnalysisKey[] = [];
  failure: string | null = null;
  async enqueue(key: AnalysisKey): Promise<Result<void, string>> {
    if (this.failure !== null) return err(this.failure);
    this.jobs.push(key);
    return ok(undefined);
  }
}

export class FakeModel implements NarrativeModel {
  reply: Result<string, NarrativeModelError> = err('LLM_ERROR');
  prompts: { system: string; user: string }[] = [];
  async complete(system: string, user: string): Promise<Result<string, NarrativeModelError>> {
    this.prompts.push({ system, user });
    return this.reply;
  }
}

export class FakeTickets implements RiskTickets {
  readonly created: JiraCreateIssueRequest[] = [];
  configured = true;
  failure: TicketError | null = null;
  target(): Result<{ projectKey: string; issueType: string }, TicketError> {
    return this.configured ? ok({ projectKey: 'RISK', issueType: 'Task' }) : err({ kind: 'NOT_CONFIGURED', message: 'RIPPLE_JIRA_PROJECT_KEY is not set' });
  }
  private ticket(n: number): RiskTicket {
    return { issueKey: must(parseJiraIssueKey(`RISK-${n}`)), issueUrl: `https://acme.atlassian.net/browse/RISK-${n}` };
  }
  async findByLabel(label: string): Promise<Result<RiskTicket | null, TicketError>> {
    if (this.failure !== null) return err(this.failure);
    const index = this.created.findIndex((issue) => issue.fields.labels.includes(label));
    return ok(index === -1 ? null : this.ticket(index + 1));
  }
  async create(issue: JiraCreateIssueRequest): Promise<Result<RiskTicket, TicketError>> {
    if (this.failure !== null) return err(this.failure);
    this.created.push(issue);
    return ok(this.ticket(this.created.length));
  }
}

export class FakeGate implements GateClient {
  readonly decisions: Decision[] = [];
  decisionReply: (decision: Decision) => Result<DecisionPushResponse, CallError> = (decision) =>
    ok({ v: 'v1', key: decision.key, outcome: 'APPLIED', state: decision.type === 'RISK_ACCEPTED' ? 'RISK_ACCEPTED' : 'SIGNOFF_REQUIRED' });
  async pushDecision(decision: Decision): Promise<Result<DecisionPushResponse, CallError>> {
    this.decisions.push(decision);
    return this.decisionReply(decision);
  }
  readonly pushed: Verdict[] = [];
  failure: CallError | null = null;
  async pushVerdict(verdict: Verdict): Promise<Result<VerdictPushResponse, CallError>> {
    if (this.failure !== null) return err(this.failure);
    this.pushed.push(verdict);
    return ok({ v: 'v1', key: verdict.key, outcome: 'STORED' });
  }
}

export const MOBILE_TEAM = team('mobile', 'Mobile');
export const MO = person('712020:mob-lead', 'Mo Lead');
export const MIA = person('712020:mob-dev', 'Mia Dev');
export const APP_LEAD = person('712020:app-lead', 'Ana Lead');
export const APP_TEAM = team('apps', 'Apps');
/** The author of the pull request in the `analyze-request` fixture. */
export const AUTHOR = person('712020:5fb4febc-facf-4d60-8076-a1c699000001', 'Ari Author');

/**
 * The demo site: auth-service lives in PLAT and is consumed by MPLAT and MOB.
 * MPLAT has a linked team; MOB has only a project lead, who belongs to a team.
 */
export function demoSite(): { spaces: MemorySpaces; graph: MemoryGraph } {
  const spaces = new MemorySpaces().add('PLAT', 'Platform Development').add('MPLAT', 'Mobile Platform', MO).add('MOB', 'Mobile Application', APP_LEAD);
  const graph = new MemoryGraph();
  graph.spaceTeams.set(space('MPLAT'), [MOBILE_TEAM]);
  graph.members.set(MOBILE_TEAM.teamAri, [MO, MIA]);
  graph.userTeams.set(APP_LEAD.accountId, [APP_TEAM, team('other')]);
  graph.members.set(APP_TEAM.teamAri, [APP_LEAD, person('712020:app-dev', 'Avi Dev')]);
  return { spaces, graph };
}

export interface BrainHarness {
  readonly deps: BrainDeps;
  readonly store: MemoryBrainStore;
  readonly queue: MemoryQueue;
  readonly spaces: MemorySpaces;
  readonly graph: MemoryGraph;
  readonly model: FakeModel;
  readonly gate: FakeGate;
  readonly tickets: FakeTickets;
  readonly clock: { now: Date };
}

export function brainHarness(gate: GateClient = new FakeGate()): BrainHarness {
  const store = new MemoryBrainStore();
  const queue = new MemoryQueue();
  const { spaces, graph } = demoSite();
  const model = new FakeModel();
  const tickets = new FakeTickets();
  const clock = { now: new Date('2026-11-26T10:00:00.000Z') };
  return {
    deps: { store, queue, spaces, graph, model, gate, tickets, verifyKeys: [TEST_KEY], now: () => clock.now },
    store,
    queue,
    spaces,
    graph,
    model,
    gate: gate as FakeGate,
    tickets,
    clock,
  };
}
