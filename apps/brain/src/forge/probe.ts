/**
 * SMOKE-TEST DIAGNOSTIC — not part of the product. Remove once the platform boundary is validated.
 *
 * POST /v1/diagnostics/graph-probe {"accountId": "..."} (HMAC-signed like every other route)
 * enqueues a job; the queue consumer then runs Teamwork Graph queries impersonating that
 * account and logs the raw responses, proving (or disproving) offline impersonation.
 */
import api from '@forge/api';
import { Queue } from '@forge/events';
import {
  apiError,
  authenticate,
  decodeJson,
  decodeValue,
  errorMessage,
  jsonResponse,
  type SigningKey,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from '@ripple/contracts';
import { z } from 'zod';
import { ANALYSIS_QUEUE } from '../types.ts';

export const PROBE_PATH = '/v1/diagnostics/graph-probe';
const probeSchema = z.object({
  accountId: z.string().regex(/^[0-9a-zA-Z:-]{1,128}$/),
  /** Optional: run exactly this Teamwork Graph query instead of the default roster probe. */
  query: z.string().max(4000).optional(),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export const probeJobSchema = z.object({ body: z.object({ probe: probeSchema }) });

export async function handleProbeRequest(
  request: WebTriggerRequestShape,
  keys: readonly SigningKey[],
): Promise<WebTriggerResponseShape> {
  const authenticated = authenticate(request, keys);
  if (!authenticated.ok) return authenticated.error;
  const decoded = decodeJson(probeSchema, authenticated.value.body);
  if (!decoded.ok) return apiError('MALFORMED_PAYLOAD', decoded.error.message);
  const { jobId } = await new Queue({ key: ANALYSIS_QUEUE }).push({ body: { probe: decoded.value } });
  return jsonResponse(202, { queued: true, jobId });
}

async function run(label: string, accountId: string, query: string, variables: Record<string, string | number>): Promise<unknown> {
  try {
    const response = await api.asUser(accountId).requestTeamworkGraph(query, variables);
    const text = await response.text();
    console.log(`[probe] ${label}: HTTP ${response.status} ${text.slice(0, 1500)}`);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    console.log(`[probe] ${label}: THREW ${errorMessage(cause)}`);
    return null;
  }
}

const teamsResult = z.object({
  data: z.object({
    atlassianUserInTeams: z.object({ edges: z.array(z.object({ node: z.object({ id: z.string() }) })) }),
  }),
});

export async function runGraphProbe(probe: z.infer<typeof probeSchema>): Promise<void> {
  const { accountId } = probe;
  console.log(`[probe] start: impersonating ${accountId} inside the async queue consumer`);
  if (probe.query !== undefined) {
    await run('custom', accountId, probe.query, probe.variables ?? {});
    console.log('[probe] done');
    return;
  }
  await run('echo', accountId, 'query { echo(myString: "ripple") }', {});
  const teams = await run(
    'atlassianUserInTeams',
    accountId,
    `query ripple_probeTeams($userId: ID!) {
      atlassianUserInTeams(userId: $userId, first: 25) { edges { node { __typename ... on AtlassianTeam { id displayName } } } }
    }`,
    { userId: `ari:cloud:identity::user/${accountId}` },
  );
  const decoded = decodeValue(teamsResult, teams);
  const teamAri = decoded.ok ? decoded.value.data.atlassianUserInTeams.edges[0]?.node.id : undefined;
  if (teamAri === undefined) {
    console.log('[probe] no team returned for this user; skipping atlassianTeamMembers');
  } else {
    await run(
      'atlassianTeamMembers',
      accountId,
      `query ripple_probeMembers($teamAri: ID!) {
        atlassianTeamMembers(teamAri: $teamAri, first: 25) { edges { node { __typename ... on AtlassianUser { accountId name } } } }
      }`,
      { teamAri },
    );
  }
  console.log('[probe] done');
}
