/** Forge KVS adapter. Values are only ever written by this app, so reads are trusted. */
import { kvs } from '@forge/kvs';
import type { AnalysisKey, PrRef } from '@ripple/contracts';
import type { GateStore } from '../ports.ts';
import { GATE_STORAGE, type AuditEvent, type GateRecord, type PrPointer } from '../types.ts';

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
  async appendAudit(event: AuditEvent): Promise<void> {
    await kvs.set(GATE_STORAGE.audit(event), event);
  },
};
