/**
 * Service declaration: `ripple.yml` at the repository root.
 *
 *   service:
 *     id: auth-service
 *     jiraSpaceKey: PLAT
 *   downstream: [MPLAT, MOB, SECOPS]
 *
 * Read from the pull request's DESTINATION branch first, so a pull request cannot shrink
 * its own blast radius by editing the file. The PR head is used only when the destination
 * branch has no declaration yet (the PR that introduces Ripple to a repository).
 */
import {
  MAX_DOWNSTREAM_SPACES,
  RIPPLE_CONFIG_PATHS,
  err,
  ok,
  parseSpaceKey,
  type Result,
  type ServiceDeclaration,
  type SpaceKey,
} from '@ripple/contracts';
import { parse } from 'yaml';
import { z } from 'zod';
import type { BitbucketError, BitbucketPort } from './ports.ts';
import type { PullRequestSnapshot } from './types.ts';

const MAX_CONFIG_CHARS = 20_000;

const fileSchema = z.object({
  service: z.object({ id: z.string().min(1).max(100), jiraSpaceKey: z.string() }),
  downstream: z.array(z.string()).max(MAX_DOWNSTREAM_SPACES).default([]),
});

export type ParsedDeclaration = Pick<ServiceDeclaration, 'id' | 'spaceKey' | 'downstream'>;

export function parseRippleYml(content: string): Result<ParsedDeclaration, string> {
  if (content.length > MAX_CONFIG_CHARS) return err('ripple.yml is too large');
  let raw: unknown;
  try {
    raw = parse(content);
  } catch {
    return err('ripple.yml is not valid YAML');
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(`ripple.yml: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim());
  }
  const spaceKey = parseSpaceKey(parsed.data.service.jiraSpaceKey);
  if (spaceKey === null) return err(`ripple.yml: service.jiraSpaceKey "${parsed.data.service.jiraSpaceKey}" is not a Jira space key`);

  const downstream: SpaceKey[] = [];
  for (const entry of parsed.data.downstream) {
    const key = parseSpaceKey(entry);
    if (key === null) return err(`ripple.yml: downstream entry "${entry}" is not a Jira space key`);
    // A service is not downstream of itself, and duplicates add nothing.
    if (key !== spaceKey && !downstream.includes(key)) downstream.push(key);
  }
  return ok({ id: parsed.data.service.id, spaceKey, downstream });
}

export type DeclarationError =
  | { readonly kind: 'BITBUCKET'; readonly error: BitbucketError }
  /** A declaration exists but is unusable. Fails closed: never treated as "no declaration". */
  | { readonly kind: 'INVALID'; readonly message: string };

/** `null` = the repository declares no service at either commit. */
export async function resolveServiceDeclaration(
  bitbucket: BitbucketPort,
  snapshot: PullRequestSnapshot,
): Promise<Result<ServiceDeclaration | null, DeclarationError>> {
  const commits = [
    { commit: snapshot.destinationCommit, configSource: 'DESTINATION_BRANCH' as const },
    { commit: snapshot.headSha, configSource: 'PR_HEAD' as const },
  ];
  for (const { commit, configSource } of commits) {
    for (const configPath of RIPPLE_CONFIG_PATHS) {
      const file = await bitbucket.getFile(snapshot.ref, commit, configPath);
      if (!file.ok) return err({ kind: 'BITBUCKET', error: file.error });
      if (file.value === null) continue;
      const parsed = parseRippleYml(file.value);
      if (!parsed.ok) return err({ kind: 'INVALID', message: `${parsed.error} (${configSource.toLowerCase()})` });
      return ok({ ...parsed.value, configPath, configSource });
    }
  }
  return ok(null);
}
