/**
 * Ripple Brain — internal contracts.
 *
 * Covers: the analysis job, the untrusted LLM output and its validation, the Jira risk ticket, and Forge KVS schemas.
 * Wire types shared with Gate live in @ripple/contracts.
 */
import type {
  AnalysisKey,
  AnalyzeRequest,
  ContractVersion,
  ImpactNarrative,
  IsoDate,
  IsoTimestamp,
  Likelihood,
  PullRequestDescriptor,
  RiskTicket,
  RosterMember,
  Verdict,
} from '@ripple/contracts';
import { analysisKeyString } from '@ripple/contracts';

// ---------------------------------------------------------------------------
// Environment (set with `forge variables set`, never committed)
// ---------------------------------------------------------------------------

export const BRAIN_ENV = {
  /** Gate's web trigger URL, from `forge webtrigger create` in apps/gate. */
  gateApiUrl: 'RIPPLE_GATE_API_URL',
  /** Current shared secret as `{keyId}:{secret}`. Set with `--encrypt`. */
  signingKey: 'RIPPLE_SIGNING_KEY',
  /** Optional previous secret, same format, accepted during rotation. */
  previousSigningKey: 'RIPPLE_SIGNING_KEY_PREVIOUS',
  /** Jira project that receives risk-exception tickets, e.g. `RISK`. */
  jiraProjectKey: 'RIPPLE_JIRA_PROJECT_KEY',
  /** Issue type name in that project, e.g. `Task`. */
  jiraIssueType: 'RIPPLE_JIRA_ISSUE_TYPE',
  /** Optional Forge LLM model id; when unset the first active model from `list()` is used. */
  llmModel: 'RIPPLE_LLM_MODEL',
  /** Site cloud id, used to build Jira space ARIs for the Teamwork Graph. Falls back to the invocation context. */
  cloudId: 'RIPPLE_CLOUD_ID',
} as const;

/** A QUEUED/RUNNING analysis older than this is assumed dead and may be re-enqueued. */
export const ANALYSIS_STUCK_MS = 10 * 60 * 1000;

/** Queue name; must equal `modules.consumer[].queue` in manifest.yml. */
export const ANALYSIS_QUEUE = 'ripple-analysis';

/** A project lead in many teams must not make all of them owners: only the first is used. */
export const MAX_LEAD_TEAMS = 1;
/** Cap on the size of one sign-off roster. */
export const MAX_ROSTER_MEMBERS = 100;

// ---------------------------------------------------------------------------
// Analysis job (webtrigger -> queue -> consumer)
// ---------------------------------------------------------------------------

export interface AnalysisJob {
  readonly v: ContractVersion;
  readonly request: AnalyzeRequest;
  readonly enqueuedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// LLM boundary — output is untrusted until validated against the resolved spaces
// ---------------------------------------------------------------------------

/** Raw structured output requested from Forge LLMs. Identifiers are plain strings on purpose. */
export interface LlmImpactOutput {
  readonly summary: string;
  readonly breakingLikelihood: Likelihood;
  readonly spaceImpacts: readonly { readonly spaceKey: string; readonly explanation: string }[];
}

export type DroppedClaim = { readonly kind: 'UNKNOWN_SPACE' | 'UNGROUNDED_REFERENCE'; readonly spaceKey: string };

export interface NarrativeValidation {
  readonly narrative: ImpactNarrative;
  readonly dropped: readonly DroppedClaim[];
}

// ---------------------------------------------------------------------------
// Jira risk-exception ticket (REST v3 `POST /rest/api/3/issue`)
// ---------------------------------------------------------------------------

export type AdfInline =
  | { readonly type: 'text'; readonly text: string; readonly marks?: readonly AdfMark[] }
  | { readonly type: 'hardBreak' };

export type AdfMark =
  | { readonly type: 'strong' }
  | { readonly type: 'code' }
  | { readonly type: 'link'; readonly attrs: { readonly href: string } };

export type AdfBlock =
  | { readonly type: 'paragraph'; readonly content: readonly AdfInline[] }
  | { readonly type: 'heading'; readonly attrs: { readonly level: 1 | 2 | 3 }; readonly content: readonly AdfInline[] }
  | { readonly type: 'bulletList'; readonly content: readonly AdfListItem[] };

export interface AdfListItem {
  readonly type: 'listItem';
  readonly content: readonly Extract<AdfBlock, { type: 'paragraph' }>[];
}

export interface AdfDocument {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfBlock[];
}

export interface JiraCreateIssueRequest {
  readonly fields: {
    readonly project: { readonly key: string };
    readonly issuetype: { readonly name: string };
    readonly summary: string;
    readonly description: AdfDocument;
    readonly duedate: IsoDate;
    /** Always includes the idempotency label from `riskTicketLabel`. */
    readonly labels: readonly string[];
  };
}

export interface JiraCreateIssueResponse {
  readonly id: string;
  readonly key: string;
  readonly self: string;
}

// ---------------------------------------------------------------------------
// Forge KVS layout
// ---------------------------------------------------------------------------

export type AnalysisRecord =
  | {
      readonly state: 'QUEUED' | 'RUNNING';
      readonly v: ContractVersion;
      readonly key: AnalysisKey;
      readonly request: AnalyzeRequest;
      readonly updatedAt: IsoTimestamp;
    }
  | {
      readonly state: 'COMPLETE';
      readonly v: ContractVersion;
      readonly key: AnalysisKey;
      readonly verdict: Verdict;
      /** Kept after completion: author exclusion and the risk ticket both need it. */
      readonly pullRequest: PullRequestDescriptor;
      /** false until Gate acknowledged the push; `/v1/verdict` covers the gap. */
      readonly pushedToGate: boolean;
      readonly updatedAt: IsoTimestamp;
    };

export interface RiskExceptionRecord {
  readonly v: ContractVersion;
  readonly key: AnalysisKey;
  readonly acceptedBy: RosterMember;
  readonly ticket: RiskTicket;
  readonly createdAt: IsoTimestamp;
}

export const BRAIN_STORAGE = {
  /** -> AnalysisRecord */
  analysis: (key: AnalysisKey): string => `analysis:${analysisKeyString(key)}`,
  /** -> RiskExceptionRecord */
  exception: (key: AnalysisKey): string => `exception:${analysisKeyString(key)}`,
} as const;

/** Jira label that makes ticket creation idempotent even if the KVS write is lost. */
export function riskTicketLabel(key: AnalysisKey): string {
  return `ripple-${analysisKeyString(key).replace(/:/g, '-')}`;
}
