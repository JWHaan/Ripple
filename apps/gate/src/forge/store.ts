/** Forge KVS adapter. Values are only ever written by this app, so reads are trusted. */
import { kvs } from '@forge/kvs';
import { isoNow, type AnalysisKey, type PrRef } from '@ripple/contracts';
import type { GateStore } from '../ports.ts';
import {
  DISPATCH_CLAIM_TTL_SECONDS,
  GATE_STORAGE,
  type AuditEvent,
  type DispatchClaim,
  type GateRecord,
  type PrPointer,
} from '../types.ts';

export const store: GateStore = {
  async getPointer(pr: PrRef): Promise<PrPointer | null> {
    return (await kvs.get<PrPointer>(GATE_STORAGE.pointer(pr))) ?? null;
  },
  async setPointer(pointer: PrPointer): Promise<void> {
    await kvs.set(GATE_STORAGE.pointer(pointer.pr), pointer);
  },
  async getRecord(key: AnalysisKey): Promise<GateRecord | null> {
    return (await kvs.get<GateRecord>(GATE_STORAGE.record(key))) ?? null;
  },
  async putRecord(record: GateRecord): Promise<void> {
    await kvs.set(GATE_STORAGE.record(record.key), record);
  },
  async claimDispatch(key: AnalysisKey, attempt: number): Promise<boolean> {
    const claimKey = GATE_STORAGE.claim(key, attempt);
    const claim: DispatchClaim = { attempt, claimedAt: isoNow(new Date()) };
    try {
      await kvs.set(claimKey, claim, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: DISPATCH_CLAIM_TTL_SECONDS, unit: 'SECONDS' } });
      return true;
    } catch (cause) {
      // FAIL_IF_EXISTS surfaces as an API error; only treat it as "lost" if the claim is really there.
      if ((await kvs.get<DispatchClaim>(claimKey)) !== undefined) return false;
      throw cause;
    }
  },
  async appendAudit(event: AuditEvent): Promise<void> {
    await kvs.set(GATE_STORAGE.audit(event), event);
  },
};
