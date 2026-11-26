import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import { FIXTURE_NAMES, fixtureText, type FixtureName } from './fixtures.ts';
import {
  analyzeRequestSchema,
  analyzeResponseSchema,
  apiErrorResponseSchema,
  decodeJson,
  verdictPushRequestSchema,
  verdictPushResponseSchema,
  verdictSchema,
} from './schemas.ts';
import { signRequest } from './signing.ts';
import { GATE_ROUTES } from './types.ts';
import { apiError, authenticate, parseSigningKey, signedCall, type HttpPost } from './webtrigger.ts';

const SCHEMAS: Record<FixtureName, z.ZodType<unknown>> = {
  'analyze-request': analyzeRequestSchema,
  'analyze-response-accepted': analyzeResponseSchema,
  'verdict-complete': verdictSchema,
  'verdict-failed': verdictSchema,
  'verdict-push-response-stored': verdictPushResponseSchema,
  'error-unauthenticated': apiErrorResponseSchema,
};

for (const name of FIXTURE_NAMES) {
  test(`fixture ${name} satisfies wire contract v1 and survives a round trip`, () => {
    const decoded = decodeJson(SCHEMAS[name], fixtureText(name));
    assert.equal(decoded.ok, true, decoded.ok ? '' : decoded.error.message);
    if (!decoded.ok) return;
    // Decoding must not drop or rewrite anything the fixture carries.
    assert.deepEqual(decoded.value, JSON.parse(fixtureText(name)));
    assert.deepEqual(decodeJson(SCHEMAS[name], JSON.stringify(decoded.value)), decoded);
  });
}

function mutated(name: FixtureName, change: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(fixtureText(name)) as Record<string, unknown>;
  change(value);
  return JSON.stringify(value);
}

test('an abbreviated commit SHA is rejected everywhere a key appears', () => {
  const short = mutated('analyze-request', (v) => {
    (v['key'] as Record<string, unknown>)['headSha'] = 'aaaaaaaaaaaa';
  });
  const decoded = decodeJson(analyzeRequestSchema, short);
  assert.equal(decoded.ok, false);
  assert.match(decoded.ok ? '' : decoded.error.message, /key\.headSha.*40-character/);
});

test('unknown contract versions, unknown enum members and non-JSON are rejected', () => {
  assert.equal(decodeJson(analyzeRequestSchema, mutated('analyze-request', (v) => (v['v'] = 'v2'))).ok, false);
  assert.equal(decodeJson(verdictSchema, mutated('verdict-failed', (v) => (v['status'] = 'PASSED'))).ok, false);
  assert.deepEqual(decodeJson(verdictSchema, '{nope'), { ok: false, error: { kind: 'INVALID_JSON', message: 'body is not valid JSON' } });
});

test('a VERIFIED roster must have at least one member', () => {
  const empty = mutated('verdict-complete', (v) => {
    const requirement = (v['signoffRequirements'] as Record<string, unknown>[])[0];
    assert.ok(requirement);
    requirement['roster'] = { status: 'VERIFIED', members: [] };
  });
  assert.equal(decodeJson(verdictSchema, empty).ok, false);
});

const key = { id: 'test', secret: 's'.repeat(64) };
const now = 1_795_000_000_000;

test('authenticate accepts a correctly signed POST and normalises the path', () => {
  const body = fixtureText('verdict-failed');
  const headers = signRequest({ method: 'POST', path: GATE_ROUTES.verdict, body }, key, now);
  const result = authenticate({ method: 'POST', userPath: `${GATE_ROUTES.verdict}/`, headers, body }, [key], now);
  assert.deepEqual(result, { ok: true, value: { path: GATE_ROUTES.verdict, body } });
});

test('authenticate rejects unsigned, tampered and non-POST requests with contract errors', () => {
  const body = fixtureText('verdict-failed');
  const headers = signRequest({ method: 'POST', path: GATE_ROUTES.verdict, body }, key, now);
  const unsigned = authenticate({ method: 'POST', userPath: GATE_ROUTES.verdict, body }, [key], now);
  const tampered = authenticate({ method: 'POST', userPath: GATE_ROUTES.verdict, headers, body: `${body} ` }, [key], now);
  const get = authenticate({ method: 'GET', userPath: GATE_ROUTES.verdict, headers, body }, [key], now);
  assert.deepEqual(unsigned, { ok: false, error: apiError('UNAUTHENTICATED', 'request signature rejected') });
  assert.deepEqual(tampered, unsigned);
  assert.equal(get.ok ? 0 : get.error.statusCode, 405);
  // The unauthenticated response is itself a valid contract payload.
  assert.equal(unsigned.ok ? '' : unsigned.error.body, JSON.stringify(JSON.parse(fixtureText('error-unauthenticated'))));
});

test('signedCall signs what it sends and maps every response class to a typed result', async () => {
  const payload = { v: 'v1', verdict: JSON.parse(fixtureText('verdict-failed')) as object };
  let seen: Parameters<HttpPost> | null = null;
  const respond = (status: number, text: string): HttpPost => async (url, init) => {
    seen = [url, init];
    return { status, text: async () => text };
  };

  const stored = await signedCall(respond(200, fixtureText('verdict-push-response-stored')), 'https://gate.example/x/', GATE_ROUTES.verdict, payload, verdictPushResponseSchema, key, now);
  assert.equal(stored.ok && stored.value.outcome, 'STORED');
  assert.ok(seen);
  const [url, init] = seen as Parameters<HttpPost>;
  assert.equal(url, 'https://gate.example/x/v1/verdict');
  assert.equal(authenticate({ method: 'POST', userPath: GATE_ROUTES.verdict, headers: init.headers, body: init.body }, [key], now).ok, true);
  assert.equal(decodeJson(verdictPushRequestSchema, init.body).ok, true);

  const rejected = await signedCall(respond(401, fixtureText('error-unauthenticated')), 'https://gate.example', GATE_ROUTES.verdict, payload, verdictPushResponseSchema, key, now);
  assert.deepEqual(rejected, { ok: false, error: { kind: 'REJECTED', status: 401, code: 'UNAUTHENTICATED', message: 'request signature rejected' } });

  const garbage = await signedCall(respond(200, '<html>'), 'https://gate.example', GATE_ROUTES.verdict, payload, verdictPushResponseSchema, key, now);
  assert.equal(garbage.ok ? '' : garbage.error.kind, 'MALFORMED_RESPONSE');

  const down: HttpPost = async () => {
    throw new Error('ECONNRESET');
  };
  const unreachable = await signedCall(down, 'https://gate.example', GATE_ROUTES.verdict, payload, verdictPushResponseSchema, key, now);
  assert.deepEqual(unreachable, { ok: false, error: { kind: 'UNREACHABLE', message: 'ECONNRESET' } });
});

test('space keys are validated wherever they appear', () => {
  const lower = mutated('analyze-request', (v) => {
    (v['service'] as Record<string, unknown>)['downstream'] = ['mplat'];
  });
  assert.equal(decodeJson(analyzeRequestSchema, lower).ok, false);
});

test('parseSigningKey reads `id:secret` and rejects everything else', () => {
  assert.deepEqual(parseSigningKey('2026-11:abc:def'), { id: '2026-11', secret: 'abc:def' });
  for (const bad of [undefined, '', 'nosecret', ':secret', 'id:']) assert.equal(parseSigningKey(bad), null);
});
