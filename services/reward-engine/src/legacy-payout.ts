/**
 * Legacy weekly payout — exact port of the deployed old-stack payer
 * (frypool-publisher weekly_publish.py query_weekly_rewards aggregation over
 * Mongo main.device-rewards), recomputed from the migrated
 * legacy_weekly_rewards table (fry3 PG, Prisma model LegacyWeeklyReward).
 *
 * Parity contract (money gate): 100% base-unit-exact vs the verbatim deployed
 * pipeline — proven 45/45 historical windows, 100447 wallet-rows, 0 diffs.
 * Every semantic below is deliberate and MUST NOT be "simplified":
 *  - Summation replicates mongod 8.0.18 $sum DoubleDoubleSummation
 *    (src/mongo/util/summation.h): addDouble(x): (x,_addend)=fast2Sum(x,_addend);
 *    (_sum,e)=2Sum(_sum,x); _addend+=e; getDouble() returns _sum WITHOUT the
 *    addend folded in. Naive/Kahan/Neumaier all diverge on real data.
 *  - $group evaluates BOTH per-asset $cond accumulators for EVERY row; the
 *    zero branch feeds the accumulator and folds compensation state.
 *  - Rows whose Mongo unlock_at was a STRING (not BSON date) can never match
 *    the deployed date-range $match (BSON type bracketing) — callers must only
 *    pass date-typed rows (unlockAtMs !== null).
 *  - Wallet gate = trim + Algorand base32/sha512-256 checksum validity
 *    (algosdk decode_address semantics); invalid/missing wallets accumulate
 *    into devicesWithoutWallet (carried, not paid).
 *  - Micro conversion = Math.floor(sum * 1e6) (Python math.floor semantics).
 */
import { createHash } from "node:crypto";

/** ASA ids paid by the legacy weekly pipeline (base-unit micro, 6 decimals). */
export const LEGACY_ASSET_TFRY = "2681521901";
export const LEGACY_ASSET_FNODE = "2485202024";

/** One migrated weekly_rewards entry (a row of legacy_weekly_rewards). */
export interface LegacyWeeklyRow {
  /** Natural collection order — accumulation order matters for exactness. */
  seq: number;
  /** unlock_at epoch ms; null when the source value was string-typed (excluded by the deployed payer). */
  unlockAtMs: number | null;
  /** devices.reward_wallet ?? devices.address resolved at migration time. */
  resolvedWallet: string | null;
  assetId: string | null;
  amount: number;
}

export interface WalletPayout {
  /** Micro base units (floor(sum * 1e6)). */
  tfryMicro: number;
  fnodeMicro: number;
  deviceCount: number;
}

export interface WindowPayouts {
  /** Wallet address -> exact payout for the window. Only wallets with a positive amount. */
  wallets: Map<string, WalletPayout>;
  /** Row count that fell into groups with a missing/invalid wallet (carried forward, unpaid). */
  devicesWithoutWallet: number;
}

/**
 * mongod DoubleDoubleSummation accumulator (verbatim algorithm, r8.0.18).
 * Probe-verified bit-exact against the live mongod for crafted sequences.
 */
export interface DoubleDoubleSum {
  sum: number;
  addend: number;
}

export function ddNew(): DoubleDoubleSum {
  return { sum: 0, addend: 0 };
}

export function ddAdd(acc: DoubleDoubleSum, x: number): void {
  const s1 = x + acc.addend; // _fast2Sum(x, _addend)
  const z = s1 - x;
  const t = acc.addend - z;
  const s2 = acc.sum + s1; // _2Sum(_sum, s1)
  const aP = s2 - s1;
  const bP = s2 - aP;
  const e = acc.sum - aP + (s1 - bP);
  acc.sum = s2;
  acc.addend = t + e;
}

/** getDouble(): _sum — the compensation addend is NOT added at readout. */
export function ddValue(acc: DoubleDoubleSum): number {
  return acc.sum;
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Algorand address validity — algosdk decode_address semantics (base32 + sha512-256 checksum). */
export function isValidAlgorandAddress(addr: unknown): boolean {
  if (typeof addr !== "string" || addr.length !== 58) return false;
  const decoded = base32Decode(addr);
  if (!decoded || decoded.length < 36) return false;
  const pubkey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 36);
  const digest = createHash("sha512-256").update(pubkey).digest();
  return digest.subarray(28, 32).equals(checksum);
}

/**
 * Compute one publish window's payouts. windowDate = "YYYY-MM-DD"; the deployed
 * window is that UTC calendar day, inclusive [00:00:00.000, 23:59:59.000].
 * Rows MUST be in seq (natural collection) order — accumulation order is part
 * of the parity contract. String-typed-unlock rows (unlockAtMs === null) never match.
 */
export function computeWindowPayouts(rows: readonly LegacyWeeklyRow[], windowDate: string): WindowPayouts {
  const [y, m, d] = windowDate.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const end = Date.UTC(y, m - 1, d, 23, 59, 59, 0);
  interface Group {
    tfry: DoubleDoubleSum;
    fnode: DoubleDoubleSum;
    count: number;
  }
  const groups = new Map<string | null, Group>();
  for (const r of rows) {
    if (r.unlockAtMs === null || r.unlockAtMs < start || r.unlockAtMs > end) continue;
    let g = groups.get(r.resolvedWallet);
    if (!g) {
      g = { tfry: ddNew(), fnode: ddNew(), count: 0 };
      groups.set(r.resolvedWallet, g);
    }
    // Both $cond accumulators run per row; the zero branch still folds compensation.
    ddAdd(g.tfry, r.assetId === LEGACY_ASSET_TFRY ? r.amount : 0);
    ddAdd(g.fnode, r.assetId === LEGACY_ASSET_FNODE ? r.amount : 0);
    g.count += 1;
  }
  const wallets = new Map<string, WalletPayout>();
  let devicesWithoutWallet = 0;
  for (const [key, g] of groups) {
    const w = (key ?? "").trim();
    if (!w || !isValidAlgorandAddress(w)) {
      devicesWithoutWallet += g.count;
      continue;
    }
    const tfryMicro = Math.floor(ddValue(g.tfry) * 1e6);
    const fnodeMicro = Math.floor(ddValue(g.fnode) * 1e6);
    if (tfryMicro > 0 || fnodeMicro > 0) {
      wallets.set(w, { tfryMicro, fnodeMicro, deviceCount: g.count });
    }
  }
  return { wallets, devicesWithoutWallet };
}
