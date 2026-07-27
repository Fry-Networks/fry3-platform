/**
 * Tooth B (R3) — sync writer (pure planning + gated apply).
 *
 * Turns source rows into idempotent upsert ops for the target store, honoring
 * the field-ownership direction. The apply step is DRY-RUN by default: in
 * dry-run the op sink is NEVER invoked, so pre-flip the bridge provably writes
 * nothing (standing scope: live Mongo READ-ONLY until the P9c flip). Live
 * writes begin only when the entrypoint starts with dryRun=false at flip-time.
 */

import type { FieldMapping, Store } from "./mappings.js";

export interface UpsertOp {
  store: Store; // destination store
  target: string; // collection (Mongo) or table (PG)
  keyBy: string;
  keyValue: string;
  set: Record<string, unknown>;
}

/** A source row: the join-key value plus the owned field values. */
export interface SourceRow {
  keyValue: string;
  values: Record<string, unknown>;
}

/**
 * Plan upserts for a mapping. Destination store is the OPPOSITE of the owner:
 * PG-owned → write Mongo; Mongo-owned → write PG. Only the mapping's declared
 * fields are copied (never anything outside the ownership contract).
 */
export function planOps(mapping: FieldMapping, rows: SourceRow[]): UpsertOp[] {
  const destStore: Store = mapping.direction === "PG_TO_MONGO" ? "MONGO" : "PG";
  return rows.map((r) => {
    const set: Record<string, unknown> = {};
    for (const f of mapping.fields) {
      if (f in r.values) set[f] = r.values[f];
    }
    return {
      store: destStore,
      target: mapping.target,
      keyBy: mapping.keyBy,
      keyValue: r.keyValue,
      set,
    };
  });
}

export interface OpSink {
  (op: UpsertOp): Promise<void>;
}

export interface ApplyResult {
  planned: number;
  applied: number;
  skippedDryRun: number;
}

/**
 * Apply planned ops. dryRun=true → sink is never called; returns the ops as
 * skipped. This is the invariant the gate proves for pre-flip safety.
 */
export async function applyOps(
  ops: UpsertOp[],
  sink: OpSink,
  dryRun: boolean,
): Promise<ApplyResult> {
  if (dryRun) {
    return { planned: ops.length, applied: 0, skippedDryRun: ops.length };
  }
  let applied = 0;
  for (const op of ops) {
    await sink(op);
    applied += 1;
  }
  return { planned: ops.length, applied, skippedDryRun: 0 };
}
