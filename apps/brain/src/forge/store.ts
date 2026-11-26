/** Forge KVS adapter. Values are only ever written by this app, so reads are trusted. */
import { kvs } from '@forge/kvs';
import type { AnalysisKey } from '@ripple/contracts';
import type { BrainStore } from '../ports.ts';
import { BRAIN_STORAGE, type AnalysisRecord, type RiskExceptionRecord } from '../types.ts';

export const store: BrainStore = {
  async getAnalysis(key: AnalysisKey): Promise<AnalysisRecord | null> {
    return (await kvs.get<AnalysisRecord>(BRAIN_STORAGE.analysis(key))) ?? null;
  },
  async putAnalysis(record: AnalysisRecord): Promise<void> {
    await kvs.set(BRAIN_STORAGE.analysis(record.key), record);
  },
  async getException(key: AnalysisKey): Promise<RiskExceptionRecord | null> {
    return (await kvs.get<RiskExceptionRecord>(BRAIN_STORAGE.exception(key))) ?? null;
  },
  async putException(record: RiskExceptionRecord): Promise<void> {
    await kvs.set(BRAIN_STORAGE.exception(record.key), record);
  },
};
