import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  MAX_CLOCK_SKEW_MS,
  SIGNATURE_HEADERS,
  canonicalString,
  signRequest,
  verifyRequest,
  type SignableRequest,
  type SigningKey,
} from './signing.ts';

const key: SigningKey = { id: '2026-11', secret: 'a'.repeat(64) };
const oldKey: SigningKey = { id: '2026-10', secret: 'b'.repeat(64) };
const request: SignableRequest = { method: 'POST', path: '/v1/analyze', body: '{"v":"v1"}' };
const now = 1_795_000_000_000;
const nonce = '0123456789abcdef-nonce';

test('canonical string and signature match an independently computed vector', () => {
  const canonical = canonicalString(request, key.id, String(now), nonce);
  assert.equal(
    canonical,
    [
      'v1',
      '2026-11',
      '1795000000000',
      nonce,
      'POST',
      '/v1/analyze',
      // sha256('{"v":"v1"}')
      '7c62a019c61d861bcf6bc16c0c6638c22ae5e890517d21553dfdc0143241ebec',
    ].join('\n'),
  );
  const headers = signRequest(request, key, now, nonce);
  const expected = createHmac('sha256', key.secret).update(canonical).digest('hex');
  assert.equal(headers[SIGNATURE_HEADERS.signature], `v1=${expected}`);
});

test('a signed request verifies, including with array-valued mixed-case headers', () => {
  const headers = signRequest(request, key, now, nonce);
  assert.deepEqual(verifyRequest(request, headers, [key], now), {
    ok: true,
    keyId: key.id,
    nonce,
    timestamp: now,
  });
  const forgeStyle = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toUpperCase(), [value]]),
  );
  assert.equal(verifyRequest(request, forgeStyle, [key], now).ok, true);
});

test('tampering with body, path or method is rejected', () => {
  const headers = signRequest(request, key, now, nonce);
  for (const tampered of [
    { ...request, body: '{"v":"v2"}' },
    { ...request, path: '/v1/accept-risk' },
    { ...request, method: 'PUT' },
  ]) {
    assert.deepEqual(verifyRequest(tampered, headers, [key], now), { ok: false, reason: 'BAD_SIGNATURE' });
  }
});

test('tampering with a signed header is rejected', () => {
  const headers = signRequest(request, key, now, nonce);
  const moved = { ...headers, [SIGNATURE_HEADERS.timestamp]: String(now + 1) };
  assert.deepEqual(verifyRequest(request, moved, [key], now), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('a wrong secret is rejected', () => {
  const headers = signRequest(request, { id: key.id, secret: 'c'.repeat(64) }, now, nonce);
  assert.deepEqual(verifyRequest(request, headers, [key], now), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('requests outside the clock-skew window are rejected in both directions', () => {
  const headers = signRequest(request, key, now, nonce);
  assert.equal(verifyRequest(request, headers, [key], now + MAX_CLOCK_SKEW_MS).ok, true);
  for (const later of [now + MAX_CLOCK_SKEW_MS + 1, now - MAX_CLOCK_SKEW_MS - 1]) {
    assert.deepEqual(verifyRequest(request, headers, [key], later), { ok: false, reason: 'STALE_TIMESTAMP' });
  }
});

test('rotation: the previous key still verifies, an unlisted key does not', () => {
  const headers = signRequest(request, oldKey, now, nonce);
  assert.equal(verifyRequest(request, headers, [key, oldKey], now).ok, true);
  assert.deepEqual(verifyRequest(request, headers, [key], now), { ok: false, reason: 'UNKNOWN_KEY' });
});

test('missing, duplicated and malformed headers are rejected', () => {
  const headers = signRequest(request, key, now, nonce);
  const { [SIGNATURE_HEADERS.signature]: signature, ...withoutSignature } = headers;
  assert.deepEqual(verifyRequest(request, withoutSignature, [key], now), { ok: false, reason: 'MISSING_HEADER' });
  assert.deepEqual(
    verifyRequest(request, { ...headers, [SIGNATURE_HEADERS.signature]: [signature, signature] }, [key], now),
    { ok: false, reason: 'MISSING_HEADER' },
  );
  assert.deepEqual(
    verifyRequest(request, { ...headers, [SIGNATURE_HEADERS.signature]: 'v1=nothex' }, [key], now),
    { ok: false, reason: 'MALFORMED_HEADER' },
  );
});

test('short secrets are refused when signing and when verifying', () => {
  const weak: SigningKey = { id: 'weak', secret: 'short' };
  assert.throws(() => signRequest(request, weak, now, nonce), /at least 32/);
  assert.throws(() => verifyRequest(request, {}, [weak], now), /at least 32/);
});
