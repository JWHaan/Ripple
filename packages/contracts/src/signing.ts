/**
 * HMAC-SHA256 request signing for the Gate <-> Brain webtrigger contract.
 *
 * Forge web trigger URLs are public and unauthenticated, so every request carries:
 *
 *   x-ripple-key-id      id of the shared secret used (enables rotation)
 *   x-ripple-timestamp   unix epoch milliseconds
 *   x-ripple-nonce       random per-request value
 *   x-ripple-signature   `v1=` + hex(HMAC-SHA256(secret, canonical))
 *
 * canonical = "v1\n{keyId}\n{timestamp}\n{nonce}\n{METHOD}\n{path}\n{sha256hex(body)}"
 *
 * The receiver MUST verify against the raw body string before parsing it.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_SCHEME = 'v1' as const;

export const SIGNATURE_HEADERS = {
  keyId: 'x-ripple-key-id',
  timestamp: 'x-ripple-timestamp',
  nonce: 'x-ripple-nonce',
  signature: 'x-ripple-signature',
} as const;

/** Requests older or newer than this relative to the receiver's clock are rejected. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Shared secrets shorter than this are refused outright (256 bits as hex = 64 chars). */
export const MIN_SECRET_LENGTH = 32;

export interface SigningKey {
  /** Short, non-secret label, e.g. `2026-11`. */
  readonly id: string;
  readonly secret: string;
}

export interface SignableRequest {
  readonly method: string;
  /** Route path exactly as the receiver sees it in `userPath`, e.g. `/v1/analyze`. */
  readonly path: string;
  /** Exact bytes sent on the wire. */
  readonly body: string;
}

export type SignatureHeaders = Readonly<
  Record<(typeof SIGNATURE_HEADERS)[keyof typeof SIGNATURE_HEADERS], string>
>;

export type IncomingHeaders = Readonly<Record<string, readonly string[] | string | undefined>>;

export type VerificationFailure =
  | 'MISSING_HEADER'
  | 'MALFORMED_HEADER'
  | 'UNKNOWN_KEY'
  | 'STALE_TIMESTAMP'
  | 'BAD_SIGNATURE';

export type VerificationResult =
  | { readonly ok: true; readonly keyId: string; readonly nonce: string; readonly timestamp: number }
  | { readonly ok: false; readonly reason: VerificationFailure };

const KEY_ID = /^[A-Za-z0-9._-]{1,32}$/;
const TIMESTAMP = /^\d{13}$/;
const NONCE = /^[A-Za-z0-9-]{16,64}$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;

function assertUsableKey(key: SigningKey): void {
  if (!KEY_ID.test(key.id)) throw new Error('Ripple signing key id is malformed');
  if (key.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Ripple signing secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

export function canonicalString(
  request: SignableRequest,
  keyId: string,
  timestamp: string,
  nonce: string,
): string {
  const bodyHash = createHash('sha256').update(request.body, 'utf8').digest('hex');
  return [
    SIGNATURE_SCHEME,
    keyId,
    timestamp,
    nonce,
    request.method.toUpperCase(),
    request.path,
    bodyHash,
  ].join('\n');
}

function mac(secret: string, canonical: string): Buffer {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest();
}

export function signRequest(
  request: SignableRequest,
  key: SigningKey,
  now: number = Date.now(),
  nonce: string = randomUUID(),
): SignatureHeaders {
  assertUsableKey(key);
  const timestamp = String(now);
  const digest = mac(key.secret, canonicalString(request, key.id, timestamp, nonce));
  return {
    [SIGNATURE_HEADERS.keyId]: key.id,
    [SIGNATURE_HEADERS.timestamp]: timestamp,
    [SIGNATURE_HEADERS.nonce]: nonce,
    [SIGNATURE_HEADERS.signature]: `${SIGNATURE_SCHEME}=${digest.toString('hex')}`,
  };
}

function header(headers: IncomingHeaders, name: string): string | null {
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== name) continue;
    const values = typeof value === 'string' ? [value] : (value ?? []);
    // A duplicated security header is ambiguous; treat it as absent.
    return values.length === 1 ? (values[0] ?? null) : null;
  }
  return null;
}

/**
 * @param keys every currently accepted key (current first, then the previous one during rotation)
 */
export function verifyRequest(
  request: SignableRequest,
  headers: IncomingHeaders,
  keys: readonly SigningKey[],
  now: number = Date.now(),
): VerificationResult {
  keys.forEach(assertUsableKey);

  const keyId = header(headers, SIGNATURE_HEADERS.keyId);
  const timestamp = header(headers, SIGNATURE_HEADERS.timestamp);
  const nonce = header(headers, SIGNATURE_HEADERS.nonce);
  const signature = header(headers, SIGNATURE_HEADERS.signature);
  if (keyId === null || timestamp === null || nonce === null || signature === null) {
    return { ok: false, reason: 'MISSING_HEADER' };
  }

  const provided = SIGNATURE.exec(signature)?.[1];
  if (!KEY_ID.test(keyId) || !TIMESTAMP.test(timestamp) || !NONCE.test(nonce) || provided === undefined) {
    return { ok: false, reason: 'MALFORMED_HEADER' };
  }

  const key = keys.find((candidate) => candidate.id === keyId);
  if (key === undefined) return { ok: false, reason: 'UNKNOWN_KEY' };

  const expected = mac(key.secret, canonicalString(request, keyId, timestamp, nonce));
  if (!timingSafeEqual(expected, Buffer.from(provided, 'hex'))) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  // Checked after the MAC so an unauthenticated caller learns nothing about our clock.
  const sentAt = Number(timestamp);
  if (Math.abs(now - sentAt) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'STALE_TIMESTAMP' };

  return { ok: true, keyId, nonce, timestamp: sentAt };
}
