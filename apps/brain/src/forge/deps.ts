/** Wires the real Forge adapters. Misconfiguration surfaces as a typed error, never a throw. */
import { fetch } from '@forge/api';
import { Queue } from '@forge/events';
import {
  GATE_ROUTES,
  CONTRACT_VERSION,
  decisionPushResponseSchema,
  err,
  errorMessage,
  ok,
  parseSigningKey,
  signedCall,
  verdictPushResponseSchema,
  type AccountId,
  type HttpPost,
  type Result,
} from '@ripple/contracts';
import type { BrainDeps, GateClient, JobQueue } from '../ports.ts';
import { ANALYSIS_QUEUE, BRAIN_ENV } from '../types.ts';
import { jiraSpaces } from './jira-spaces.ts';
import { narrativeModel } from './llm.ts';
import { riskTickets } from './risk-tickets.ts';
import { store } from './store.ts';
import { teamGraph } from './team-graph.ts';

export type ConfigError = { readonly kind: 'MISCONFIGURED'; readonly missing: string };

const post: HttpPost = (url, init) => fetch(url, init);

const queue: JobQueue = {
  async enqueue(key): Promise<Result<void, string>> {
    try {
      await new Queue({ key: ANALYSIS_QUEUE }).push({ body: { key } });
      return ok(undefined);
    } catch (cause) {
      return err(errorMessage(cause));
    }
  },
};

/** `ari:cloud:jira::site/{cloudId}` -> `{cloudId}` */
export function cloudIdFromContext(context: unknown, env: NodeJS.ProcessEnv): string | null {
  const installContext =
    typeof context === 'object' && context !== null && 'installContext' in context ? context.installContext : undefined;
  const match = typeof installContext === 'string' ? /::site\/([0-9a-f-]+)$/i.exec(installContext) : null;
  return env[BRAIN_ENV.cloudId] ?? match?.[1] ?? null;
}

/**
 * @param actAs the pull request author, impersonated for Teamwork Graph reads. Only the
 *              consumer knows it; the web trigger passes null and never touches the graph.
 */
export function loadBrainDeps(
  context: unknown,
  actAs: AccountId | null,
  env: NodeJS.ProcessEnv = process.env,
): Result<BrainDeps, ConfigError> {
  const gateApiUrl = env[BRAIN_ENV.gateApiUrl];
  if (gateApiUrl === undefined || gateApiUrl === '') return err({ kind: 'MISCONFIGURED', missing: BRAIN_ENV.gateApiUrl });
  const current = parseSigningKey(env[BRAIN_ENV.signingKey]);
  if (current === null) return err({ kind: 'MISCONFIGURED', missing: BRAIN_ENV.signingKey });
  const previous = parseSigningKey(env[BRAIN_ENV.previousSigningKey]);

  const gate: GateClient = {
    pushVerdict: (verdict) =>
      signedCall(post, gateApiUrl, GATE_ROUTES.verdict, { v: CONTRACT_VERSION, verdict }, verdictPushResponseSchema, current),
    pushDecision: (decision) =>
      signedCall(post, gateApiUrl, GATE_ROUTES.decision, { v: CONTRACT_VERSION, decision }, decisionPushResponseSchema, current),
  };

  return ok({
    store,
    queue,
    spaces: jiraSpaces,
    graph: teamGraph(actAs, cloudIdFromContext(context, env)),
    model: narrativeModel(env[BRAIN_ENV.llmModel]),
    gate,
    tickets: riskTickets(env),
    verifyKeys: previous === null ? [current] : [current, previous],
    now: () => new Date(),
  });
}
