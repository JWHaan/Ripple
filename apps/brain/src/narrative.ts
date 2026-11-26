/**
 * Stage 3 — grounded impact narrative. The model only explains; this module decides what
 * of its output survives. A claim about a space Brain did not resolve is dropped, and
 * nothing here can change who must sign off.
 */
import {
  decodeJson,
  parseSpaceKey,
  type DiffSummary,
  type ImpactNarrative,
  type ImpactedSpace,
  type ServiceDeclaration,
  type SpaceKey,
} from '@ripple/contracts';
import { z } from 'zod';
import type { NarrativeModel } from './ports.ts';
import type { DroppedClaim, LlmImpactOutput, NarrativeValidation } from './types.ts';

const llmOutputSchema: z.ZodType<LlmImpactOutput> = z.object({
  summary: z.string().min(1).max(4000),
  breakingLikelihood: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  spaceImpacts: z.array(z.object({ spaceKey: z.string(), explanation: z.string().min(1).max(2000) })).max(50),
});

export interface NarrativeInput {
  readonly diff: DiffSummary;
  readonly service: ServiceDeclaration;
  readonly serviceSpaceName: string;
  readonly impacted: readonly ImpactedSpace[];
}

export const SYSTEM_PROMPT = [
  'You explain the downstream impact of a code change for engineers reviewing a pull request.',
  'You are given FACTS: deterministic findings about the diff, the changed service, and the Jira spaces that consume it.',
  'Use only those facts. Never mention a space, team, person or identifier that is not in FACTS.',
  'You do not decide whether the change may merge and must not say that it may or may not.',
  'Reply with one JSON object and nothing else, matching exactly:',
  '{"summary": string, "breakingLikelihood": "LOW"|"MEDIUM"|"HIGH",',
  ' "spaceImpacts": [{"spaceKey": string, "explanation": string}]}',
  'spaceKey must be the key of an entry in FACTS.impacted.',
].join('\n');

export function buildUserPrompt(input: NarrativeInput): string {
  const facts = {
    service: { id: input.service.id, spaceKey: input.service.spaceKey, spaceName: input.serviceSpaceName },
    findings: input.diff.findings.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      file: finding.filePath,
      statement: finding.statement,
      excerpt: finding.excerpt,
    })),
    impacted: input.impacted.map((space) => ({
      spaceKey: space.spaceKey,
      name: space.name,
      owners: space.ownership.teams.map((team) => team.displayName),
    })),
  };
  return `FACTS:\n${JSON.stringify(facts, null, 2)}`;
}

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start === -1 || end <= start ? body : body.slice(start, end + 1);
}

/** Free text may not carry Atlassian identifiers; the model was given none. */
const IDENTIFIER = /ari:cloud:|\b\d{5,6}:[0-9a-f-]{20,}/i;

export function validateNarrative(raw: string, input: NarrativeInput): NarrativeValidation {
  const rejected: NarrativeValidation = { narrative: { status: 'UNAVAILABLE', reason: 'VALIDATION_REJECTED' }, dropped: [] };
  const decoded = decodeJson(llmOutputSchema, extractJson(raw));
  if (!decoded.ok) return rejected;
  const output = decoded.value;
  // The summary is shown verbatim, so an identifier in it rejects the whole narrative.
  if (IDENTIFIER.test(output.summary)) return rejected;

  const impacted = new Set<string>(input.impacted.map((space) => space.spaceKey));
  const dropped: DroppedClaim[] = [];
  const spaceImpacts: { spaceKey: SpaceKey; explanation: string }[] = [];
  for (const claim of output.spaceImpacts) {
    const key = parseSpaceKey(claim.spaceKey);
    if (key === null || !impacted.has(key)) dropped.push({ kind: 'UNKNOWN_SPACE', spaceKey: claim.spaceKey });
    else if (IDENTIFIER.test(claim.explanation)) dropped.push({ kind: 'UNGROUNDED_REFERENCE', spaceKey: claim.spaceKey });
    else spaceImpacts.push({ spaceKey: key, explanation: claim.explanation });
  }
  return {
    narrative: {
      status: 'GROUNDED',
      summary: output.summary,
      breakingLikelihood: output.breakingLikelihood,
      spaceImpacts,
      droppedClaims: dropped.length,
    },
    dropped,
  };
}

/** Never throws and never fails the analysis: an unusable model yields an UNAVAILABLE narrative. */
export async function generateNarrative(model: NarrativeModel, input: NarrativeInput): Promise<ImpactNarrative> {
  const raw = await model.complete(SYSTEM_PROMPT, buildUserPrompt(input));
  if (!raw.ok) return { status: 'UNAVAILABLE', reason: raw.error };
  const { narrative, dropped } = validateNarrative(raw.value, input);
  if (dropped.length > 0) console.warn(`narrative: dropped ${dropped.length} ungrounded claim(s)`);
  return narrative;
}
