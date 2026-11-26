/** Wires the real Forge adapters. Misconfiguration surfaces as a typed error, never a throw. */
import { randomUUID } from 'node:crypto';
import { fetch } from '@forge/api';
import {
  BRAIN_ROUTES,
  acceptRiskResponseSchema,
  analyzeResponseSchema,
  signoffResponseSchema,
  err,
  ok,
  parseSigningKey,
  signedCall,
  type HttpPost,
  type Result,
} from '@ripple/contracts';
import type { BrainClient, GateDeps } from '../ports.ts';
import { GATE_ENV } from '../types.ts';
import { bitbucket } from './bitbucket.ts';
import { store } from './store.ts';

export type ConfigError = { readonly kind: 'MISCONFIGURED'; readonly missing: string };

const post: HttpPost = (url, init) => fetch(url, init);

export function loadGateDeps(env: NodeJS.ProcessEnv = process.env): Result<GateDeps, ConfigError> {
  const brainApiUrl = env[GATE_ENV.brainApiUrl];
  if (brainApiUrl === undefined || brainApiUrl === '') return err({ kind: 'MISCONFIGURED', missing: GATE_ENV.brainApiUrl });
  const current = parseSigningKey(env[GATE_ENV.signingKey]);
  if (current === null) return err({ kind: 'MISCONFIGURED', missing: GATE_ENV.signingKey });
  const previous = parseSigningKey(env[GATE_ENV.previousSigningKey]);

  const brain: BrainClient = {
    analyze: (request) => signedCall(post, brainApiUrl, BRAIN_ROUTES.analyze, request, analyzeResponseSchema, current),
    signoff: (request) => signedCall(post, brainApiUrl, BRAIN_ROUTES.signoff, request, signoffResponseSchema, current),
    acceptRisk: (request) => signedCall(post, brainApiUrl, BRAIN_ROUTES.acceptRisk, request, acceptRiskResponseSchema, current),
  };
  return ok({
    store,
    bitbucket,
    brain,
    verifyKeys: previous === null ? [current] : [current, previous],
    now: () => new Date(),
    newId: randomUUID,
  });
}
