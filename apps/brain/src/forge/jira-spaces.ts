/** Jira REST adapter: resolves a space key to its id, name and lead. Scope: read:jira-work. */
import api, { route } from '@forge/api';
import { decodeValue, err, errorMessage, ok, parseAccountId, type Result, type SpaceKey } from '@ripple/contracts';
import { z } from 'zod';
import type { DirectoryError, JiraSpace, SpaceDirectory } from '../ports.ts';

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  lead: z.object({ accountId: z.string(), displayName: z.string().nullish() }).nullish(),
});

export const jiraSpaces: SpaceDirectory = {
  async getSpace(key: SpaceKey): Promise<Result<JiraSpace | null, DirectoryError>> {
    let status: number;
    let body: unknown;
    try {
      const response = await api.asApp().requestJira(route`/rest/api/3/project/${key}`);
      status = response.status;
      if (status === 404) return ok(null);
      if (status === 401 || status === 403) return err({ kind: 'FORBIDDEN', message: `read space ${key}: HTTP ${status}` });
      if (!response.ok) return err({ kind: 'UNAVAILABLE', message: `read space ${key}: HTTP ${status}` });
      body = await response.json();
    } catch (cause) {
      return err({ kind: 'UNAVAILABLE', message: `read space ${key}: ${errorMessage(cause)}` });
    }
    const decoded = decodeValue(projectSchema, body);
    if (!decoded.ok) return err({ kind: 'MALFORMED', message: `space ${key} payload: ${decoded.error.message}` });
    const accountId = decoded.value.lead ? parseAccountId(decoded.value.lead.accountId) : null;
    return ok({
      key,
      id: decoded.value.id,
      name: decoded.value.name,
      lead: accountId === null ? null : { accountId, displayName: decoded.value.lead?.displayName ?? 'Project lead' },
    });
  },
};
