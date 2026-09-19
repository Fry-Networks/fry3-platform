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

/* ------------------------------------------------------------------------- *
 * Installation FIELD mirror — separate from the token mirror above, on purpose.
 *
 * The token mirror's contract is that it sets ONLY device_token_hash +
 * device_token_rotated_at ("pure additive field mirror, no canonical-field
 * clobber", asserted in services/bridge/test/fem-token.test.ts). That contract is
 * correct and stays. But it meant PoC.installations — the collection the dashboard
 * and fleet tooling read — never received the rest of the heartbeat body, so every
 * device registering through the public endpoint after the 2026-09-08 split showed
 * no os, hostname, device_name, is_installed or version. The body itself was never
 * lost: legacy-telemetry hands it to the store, which persists it to Postgres.
 *
 * Its own MongoClient rather than sharing the token mirror's: widening that factory
 * would mean touching the token minting chain, which is deliberately out of scope
 * here. Two pooled clients to the same URI, both built once at startup.
 * ------------------------------------------------------------------------- */

/** The heartbeat fields PoC.installations should carry. */
export const INSTALLATION_MIRROR_FIELDS = [
  "software_version_installed",
  "poc_version_installed",
  "os",
  "hostname",
  "device_name",
  "is_installed",
  // ZEUS00's frozen upsert_installation persists minerCode and 475 of 756 existing docs
  // carry it; without it here, documents this service creates are missing the only field
  // that identifies the product type once the IOT-/FEM- prefix split is gone.
  "minerCode",
] as const;

export type InstallationFieldMirror = (
  minerKey: string,
  installId: string,
  body: Record<string, unknown>,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * PURE: the `$set` for one heartbeat body.
 *
 * Only fields the device actually SUPPLIED are written. The frozen hardwareapi
 * handler writes null for anything absent; copying that here would overwrite good
 * values with null — including software_version_installed, which a second,
 * independent mirror on ZEUS00 keeps current from the 60s PoC tick. "Absent" and
 * "explicitly null" are both treated as "no news", never as "erase what you have".
 * Empty/whitespace strings are skipped too, matching the frozen handler's own
 * `if not payload.get("device_name"): payload.pop("device_name")`.
 */
export function buildInstallationFieldSet(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const field of INSTALLATION_MIRROR_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    set[field] = value;
  }
  return set;
}

/**
 * PURE: the full {filter, update, options} for one heartbeat's installation mirror.
 *
 * WHY UPSERT: nothing else creates these documents for a device that registers against
 * this service. The bridge's sampleFemInstalls is explicitly READ-ONLY — it measures
 * PG<->Mongo drift, it does not reconcile — and fem-token-runtime's sink writes only the
 * token hash. Measured 2026-09-18: a device that registered 28 hours earlier, with two
 * PG FemInstance rows to its name, still had zero PoC.installations documents. Without
 * upsert this mirror could only ever enrich a document that some other system had
 * already created, which for IOT- devices never happens.
 *
 * Shape follows ZEUS00's upsert_installation (hardware_exe_api/storage.py):
 *  - first_installed_at and _lease are $setOnInsert, so a re-registration never moves
 *    the creation stamp or clobbers an active lease.
 *  - last_seen_at is $set on every heartbeat. It is server-generated, not device-
 *    reported, so refreshing it does not violate this mirror's "absent means no news,
 *    never erase what you have" contract — and the bridge's drift sampler reads it as
 *    the freshness marker (toEpochMs), so a document without it reads as null forever.
 *  - `now` is a Date, never an ISO string: all 678 existing last_seen_at values are BSON
 *    dates and none are strings, and toEpochMs branches on `v instanceof Date` first.
 *    A string here would create a mixed-type field and break range queries and sorts.
 */
export function buildInstallationMirrorOp(
  minerKey: string,
  installId: string,
  body: Record<string, unknown>,
  now: Date,
) {
  return {
    filter: { miner_key: minerKey, install_id: installId },
    update: {
      $set: { ...buildInstallationFieldSet(body), last_seen_at: now },
      $setOnInsert: { first_installed_at: now, _lease: false },
    },
    options: { upsert: true },
  };
}

/**
 * Build the live field mirror. Same env contract and same lazy `mongodb` import as
 * makeApiTokenMirror, so the driver stays off the default (shim-off) runtime path.
 */
