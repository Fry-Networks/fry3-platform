/**
 * Tooth B gap-(b) — SYNCHRONOUS FEM device-token mirror for the api hot path (rotation).
 *
 * Race-free primary path (prior-recon preference, 2026-07-22): when the NEW api mints/rotates a
 * FEM device token in legacy-telemetry.ts, it persists sha256 to PG FemInstance.deviceTokenHash
 * AND — via this sink — synchronously upserts the same hash into Mongo PoC.installations
 * (device_token_hash, keyed {miner_key, install_id}) BEFORE returning the token to the device.
 * This eliminates the rotate-then-immediately-call-old-endpoint window that a purely async bridge
 * reconcile (fem-token-runtime.ts) would leave open. The bridge reconcile remains the safety-net
 * that backfills at flip + heals any hot-path write that failed.
 *
 * STANDALONE (imports only `mongodb`, no cross-package import): apps/api cannot import
 * @fry3/bridge without a workspace alias, so the PoC.installations op shape is mirrored here from
 * services/bridge/src/fem-token.ts — kept identical by construction (same db/collection/field/key).
 *
 * GATE: excluded from the on-host bridge gate (that gate is @fry3/bridge only). This file is
 * typechecked in the fry3-api image build (tsc -p tsconfig.json) and wired at the P9c flip per
 * contracts/toothB-gapB-devicetoken-shim.md. `mongodb` is added to apps/api deps at that build.
 */

const DB = "PoC";
const COLLECTION = "installations";
const HASH_FIELD = "device_token_hash";
const ROTATED_AT_FIELD = "device_token_rotated_at";

/** Injected into registerLegacyTelemetry as the optional 3rd arg. Best-effort: never throws. */
export type ApiTokenMirror = (
  minerKey: string,
  installId: string,
  deviceTokenHash: string,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * Build the live mirror from env. Called once at server start ONLY when the shim is enabled
 * (server.ts guards on FRY3_FEM_TOKEN_SHIM). Reuses the bridge Mongo URI unless a dedicated one
 * is provided. A single shared MongoClient (pooled) is connected eagerly so the hot path never
 * pays connection latency.
 */
export async function makeApiTokenMirror(
  env: Record<string, string | undefined>,
): Promise<ApiTokenMirror> {
  const uri = (env.FRY3_FEM_TOKEN_MONGO_URI ?? env.FRY3_BRIDGE_MONGO_URI ?? "").trim();
  if (!uri) throw new Error("fem_token_shim:missing_mongo_uri");
  // Lazy driver load: `mongodb` is imported only here (shim-on path), never at module top-level,
  // so esbuild single-file bundle keeps it a runtime-external dynamic import (default api never loads it).
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db(DB).collection(COLLECTION);
  return async (minerKey, installId, deviceTokenHash) => {
    try {
      await col.updateOne(
        { miner_key: minerKey, install_id: installId },
        { $set: { [HASH_FIELD]: deviceTokenHash, [ROTATED_AT_FIELD]: new Date().toISOString() } },
        { upsert: true },
      );
      return { ok: true };
    } catch (e) {
      // Non-fatal: the heartbeat/rotation already succeeded PG-side; return the failure so the
      // caller can log + let the bridge reconcile heal on the next cycle. Never breaks telemetry.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
