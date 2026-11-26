/** Loads the canonical wire-contract fixtures in /fixtures. Test-only; never bundled. */
import { readFileSync } from 'node:fs';

export type FixtureName =
  | 'analyze-request'
  | 'analyze-response-accepted'
  | 'verdict-complete'
  | 'verdict-failed'
  | 'verdict-push-response-stored'
  | 'error-unauthenticated';

export const FIXTURE_NAMES: readonly FixtureName[] = [
  'analyze-request',
  'analyze-response-accepted',
  'verdict-complete',
  'verdict-failed',
  'verdict-push-response-stored',
  'error-unauthenticated',
];

/** Raw JSON text exactly as it would travel on the wire. */
export function fixtureText(name: FixtureName): string {
  return readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
}
