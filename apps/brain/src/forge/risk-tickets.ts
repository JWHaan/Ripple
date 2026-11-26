/** Jira REST adapter for accepted-risk tickets. Scopes: read:jira-work, write:jira-work. */
import api, { route } from '@forge/api';
import { decodeValue, err, errorMessage, ok, parseJiraIssueKey, type Result, type RiskTicket } from '@ripple/contracts';
import { z } from 'zod';
import type { RiskTickets, TicketError } from '../ports.ts';
import { BRAIN_ENV, type JiraCreateIssueRequest } from '../types.ts';

const created = z.object({ key: z.string() });
const found = z.object({ issues: z.array(z.object({ key: z.string() })) });
const serverInfo = z.object({ baseUrl: z.string() });

async function jira(path: ReturnType<typeof route>, what: string, body?: object): Promise<Result<unknown, TicketError>> {
  try {
    const response = await api.asApp().requestJira(
      path,
      body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    );
    if (response.status === 401 || response.status === 403) return err({ kind: 'FORBIDDEN', message: `${what}: HTTP ${response.status}` });
    if (!response.ok) return err({ kind: 'FAILED', message: `${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}` });
    return ok((await response.json()) as unknown);
  } catch (cause) {
    return err({ kind: 'FAILED', message: `${what}: ${errorMessage(cause)}` });
  }
}

async function ticket(key: string): Promise<Result<RiskTicket, TicketError>> {
  const issueKey = parseJiraIssueKey(key);
  if (issueKey === null) return err({ kind: 'FAILED', message: `unexpected issue key ${key}` });
  const info = await jira(route`/rest/api/3/serverInfo`, 'read site url');
  if (!info.ok) return info;
  const decoded = decodeValue(serverInfo, info.value);
  if (!decoded.ok) return err({ kind: 'FAILED', message: 'site url unavailable' });
  return ok({ issueKey, issueUrl: `${decoded.value.baseUrl.replace(/\/+$/, '')}/browse/${issueKey}` });
}

export function riskTickets(env: NodeJS.ProcessEnv = process.env): RiskTickets {
  return {
    target() {
      const projectKey = env[BRAIN_ENV.jiraProjectKey];
      if (projectKey === undefined || projectKey === '') return err({ kind: 'NOT_CONFIGURED', message: `${BRAIN_ENV.jiraProjectKey} is not set` });
      return ok({ projectKey, issueType: env[BRAIN_ENV.jiraIssueType] || 'Task' });
    },
    async findByLabel(label: string): Promise<Result<RiskTicket | null, TicketError>> {
      const result = await jira(route`/rest/api/3/search/jql`, 'search risk ticket', { jql: `labels = "${label}"`, maxResults: 1, fields: ['summary'] });
      if (!result.ok) return result;
      const decoded = decodeValue(found, result.value);
      const key = decoded.ok ? decoded.value.issues[0]?.key : undefined;
      return key === undefined ? ok(null) : ticket(key);
    },
    async create(issue: JiraCreateIssueRequest): Promise<Result<RiskTicket, TicketError>> {
      const result = await jira(route`/rest/api/3/issue`, 'create risk ticket', issue);
      if (!result.ok) return result;
      const decoded = decodeValue(created, result.value);
      return decoded.ok ? ticket(decoded.value.key) : err({ kind: 'FAILED', message: 'create risk ticket: unexpected response' });
    },
  };
}
