/**
 * Teamwork Graph adapter (curated queries only).
 *
 * Teamwork Graph has no app-level access: every call impersonates `actAs`, the pull
 * request author, from the queue consumer. Operation names must look like `company_operation`.
 */
import api from '@forge/api';
import {
  decodeValue,
  err,
  ok,
  parseAccountId,
  parseTeamAri,
  type AccountId,
  type Result,
  type RosterMember,
  type TeamAri,
  type TeamRef,
} from '@ripple/contracts';
import { z } from 'zod';
import type { GraphError, JiraSpace, TeamGraph } from '../ports.ts';
import { graphRequest } from './graphql.ts';

const PAGE_SIZE = 25; // curated queries reject anything larger

const TEAM_NODE = 'edges { node { __typename ... on AtlassianTeam { id displayName } } }';
const QUERIES = {
  teamsForSpace: `query ripple_teamsBySpace($id: ID!, $first: Int!) { result: atlassianTeamsBySpace(spaceAri: $id, first: $first) { ${TEAM_NODE} } }`,
  teamsForUser: `query ripple_userInTeams($id: ID!, $first: Int!) { result: atlassianUserInTeams(userId: $id, first: $first) { ${TEAM_NODE} } }`,
  membersOf: `query ripple_teamMembers($id: ID!, $first: Int!) { result: atlassianTeamMembers(teamAri: $id, first: $first) { edges { node { __typename ... on AtlassianUser { accountId name } } } } }`,
} as const;

const connection = z.object({
  result: z
    .object({
      edges: z.array(
        z.object({
          node: z
            .object({
              id: z.string().nullish(),
              displayName: z.string().nullish(),
              accountId: z.string().nullish(),
              name: z.string().nullish(),
            })
            .nullish(),
        }),
      ),
    })
    .nullable(),
});

type Node = NonNullable<z.infer<typeof connection>['result']>['edges'][number]['node'];

export function teamGraph(actAs: AccountId | null, cloudId: string | null): TeamGraph {
  async function nodes(query: string, id: string, what: string): Promise<Result<Node[], GraphError>> {
    if (actAs === null) return err({ kind: 'NO_ACTOR', message: 'no pull request author to act as' });
    const payload = await graphRequest(() => api.asUser(actAs).requestTeamworkGraph(query, { id, first: PAGE_SIZE }), what);
    if (!payload.ok) return err({ kind: 'FAILED', message: payload.error.message });
    const decoded = decodeValue(connection, payload.value.data);
    if (!decoded.ok) return err({ kind: 'FAILED', message: `${what}: ${decoded.error.message}` });
    if (decoded.value.result === null) return err({ kind: 'FAILED', message: `${what}: ${payload.value.errors.join('; ') || 'null result'}` });
    return ok(decoded.value.result.edges.map((edge) => edge.node));
  }

  const teams = (found: Node[]): TeamRef[] =>
    found.flatMap((node) => {
      const teamAri = node?.id ? parseTeamAri(node.id) : null;
      return teamAri === null ? [] : [{ teamAri, displayName: node?.displayName ?? 'Unnamed team' }];
    });

  return {
    async teamsForSpace(space: JiraSpace): Promise<Result<readonly TeamRef[], GraphError>> {
      if (cloudId === null) return err({ kind: 'NO_CLOUD_ID', message: 'site cloud id is unknown' });
      const found = await nodes(QUERIES.teamsForSpace, `ari:cloud:jira:${cloudId}:project/${space.id}`, 'teams for space');
      return found.ok ? ok(teams(found.value)) : found;
    },
    async teamsForUser(accountId: AccountId): Promise<Result<readonly TeamRef[], GraphError>> {
      const found = await nodes(QUERIES.teamsForUser, `ari:cloud:identity::user/${accountId}`, 'teams for user');
      return found.ok ? ok(teams(found.value)) : found;
    },
    async membersOf(teamAri: TeamAri): Promise<Result<readonly RosterMember[], GraphError>> {
      const found = await nodes(QUERIES.membersOf, teamAri, 'team members');
      if (!found.ok) return found;
      return ok(
        found.value.flatMap((node) => {
          const accountId = node?.accountId ? parseAccountId(node.accountId) : null;
          return accountId === null ? [] : [{ accountId, displayName: node?.name ?? 'Unknown user' }];
        }),
      );
    },
  };
}
