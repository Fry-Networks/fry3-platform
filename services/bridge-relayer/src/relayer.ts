/**
 * Fry bridge relayer — around IMMUTABLE smart contracts (never modified).
 * QA: mock/dry-run/testnet only. Mainnet relay gated OFF by default.
 * Idempotent, replay-protected, reconciled. Integer base-units.
 */

export enum BridgeStatus {
  OBSERVED = "OBSERVED",
  RELAYED = "RELAYED",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
}

export type RelayMode = "mock" | "dry-run" | "testnet" | "mainnet";

export interface BridgeEvent {
  id: string;
  sourceTxId: string;
  destTxId?: string;
  amountBase: string; // integer base-units
  assetRef: string;
  status: BridgeStatus;
}

const LEGAL: Record<BridgeStatus, BridgeStatus[]> = {
  [BridgeStatus.OBSERVED]: [BridgeStatus.RELAYED, BridgeStatus.FAILED],
  [BridgeStatus.RELAYED]: [BridgeStatus.CONFIRMED, BridgeStatus.FAILED],
  [BridgeStatus.CONFIRMED]: [],
  [BridgeStatus.FAILED]: [BridgeStatus.OBSERVED], // safe retry re-observes
};

export function canTransition(from: BridgeStatus, to: BridgeStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

/** Mainnet relay gate — OFF unless explicitly enabled. Default SAFE. */
export function relayAllowed(mode: RelayMode, mainnetEnabled = false): boolean {
  if (mode === "mainnet") return mainnetEnabled === true;
  return true; // mock/dry-run/testnet always allowed (no real assets)
}

/** Replay protection: a sourceTxId may be processed exactly once. */
export function isReplay(sourceTxId: string, processedSourceTxIds: ReadonlySet<string>): boolean {
  return processedSourceTxIds.has(sourceTxId);
}

/** Dedupe events by sourceTxId (keep first). */
export function dedupeBySourceTx(events: BridgeEvent[]): BridgeEvent[] {
  const seen = new Set<string>();
  const out: BridgeEvent[] = [];
  for (const e of events) {
    if (seen.has(e.sourceTxId)) continue;
    seen.add(e.sourceTxId);
    out.push(e);
  }
  return out;
}

/** Reconcile observed source events vs relayed events. */
export function reconcileEvents(
  observed: BridgeEvent[],
  relayed: BridgeEvent[]
): { missing: string[]; duplicated: string[] } {
  const relayedCount = new Map<string, number>();
  for (const r of relayed) relayedCount.set(r.sourceTxId, (relayedCount.get(r.sourceTxId) ?? 0) + 1);
  const missing = observed.filter((o) => !relayedCount.has(o.sourceTxId)).map((o) => o.sourceTxId);
  const duplicated = Array.from(relayedCount.entries()).filter(([, n]) => n > 1).map(([id]) => id);
  return { missing, duplicated };
}

/** Validate an amount string is a non-negative integer base-unit. */
export function validAmount(amountBase: string): boolean {
  return /^[0-9]+$/.test(amountBase);
}
