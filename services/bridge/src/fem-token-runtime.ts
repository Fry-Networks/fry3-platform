/**
 * Tooth B gap-(b) — LIVE glue for the FEM device-token PG→Mongo reconcile.
 *
 * EXCLUDED from the on-host vitest/tsc gate (see tsconfig.gate.json): imports `mongodb` and
 * `@prisma/client`, installed only in the fry3 image build. The PURE contract (op shape +
 * reconcile plan) is proven on-host in fem-token.ts / test/fem-token.test.ts; this file is the
 * thin wiring, typechecked at image build and exercised by the flip-time dry-run E2E.
 *
 * Sequencing vs standing scope (live Mongo READ-ONLY until cutover): the reconcile runner reads
 * both stores freely; the WRITE side is gated by dryRun (default true via the shim switch) so it
 * writes live Mongo ONLY at/after the P9c flip. Reversal = the writes are additive $set of one
 * field keyed by {miner_key, install_id}; every op is enumerable from the plan.
 */

import { MongoClient } from "mongodb";
import {
  buildInstallationsMirrorOp,
  planTokenReconcile,
  FEM_INSTALLATIONS_DB,
  FEM_INSTALLATIONS_COLLECTION,
  type FemTokenMirrorOp,
  type PgFemInstance,
  type MongoInstallation,
  type ReconcilePlan,
} from "./fem-token.js";

export type TokenMirrorSink = (op: FemTokenMirrorOp) => Promise<void>;

/** Live PoC.installations sink: additive $set upsert keyed by {miner_key, install_id}. */
export function makeMongoTokenSink(mongo: MongoClient): TokenMirrorSink {
  return async (op) => {
    await mongo
      .db(op.db)
      .collection(op.collection)
      .updateOne(op.filter, { $set: op.set }, { upsert: true });
  };
}

export interface ApplyResult {
  planned: number;
  applied: number;
  skippedDryRun: number;
}

export async function applyReconcile(
  sink: TokenMirrorSink,
  plan: ReconcilePlan,
  dryRun: boolean,
): Promise<ApplyResult> {
  let applied = 0;
  let skippedDryRun = 0;
  for (const op of plan.ops) {
    if (dryRun) {
      skippedDryRun += 1;
      continue;
    }
    await sink(op);
    applied += 1;
  }
  return { planned: plan.ops.length, applied, skippedDryRun };
}

export interface ReconcileDeps {
  prisma: any;
  mongo: MongoClient;
}

/**
 * One reconcile pass: read every PG FemInstance carrying a token hash (joined to Device.minerKey)
 * + the matching PoC.installations projection, plan the mirror ops, and apply them (dry-run unless
 * flipped). Returns the plan + apply result for logging / drift alarms. READ-ONLY on both stores
 * when dryRun=true.
 */
export async function reconcileFemTokens(
  deps: ReconcileDeps,
  nowIso: string,
  dryRun: boolean,
): Promise<{ plan: ReconcilePlan; result: ApplyResult }> {
  const rows = await deps.prisma.femInstance.findMany({
    where: { deviceTokenHash: { not: null } },
    select: {
      instanceKey: true,
      deviceTokenHash: true,
      device: { select: { minerKey: true } },
    },
  });
  const pgRows: PgFemInstance[] = rows.map((r: any) => ({
    minerKey: r.device?.minerKey ?? "",
    installId: r.instanceKey,
    deviceTokenHash: r.deviceTokenHash,
  }));

  const mongoDocs = await deps.mongo
    .db(FEM_INSTALLATIONS_DB)
    .collection(FEM_INSTALLATIONS_COLLECTION)
    .find(
      { device_token_hash: { $exists: true } },
      { projection: { _id: 0, miner_key: 1, install_id: 1, device_token_hash: 1 } },
    )
    .toArray();
  const mongoRows: MongoInstallation[] = mongoDocs.map((d) => ({
    miner_key: String((d as Record<string, unknown>).miner_key ?? ""),
    install_id: String((d as Record<string, unknown>).install_id ?? ""),
    device_token_hash: ((d as Record<string, unknown>).device_token_hash as string | null | undefined) ?? null,
  }));

  const plan = planTokenReconcile(pgRows, mongoRows, nowIso);
  const sink = makeMongoTokenSink(deps.mongo);
  const result = await applyReconcile(sink, plan, dryRun);
  return { plan, result };
}

/** Convenience for a one-shot mirror of a single freshly-minted rotation (used by tooling/tests). */
export async function mirrorOne(
  sink: TokenMirrorSink,
  minerKey: string,
  installId: string,
  deviceTokenHash: string,
  nowIso: string,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  await sink(buildInstallationsMirrorOp(minerKey, installId, deviceTokenHash, nowIso));
  return true;
}
