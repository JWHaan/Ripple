/** Bitbucket Cloud REST adapter (workspace scopes only). */
import api, { assumeTrustedRoute, route, type APIResponse } from '@forge/api';
import {
  decodeValue,
  err,
  errorMessage,
  ok,
  parseAccountId,
  parseCommitSha,
  type CommitSha,
  type PrRef,
  type Result,
} from '@ripple/contracts';
import { z } from 'zod';
import type { BitbucketError, BitbucketPort } from '../ports.ts';
import type { PullRequestSnapshot } from '../types.ts';

const pullRequestSchema = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  author: z.object({ account_id: z.string().optional(), display_name: z.string().optional() }).nullish(),
  source: z.object({ branch: z.object({ name: z.string() }), commit: z.object({ hash: z.string() }) }),
  destination: z.object({
    branch: z.object({ name: z.string() }),
    commit: z.object({ hash: z.string() }),
    repository: z.object({
      full_name: z.string(),
      links: z.object({ html: z.object({ href: z.string() }) }),
    }),
  }),
  links: z.object({ html: z.object({ href: z.string() }) }),
});

const commitSchema = z.object({ hash: z.string() });

function failure(status: number, what: string): BitbucketError {
  const kind =
    status === 404 ? 'NOT_FOUND' : status === 401 || status === 403 ? 'FORBIDDEN' : status === 429 ? 'RATE_LIMITED' : 'UPSTREAM';
  return { kind, message: `${what}: HTTP ${status}` };
}

async function call(request: () => Promise<APIResponse>, what: string): Promise<Result<APIResponse, BitbucketError>> {
  try {
    return ok(await request());
  } catch (cause) {
    return err({ kind: 'UPSTREAM', message: `${what}: ${errorMessage(cause)}` });
  }
}

/** Bitbucket accepts `{uuid}` wherever a workspace or repository slug is expected. */
const wrap = (uuid: string): string => `{${uuid}}`;

export const bitbucket: BitbucketPort = {
  async getPullRequest(pr: PrRef): Promise<Result<PullRequestSnapshot, BitbucketError>> {
    const ws = wrap(pr.workspaceUuid);
    const repo = wrap(pr.repoUuid);
    const response = await call(
      () => api.asApp().requestBitbucket(route`/2.0/repositories/${ws}/${repo}/pullrequests/${pr.prId}`),
      'read pull request',
    );
    if (!response.ok) return response;
    if (!response.value.ok) return err(failure(response.value.status, 'read pull request'));
    const body: unknown = await response.value.json();
    const decoded = decodeValue(pullRequestSchema, body);
    if (!decoded.ok) return err({ kind: 'MALFORMED', message: `pull request payload: ${decoded.error.message}` });
    const data = decoded.value;

    // Pull request payloads carry an abbreviated hash; Ripple only ever stores full SHAs.
    let headSha: CommitSha | null = parseCommitSha(data.source.commit.hash);
    if (headSha === null) {
      const commit = await call(
        () => api.asApp().requestBitbucket(route`/2.0/repositories/${ws}/${repo}/commit/${data.source.commit.hash}`),
        'resolve head commit',
      );
      if (!commit.ok) return commit;
      if (!commit.value.ok) return err(failure(commit.value.status, 'resolve head commit'));
      const commitBody: unknown = await commit.value.json();
      const resolved = decodeValue(commitSchema, commitBody);
      headSha = resolved.ok ? parseCommitSha(resolved.value.hash) : null;
      if (headSha === null) return err({ kind: 'MALFORMED', message: 'head commit did not resolve to a 40-character SHA' });
    }

    const author = data.author?.account_id;
    return ok({
      ref: pr,
      headSha,
      destinationCommit: data.destination.commit.hash,
      state: data.state,
      repo: { fullName: data.destination.repository.full_name, url: data.destination.repository.links.html.href },
      descriptor: {
        title: data.title,
        url: data.links.html.href,
        authorAccountId: author === undefined ? null : parseAccountId(author),
        sourceBranch: data.source.branch.name,
        destinationBranch: data.destination.branch.name,
      },
      authorDisplayName: data.author?.display_name ?? null,
    });
  },

  async getDiff(snapshot: PullRequestSnapshot): Promise<Result<string, BitbucketError>> {
    const ws = wrap(snapshot.ref.workspaceUuid);
    const repo = wrap(snapshot.ref.repoUuid);
    // Pinned to the head SHA (not "the PR's current diff") so the result cannot drift mid-evaluation.
    // The `..` must stay in the template literal: `route` rejects any interpolated value
    // containing `..` as a path manipulation attempt.
    const head = snapshot.headSha;
    const base = snapshot.destinationCommit;
    const response = await call(
      () => api.asApp().requestBitbucket(route`/2.0/repositories/${ws}/${repo}/diff/${head}..${base}`),
      'read diff',
    );
    if (!response.ok) return response;
    if (!response.value.ok) return err(failure(response.value.status, 'read diff'));
    return ok(await response.value.text());
  },

  async getFile(pr: PrRef, commit: string, path: string): Promise<Result<string | null, BitbucketError>> {
    const ws = wrap(pr.workspaceUuid);
    const repo = wrap(pr.repoUuid);
    const encodedPath = assumeTrustedRoute(path.split('/').map(encodeURIComponent).join('/'));
    const response = await call(
      () => api.asApp().requestBitbucket(route`/2.0/repositories/${ws}/${repo}/src/${commit}/${encodedPath}`),
      'read file',
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return ok(null);
    if (!response.value.ok) return err(failure(response.value.status, 'read file'));
    return ok(await response.value.text());
  },
};
