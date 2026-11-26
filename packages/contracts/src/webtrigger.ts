/**
 * Transport helpers shared by both web trigger routers and both HTTP clients, so the
 * signing rules live in exactly one place.
 */
import type { z } from 'zod';
import { err, errorMessage, ok, type Result } from './result.ts';
import { apiErrorResponseSchema, decodeJson } from './schemas.ts';
import { signRequest, verifyRequest, type SigningKey } from './signing.ts';
import {
  API_ERROR_STATUS,
  CONTRACT_VERSION,
  type ApiErrorCode,
  type ApiErrorResponse,
  type WebTriggerRequestShape,
  type WebTriggerResponseShape,
} from './types.ts';

/** Parses the `{keyId}:{secret}` form used by the RIPPLE_SIGNING_KEY variables. */
export function parseSigningKey(raw: string | undefined): SigningKey | null {
  if (raw === undefined) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { id: raw.slice(0, separator), secret: raw.slice(separator + 1) };
}

export function jsonResponse(statusCode: number, body: object): WebTriggerResponseShape {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body),
  };
}

export function apiError(code: ApiErrorCode, message: string): WebTriggerResponseShape {
  const body: ApiErrorResponse = { v: CONTRACT_VERSION, error: { code, message } };
  return jsonResponse(API_ERROR_STATUS[code], body);
}

export interface AuthenticatedRequest {
  readonly path: string;
  readonly body: string;
}

function normalisePath(userPath: string): string {
  const path = userPath.split('?')[0] ?? '';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Method check + HMAC verification over the raw body. On failure the error is the exact
 * response to return; it never reveals which part of the check failed.
 */
export function authenticate(
  request: WebTriggerRequestShape,
  keys: readonly SigningKey[],
  now: number = Date.now(),
): Result<AuthenticatedRequest, WebTriggerResponseShape> {
  if (request.method.toUpperCase() !== 'POST') {
    return err(apiError('METHOD_NOT_ALLOWED', 'only POST is supported'));
  }
  const path = normalisePath(request.userPath);
  const body = request.body ?? '';
  const verified = verifyRequest({ method: 'POST', path, body }, request.headers ?? {}, keys, now);
  if (!verified.ok) return err(apiError('UNAUTHENTICATED', 'request signature rejected'));
  return ok({ path, body });
}

/** Minimal fetch surface; satisfied by `fetch` from @forge/api and by test fakes. */
export type HttpPost = (
  url: string,
  init: { readonly method: 'POST'; readonly headers: Record<string, string>; readonly body: string },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export type CallError =
  | { readonly kind: 'UNREACHABLE'; readonly message: string }
  | { readonly kind: 'REJECTED'; readonly status: number; readonly code: ApiErrorCode | null; readonly message: string }
  | { readonly kind: 'MALFORMED_RESPONSE'; readonly status: number; readonly message: string };

/** Signs and sends one contract call, then decodes the response against its schema. */
export async function signedCall<Res>(
  post: HttpPost,
  baseUrl: string,
  path: string,
  payload: object,
  responseSchema: z.ZodType<Res>,
  key: SigningKey,
  now: number = Date.now(),
): Promise<Result<Res, CallError>> {
  const body = JSON.stringify(payload);
  let status: number;
  let responseText: string;
  try {
    const response = await post(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signRequest({ method: 'POST', path, body }, key, now) },
      body,
    });
    status = response.status;
    responseText = await response.text();
  } catch (cause) {
    return err({ kind: 'UNREACHABLE', message: errorMessage(cause) });
  }

  if (status < 200 || status >= 300) {
    const failure = decodeJson(apiErrorResponseSchema, responseText);
    return err({
      kind: 'REJECTED',
      status,
      code: failure.ok ? failure.value.error.code : null,
      message: failure.ok ? failure.value.error.message : `HTTP ${status}`,
    });
  }
  const decoded = decodeJson(responseSchema, responseText);
  if (!decoded.ok) return err({ kind: 'MALFORMED_RESPONSE', status, message: decoded.error.message });
  return ok(decoded.value);
}