export async function makeInstallationFieldMirror(
  env: Record<string, string | undefined>,
): Promise<InstallationFieldMirror> {
  const uri = (env.FRY3_FEM_TOKEN_MONGO_URI ?? env.FRY3_BRIDGE_MONGO_URI ?? "").trim();
  if (!uri) throw new Error("installation_field_mirror:missing_mongo_uri");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db(DB).collection(COLLECTION);
  return async (minerKey, installId, body) => {
    try {
      if (!minerKey || !installId) return { ok: false, error: "empty_identity" };
      // The empty-$set guard this replaced is no longer needed: last_seen_at is always
      // present, so the $set can never be empty, and a heartbeat that reports no fields
      // should still create the document rather than silently doing nothing.
      const op = buildInstallationMirrorOp(minerKey, installId, body, new Date());
      await col.updateOne(op.filter, op.update, op.options);
      return { ok: true };
    } catch (e) {
      // Non-fatal, exactly like the token mirror: the heartbeat already succeeded
      // Postgres-side and the device is waiting on its 202.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/* ------------------------------------------------------------------------- *
 * main.devices doc mirror — the dashboard/reward-tooling view of a device.
 *
 * Port of MongoStore._ensure_fem_device_doc (ZEUS00
 * /home/fry/subdomains/hardware_exe_api/storage.py:1084). That method creates the
 * pending main.devices doc on registration AND on lease acquisition, and its prefix
 * guard was widened from FEM-only to ("FEM-", "IOT-") on 2026-09-08.
 *
 * After the registration split, IOT- devices register against THIS service instead of
 * hardwareapi, and nothing here wrote main.devices — so they landed in Postgres,
 * heartbeat happily, and stayed invisible to the dashboard and the reward script.
 * Measured 2026-09-17: 13 live IOT- devices, 0 bound owners, 1 device doc.
 *
 * Contract, identical to the Python: $setOnInsert only, so the dashboard-owned mutable
 * fields (is_registered / address / reward_wallet / verified) are never clobbered on a
 * doc that already exists. device_algo_address is the one $set field, mirroring the
 * Python's reward-address refresh, and is written only when PoC.installations actually
 * carries an algo_address. Best-effort throughout: the device is waiting on its 202.
 * ------------------------------------------------------------------------- */

export const DEVICE_DOC_DB = "main";
export const DEVICE_DOC_COLLECTION = "devices";

/** The exact prefix tuple storage.py guards on. Anything else gets no device doc. */
export const DEVICE_DOC_PREFIXES = ["FEM-", "IOT-"] as const;

/**
 * main.devices has no device-type field, so the display name is the only thing
 * distinguishing an ESP board from a desktop miner. Strings are verbatim from
 * storage.py:1109 — changing either would silently rename devices in the dashboard.
 */
export function deviceDocName(minerKey: string): string {
  return minerKey.startsWith("IOT-") ? "Fry IoT VPN Node" : "Fry Edge Miner";
}

/** PURE: the $setOnInsert document, or null for a key outside the family tuple. */
export function buildDeviceDocInsert(
  minerKey: string,
  now: Date,
): Record<string, unknown> | null {
  if (!DEVICE_DOC_PREFIXES.some((p) => minerKey.startsWith(p))) return null;
  return {
    miner_key: minerKey,
    created_at: now,
    is_registered: false,
    enabled: true,
    verified: false,
    name: deviceDocName(minerKey),
  };
}

export type DeviceDocMirror = (minerKey: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * Build the live device-doc mirror. Same env contract and same lazy `mongodb` import
 * as the two mirrors above, so the driver stays off the default (shim-off) path.
 */
export async function makeDeviceDocMirror(
  env: Record<string, string | undefined>,
): Promise<DeviceDocMirror> {
  const uri = (env.FRY3_FEM_TOKEN_MONGO_URI ?? env.FRY3_BRIDGE_MONGO_URI ?? "").trim();
  if (!uri) throw new Error("device_doc_mirror:missing_mongo_uri");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  await client.connect();
  const devices = client.db(DEVICE_DOC_DB).collection(DEVICE_DOC_COLLECTION);
  // Reward address lives on the installation doc, same lookup storage.py does.
  const installations = client.db(DB).collection(COLLECTION);
  return async (minerKey) => {
    try {
      if (!minerKey) return { ok: false, error: "empty_identity" };
      const insert = buildDeviceDocInsert(minerKey, new Date());
      // Out-of-family key: a no-op, matching the Python's early return. Not an error.
      if (!insert) return { ok: true };
      const inst = await installations.findOne(
        { miner_key: minerKey, algo_address: { $exists: true, $ne: null } },
        { projection: { algo_address: 1 } },
      );
      const rewardAddr = (inst as Record<string, unknown> | null)?.algo_address;
      const update: Record<string, unknown> = { $setOnInsert: insert };
      if (rewardAddr) update.$set = { device_algo_address: rewardAddr };
      await devices.updateOne({ miner_key: minerKey }, update, { upsert: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
