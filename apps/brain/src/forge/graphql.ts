/** Shared plumbing for the two GraphQL-backed adapters. */
import type { APIResponse } from '@forge/api';
import { decodeValue, err, errorMessage, ok, type Result } from '@ripple/contracts';
import { z } from 'zod';
export interface GraphTransportError {
  readonly kind: 'FORBIDDEN' | 'NOT_INSTALLED' | 'UNAVAILABLE' | 'MALFORMED';
  readonly message: string;
}

const envelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

export interface GraphPayload {
  readonly data: unknown;
  readonly errors: readonly string[];
}

function classify(status: number, message: string): GraphTransportError {
  if (/not installed/i.test(message)) return { kind: 'NOT_INSTALLED', message };
  if (status === 401 || status === 403 || /scope|forbidden|unauthori[sz]ed|permission/i.test(message)) {
    return { kind: 'FORBIDDEN', message };
  }
  return { kind: 'UNAVAILABLE', message };
}

/** Runs a GraphQL request and separates transport / authorisation failures from data. */
export async function graphRequest(send: () => Promise<APIResponse>, what: string): Promise<Result<GraphPayload, GraphTransportError>> {
  let response: APIResponse;
  try {
    response = await send();
  } catch (cause) {
    return err(classify(0, `${what}: ${errorMessage(cause)}`));
  }
  if (!response.ok) return err(classify(response.status, `${what}: HTTP ${response.status}`));

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err({ kind: 'MALFORMED', message: `${what}: response was not JSON` });
  }
  const decoded = decodeValue(envelope, body);
  if (!decoded.ok) return err({ kind: 'MALFORMED', message: `${what}: ${decoded.error.message}` });

  const errors = (decoded.value.errors ?? []).map((error) => error.message ?? 'unknown GraphQL error');
  // Partial data with errors is still usable (e.g. a nullable sub-field was refused).
  if (decoded.value.data === undefined || decoded.value.data === null) {
    return err(classify(response.status, `${what}: ${errors.join('; ') || 'no data returned'}`));
  }
  return ok({ data: decoded.value.data, errors });
}
