/**
 * Tiered ownership resolution for one Jira space. Deterministic; no LLM.
 *
 *   1. SPACE_TEAM  teams linked to the space in the Teamwork Graph
 *   2. LEAD_TEAM   no linked team -> the Jira project lead's team (inferred)
 *   3. LEAD_ONLY   no team at all -> the project lead alone
 *   4. UNRESOLVED  no lead either
 *
 * The roster (who may sign) is the project lead plus the members of the owning teams.
 * It is VERIFIED when at least one person was resolved, DEGRADED otherwise.
 */
import type { AccountId, RosterMember, SignoffRoster, SpaceOwnership, TeamRef } from '@ripple/contracts';
import type { JiraSpace, TeamGraph } from './ports.ts';
import { MAX_LEAD_TEAMS, MAX_ROSTER_MEMBERS } from './types.ts';

export interface ResolvedOwnership {
  readonly ownership: SpaceOwnership;
  readonly roster: SignoffRoster;
}

export async function resolveOwnership(graph: TeamGraph, space: JiraSpace): Promise<ResolvedOwnership> {
  let graphFailed = false;
  const orEmpty = <T>(result: { ok: true; value: readonly T[] } | { ok: false; error: { message: string } }, what: string): readonly T[] => {
    if (result.ok) return result.value;
    graphFailed = true;
    console.warn(`ownership of ${space.key}: ${what} failed: ${result.error.message}`);
    return [];
  };

  let source: SpaceOwnership['source'] = 'UNRESOLVED';
  let teams: readonly TeamRef[] = orEmpty(await graph.teamsForSpace(space), 'teamsForSpace');
  if (teams.length > 0) {
    source = 'SPACE_TEAM';
  } else if (space.lead !== null) {
    // Inferred, and weaker: the lead may sit in several teams, so only the first is taken.
    teams = orEmpty(await graph.teamsForUser(space.lead.accountId), 'teamsForUser').slice(0, MAX_LEAD_TEAMS);
    source = teams.length > 0 ? 'LEAD_TEAM' : 'LEAD_ONLY';
  }

  const members = new Map<AccountId, RosterMember>();
  if (space.lead !== null) members.set(space.lead.accountId, space.lead);
  for (const team of teams) {
    for (const member of orEmpty(await graph.membersOf(team.teamAri), `membersOf ${team.displayName}`)) {
      if (members.size < MAX_ROSTER_MEMBERS && !members.has(member.accountId)) members.set(member.accountId, member);
    }
  }

  const [first, ...rest] = [...members.values()];
  const roster: SignoffRoster =
    first === undefined
      ? { status: 'DEGRADED', reason: graphFailed ? 'GRAPH_ERROR' : 'EMPTY_RESULT' }
      : { status: 'VERIFIED', members: [first, ...rest] };
  return { ownership: { source, teams, lead: space.lead }, roster };
}
