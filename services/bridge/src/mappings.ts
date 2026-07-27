/**
 * Tooth B (R3) — PG⇄Mongo field-ownership model.
 *
 * Post-flip the new stack writes fry3 PG only; frozen human surfaces keep
 * reading/writing live Mongo. This module encodes the ONE-owner-per-field
 * contract (contracts/toothB-bridge-design.md): every logical field is synced
 * in exactly ONE direction so there is no write loop. `assertNoWriteLoop`
 * proves that invariant at load time — a mapping table that violates it throws
 * (a design bug, not a runtime condition).
 */

export type Store = "PG" | "MONGO";
export type SyncDirection = "PG_TO_MONGO" | "MONGO_TO_PG";

export interface FieldMapping {
  /** stable id used as the drift-monitor mapping key */
  key: string;
  direction: SyncDirection;
  /** owner === source store of the direction (the authority for these fields) */
  owner: Store;
  /** human-readable source locator, e.g. "Device.lastHeartbeatAt" */
  source: string;
  /** human-readable target locator, e.g. "main.devices.last_heartbeat" */
  target: string;
  /** join key used for upserts + checksum sampling */
  keyBy: string;
  /** logical field names owned by this mapping (globally unique across the table) */
  fields: string[];
  description: string;
}

/** PG owns → bridge syncs PG → Mongo (frozen-read freshness). */
const PG_OWNED: FieldMapping[] = [
  {
    key: "device_liveness",
    direction: "PG_TO_MONGO",
    owner: "PG",
    source: "Device(liveness)",
    target: "main.devices",
    keyBy: "miner_key",
    fields: ["last_heartbeat_at", "online_status"],
    description: "Device liveness — last-heartbeat ts + online status, keyed miner_key.",
  },
  {
    key: "fem_installs",
    direction: "PG_TO_MONGO",
    owner: "PG",
    source: "FemInstance",
    target: "main.installations",
    keyBy: "install_id",
    // deviceTokenHash side effects EXCLUDED here (gap b handled separately, NOT bridged)
    fields: ["install_id", "version"],
    description: "FEM install id + versions. Device-token side effects excluded (gap b).",
  },
  {
    key: "reward_dailies",
    direction: "PG_TO_MONGO",
    owner: "PG",
    source: "RewardAccrual(new dailies)",
    target: "main.poc_reward_dailies",
    keyBy: "miner_key+day",
    fields: ["daily_amount_base", "daily_multiplier_sum"],
    description: "Per miner/day accrual rows for dashboard history/summary.",
  },
  {
    key: "claim_display",
    direction: "PG_TO_MONGO",
    owner: "PG",
    source: "Claim/RewardLedgerEntry",
    target: "main.claims(display)",
    keyBy: "claim_id",
    fields: ["claim_status", "claim_amount_base", "claim_tx_id"],
    description: "Claim status + amounts for frozen dashboard claim display.",
  },
];

/** Mongo owns → bridge syncs Mongo → PG (reward-engine inputs). */
const MONGO_OWNED: FieldMapping[] = [
  {
    key: "device_admin",
    direction: "MONGO_TO_PG",
    owner: "MONGO",
    source: "main.devices(admin fields)",
    target: "Device",
    keyBy: "miner_key",
    fields: ["multiplier", "rewards_enabled", "staked_tier"],
    description: "Admin/dao-written multiplier, rewards-enabled, staked tier the engine reads.",
  },
  {
    key: "blacklist_ban",
    direction: "MONGO_TO_PG",
    owner: "MONGO",
    source: "blacklist",
    target: "Device.banned",
    keyBy: "miner_key",
    fields: ["banned"],
    description: "Ban / unban state.",
  },
  {
    key: "dao_stake",
    direction: "MONGO_TO_PG",
    owner: "MONGO",
    source: "DAO/stake state",
    target: "Device/User(stake)",
    keyBy: "miner_key",
    fields: ["stake_state"],
    description: "DAO/stake state the engine consumes.",
  },
];

export const MAPPINGS: FieldMapping[] = [...PG_OWNED, ...MONGO_OWNED];

/**
 * The core R3 invariant: no logical field is synced in both directions.
 * Returns the offending field(s) — empty array means clean. Throwing wrapper
 * below runs at module load so a bad table never ships.
 */
export function findWriteLoops(mappings: FieldMapping[] = MAPPINGS): string[] {
  const owner = new Map<string, SyncDirection>();
  const conflicts: string[] = [];
  for (const m of mappings) {
    for (const f of m.fields) {
      const prev = owner.get(f);
      if (prev !== undefined && prev !== m.direction) {
        conflicts.push(f);
      } else {
        owner.set(f, m.direction);
      }
    }
  }
  return [...new Set(conflicts)].sort();
}

export function assertNoWriteLoop(mappings: FieldMapping[] = MAPPINGS): void {
  const loops = findWriteLoops(mappings);
  if (loops.length > 0) {
    throw new Error(`bridge_write_loop:${loops.join(",")}`);
  }
}

export function mappingByKey(key: string): FieldMapping | undefined {
  return MAPPINGS.find((m) => m.key === key);
}

// Fail fast at import time — a write-loop in the shipped table is a design bug.
assertNoWriteLoop();
