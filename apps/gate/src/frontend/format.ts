import type { Severity } from '@ripple/contracts';
import type { GateState } from '../types.ts';

export type Tone = 'neutral' | 'info' | 'warn' | 'danger' | 'ok' | 'accent';

export const STATE_LABEL: Record<GateState, { readonly label: string; readonly tone: Tone }> = {
  NO_SENSITIVE_SURFACE: { label: 'Not applicable', tone: 'neutral' },
  NOT_IN_CATALOG: { label: 'Not in catalog', tone: 'warn' },
  ANALYSIS_PENDING: { label: 'Analyzing', tone: 'info' },
  ANALYSIS_FAILED: { label: 'Analysis failed', tone: 'danger' },
  SIGNOFF_REQUIRED: { label: 'Sign-off required', tone: 'warn' },
  CLEARED: { label: 'Cleared', tone: 'ok' },
  RISK_ACCEPTED: { label: 'Risk accepted', tone: 'accent' },
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warn',
  CRITICAL: 'danger',
};

export const shortSha = (sha: string): string => sha.slice(0, 12);

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** YYYY-MM-DD, `days` from today in the viewer's time zone. */
export function isoDateFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
