/**
 * R14.5.4 — append-only send-ledger (arm-sends-<epoch>.jsonl).
 *
 * Written atomically BEFORE each submit; txid backfilled on confirm (as a second
 * append — the file is append-only, never rewritten). State is reconstructed by FOLDING
 * the records: the latest phase per intent-id wins. This module is PURE over an injected
 * LedgerStore so the crash/resume logic is fully unit-testable with no filesystem.
 */
import type { FoldedIntent, LedgerRecord } from "./types.js";

/** Append-only persistence boundary. The real adapter appends to the jsonl on ARES00. */
export interface LedgerStore {
  /** append one record atomically (fsync/flush) BEFORE the caller submits. */
  append(rec: LedgerRecord): Promise<void>;
  /** read every record in append order. */
  readAll(): Promise<LedgerRecord[]>;
}

/** Serialize one record to a jsonl line (deterministic key order). */
export function serializeRecord(rec: LedgerRecord): string {
  const ordered = {
    intentId: rec.intentId,
    deviceId: rec.deviceId,
    address: rec.address,
    asaId: rec.asaId,
    amountBase: rec.amountBase,
    armEpoch: rec.armEpoch,
    ...(rec.batchId !== undefined ? { batchId: rec.batchId } : {}),
    ...(rec.intentDomain !== undefined ? { intentDomain: rec.intentDomain } : {}),
    phase: rec.phase,
    ...(rec.txid !== undefined ? { txid: rec.txid } : {}),
    ts: rec.ts,
  };
  return JSON.stringify(ordered);
}

export function parseLine(line: string): LedgerRecord {
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("ledger record is not valid JSON");
  }
  const requiredStrings = ["intentId", "deviceId", "address", "amountBase", "ts"];
  for (const field of requiredStrings) {
    if (typeof value?.[field] !== "string" || value[field].length === 0)
      throw new Error(`ledger record has invalid ${field}`);
  }
  if (!/^[0-9]+$/.test(value.amountBase) || BigInt(value.amountBase) <= 0n)
    throw new Error("ledger record has invalid amountBase");
  if (!Number.isSafeInteger(value.asaId) || value.asaId <= 0)
    throw new Error("ledger record has invalid asaId");
  if (!Number.isSafeInteger(value.armEpoch) || value.armEpoch < 0)
    throw new Error("ledger record has invalid armEpoch");
  if (value.phase !== "intent" && value.phase !== "confirm")
    throw new Error("ledger record has invalid phase");
  if (
    value.phase === "confirm" &&
    (typeof value.txid !== "string" || value.txid.length === 0)
  )
    throw new Error("ledger confirmation has invalid txid");
  if (!Number.isFinite(Date.parse(value.ts)))
    throw new Error("ledger record has invalid timestamp");
  if (value.intentDomain !== undefined && value.intentDomain !== "arm" && value.intentDomain !== "settlement")
    throw new Error("ledger record has invalid intentDomain");
  if (value.intentDomain === "settlement") {
    if (typeof value.batchId !== "string" || value.batchId.length === 0 || value.armEpoch !== 0)
      throw new Error("ledger settlement record has invalid scope");
  } else if (value.batchId !== undefined) {
    throw new Error("ledger non-settlement record must not have batchId");
  }
  return {
    intentId: value.intentId,
    deviceId: value.deviceId,
    address: value.address,
    asaId: value.asaId,
    amountBase: value.amountBase,
    armEpoch: value.armEpoch,
    ...(value.batchId !== undefined ? { batchId: value.batchId } : {}),
    ...(value.intentDomain !== undefined ? { intentDomain: value.intentDomain } : {}),
    phase: value.phase,
    ...(value.txid !== undefined ? { txid: value.txid } : {}),
    ts: value.ts,
  };
}

/**
 * Fold the append-only ledger into per-intent state.
 * - any record → intentWritten=true
 * - a "confirm" record with a txid → txid set (last confirm wins)
 */
export function foldLedger(records: LedgerRecord[]): Map<string, FoldedIntent> {
  const m = new Map<string, FoldedIntent>();
  for (const r of records) {
    const cur = m.get(r.intentId) ?? { intentWritten: false, txid: null };
    cur.intentWritten = true;
    if (r.phase === "confirm" && r.txid) cur.txid = r.txid;
    m.set(r.intentId, cur);
  }
  return m;
}

/** Convenience: read + fold. */
export async function loadFold(store: LedgerStore): Promise<Map<string, FoldedIntent>> {
  return foldLedger(await store.readAll());
}
