import type {
  AccountId,
  AnalysisKey,
  CommitSha,
  IsoDate,
  IsoTimestamp,
  JiraIssueKey,
  PrRef,
  RepoUuid,
  SpaceKey,
  TeamAri,
  WorkspaceUuid,
} from './types.ts';

const UUID = /^\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?$/;
const SHA = /^[0-9a-f]{40}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;
const ACCOUNT_ID = /^[0-9a-zA-Z:-]{1,128}$/;
const SPACE_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const TEAM_ARI = /^ari:cloud:identity::team\/[0-9a-zA-Z-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function unwrapUuid(raw: string): string | null {
  const match = UUID.exec(raw);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseWorkspaceUuid(raw: string): WorkspaceUuid | null {
  return unwrapUuid(raw) as WorkspaceUuid | null;
}

export function parseRepoUuid(raw: string): RepoUuid | null {
  return unwrapUuid(raw) as RepoUuid | null;
}

/** Accepts only a full 40-character SHA; abbreviated hashes must be resolved first. */
export function parseCommitSha(raw: string): CommitSha | null {
  const sha = raw.toLowerCase();
  return SHA.test(sha) ? (sha as CommitSha) : null;
}

export function parseAccountId(raw: string): AccountId | null {
  return ACCOUNT_ID.test(raw) ? (raw as AccountId) : null;
}

export function parseSpaceKey(raw: string): SpaceKey | null {
  return SPACE_KEY.test(raw) ? (raw as SpaceKey) : null;
}

export function parseTeamAri(raw: string): TeamAri | null {
  return TEAM_ARI.test(raw) ? (raw as TeamAri) : null;
}

export function parseIsoDate(raw: string): IsoDate | null {
  return ISO_DATE.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? (raw as IsoDate) : null;
}

export function isoNow(now: Date = new Date()): IsoTimestamp {
  return now.toISOString() as IsoTimestamp;
}

export function parseIsoTimestamp(raw: string): IsoTimestamp | null {
  return ISO_TIMESTAMP.test(raw) && !Number.isNaN(Date.parse(raw)) ? (raw as IsoTimestamp) : null;
}

export function parseJiraIssueKey(raw: string): JiraIssueKey | null {
  return JIRA_KEY.test(raw) ? (raw as JiraIssueKey) : null;
}

/** `{workspace}:{repo}:{prId}` — safe for Forge KVS keys. */
export function prKeyString(pr: PrRef): string {
  return `${pr.workspaceUuid}:${pr.repoUuid}:${pr.prId}`;
}

/** `{workspace}:{repo}:{prId}:{sha40}` — safe for Forge KVS keys (well under the 500-char limit). */
export function analysisKeyString(key: AnalysisKey): string {
  return `${prKeyString(key)}:${key.headSha}`;
}
