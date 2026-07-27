/**
 * Tooth B (R3) — LIVE store adapters (Mongo + PG).
 *
 * EXCLUDED from the on-host vitest/tsc gate (tsconfig.gate.json exclude): it
 * imports the `mongodb` driver and `@prisma/client`, installed only in the fry3
 * image build. The gate proves the PURE contract (mappings/drift/alert/writer/
 * monitor/compare); this file is the thin READ-ONLY wiring, full-typechecked at
 * image build (`tsc -p tsconfig.json`) and exercised by the flip-time dry-run
 * E2E. WRITE side stays dry-run until the P9c flip.
 *
 * iter31 (2026-07-22): the concrete logical-field → store-column bindings were
 * pinned against the LIVE Mongo/PG schema (READ-ONLY recon; see
 * contracts/toothB-live-binding-findings.md). Two of the seven design mappings
 * resolve to real cross-store field syncs; the other five have NO live-schema
 * counterpart for their declared fields (design targets empty/absent), so they
 * are reported HONESTLY as not-sampled (checksumSampleSize:0) — NEVER a
 * fabricated checksumMismatches:0.
 *
 * iter33 (2026-07-22, OPTION 1 — operator-ratified, plans/fry3-p9f-option1-
 * ratification.md): fem_installs now uses the DEDUP + BASELINE-AWARE set verdict
 * (compare.ts#compareDedupSets) instead of a raw doc-count delta. Live Mongo
 * PoC.installations is a growing collection with junk duplicate docs, so the raw
 * 468-vs-466 delta is not real drift; the verdict compares DISTINCT install_id
 * sets with a churn tolerance, checksums the INTERSECTION, and catches PG
 * regression against a pinned baseline. It is emitted as MappingSample.setDrift
 * so drift.ts uses it as the mismatch trigger; pgCount/mongoCount stay verbatim
 * for log fidelity. This makes tooth-B "clean" reachable WITHOUT loosening the
 * gate (dupes + benign new-install churn tolerated; real drift still alarms).
 */

import { MongoClient } from "mongodb";
import prismaPkg from "@prisma/client";
const { PrismaClient } = prismaPkg as any;
import type { FieldMapping } from "./mappings.js";
import type { MappingSample } from "./drift.js";
import type { SourceRow, UpsertOp } from "./writer.js";
import { compareFields, compareDedupSets, type KeyedProjection } from "./compare.js";

export interface LiveDeps {
  mongo: MongoClient;
  prisma: any;
  mongoDbName: string;
}

/**
 * Per-mapping live-binding disclosure (iter31, verified vs live Mongo+PG
 * 2026-07-22). `bindable:false` mappings are HONESTLY not-sampled — the drift
 * monitor never fabricates a clean checksum for them; the reason is logged at
 * startup so the "not monitored per live schema" state is never hidden.
 */
export const BINDINGS: Record<string, { bindable: boolean; reason: string }> = {
  fem_installs: {
    bindable: true,
    reason:
      "PG FemInstance(instanceKey,version) <-> Mongo PoC.installations(install_id,software_version_installed); target marker last_seen_at; OPTION-1 dedup/baseline-aware set verdict",
  },
  blacklist_ban: {
    bindable: true,
    reason:
      "Mongo main.blacklist-devices membership=banned <-> PG Device.banned; target marker Device.lastSeenAt; counts are banned-only on both sides",
  },
  device_liveness: {
    bindable: false,
    reason:
      "no live Mongo collection carries per-device last_heartbeat/online read by a frozen surface (main.devices lacks it; monitoringsessions are run-logs, not per-device)",
  },
  reward_dailies: {
    bindable: false,
    reason:
      "no shared top-level field: poc_reward_dailies has multiplier_sum but no per-device amount; PG RewardAccrual has amountBase; per-device amount lives in device-rewards.daily_rewards[] (nested array)",
  },
  claim_display: {
    bindable: false,
    reason:
      "no clean top-level claim_id->{status,amount,tx_id} target: reward_pending_claims keyed by groupId with nested amounts; device-rewards claims are nested in arrays",
  },
  device_admin: {
    bindable: false,
    reason:
      "multiplier/rewards_enabled/staked_tier absent in live main.devices AND absent as PG Device columns; real admin inputs are devices.staked / blacklist-devices / dao-stakes",
  },
  dao_stake: {
    bindable: false,
    reason:
      "main.dao-stakes keyed by wallet address+vote (no miner_key) and no PG stake_state column",
  },
};

export function connect(mongoUri: string, databaseUrl: string, mongoDbName = "main"): LiveDeps {
  const mongo = new MongoClient(mongoUri);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  // Startup disclosure: which mappings run a real checksum vs. are not-sampled.
  for (const m of Object.keys(BINDINGS)) {
    const b = BINDINGS[m];
    // eslint-disable-next-line no-console
    console.log(`[fry3-bridge] binding ${m} bindable=${b.bindable} :: ${b.reason}`);
  }
  return { mongo, prisma, mongoDbName };
}

function toEpochMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * OPTION-1 churn tolerance for the fem_installs symmetric set-difference:
 * max(5, ceil(1% of the set size)) — a small absolute+relative bound reflecting
 * normal churn between a frozen PG snapshot and a live-growing Mongo collection.
 * Overridable via FRY3_BRIDGE_FEM_TOLERANCE (non-negative integer) for tuning.
 */
function femTolerance(setSize: number): number {
  const raw = process.env.FRY3_BRIDGE_FEM_TOLERANCE;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return Math.max(5, Math.ceil(0.01 * setSize));
}

/**
 * Pinned PG-owner distinct-count regression baseline. The flip session sets
 * FRY3_BRIDGE_FEM_BASELINE to the known-good PG FemInstance distinct count so a
 * subsequent DROP in PG rows alarms. Unset (pre-flip baseline / first run) →
 * null → no regression check (there is no prior to regress from).
 */
function femBaseline(): number | null {
  const raw = process.env.FRY3_BRIDGE_FEM_BASELINE;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * fem_installs (PG_TO_MONGO): owner PG FemInstance, target Mongo PoC.installations.
 * OPTION 1: read EVERY install_id from both stores (READ-ONLY), dedup, and run
 * compareDedupSets — distinct-set symmetric difference vs a churn tolerance, a
 * field checksum on the INTERSECTION only (owner-missing target keys are churn,
 * not checksum drift), and a pinned-baseline PG regression check. The verdict is
 * carried in MappingSample.setDrift; pgCount/mongoCount stay the raw counts.
 */
async function sampleFemInstalls(
  deps: LiveDeps,
  m: FieldMapping,
  _checksumN: number,
): Promise<MappingSample> {
  const poc = deps.mongo.db("PoC").collection("installations");
  const mongoCount = await poc.estimatedDocumentCount();
  const pgCount = await deps.prisma.femInstance.count();

  // Read all install_ids (READ-ONLY); duplicate Mongo docs collapse in dedup.
  const docs = await poc
    .find(
      {},
      { projection: { _id: 0, install_id: 1, software_version_installed: 1, last_seen_at: 1 } },
    )
    .toArray();
  const target: KeyedProjection[] = docs
    .map((d: any) => ({
      key: String(d.install_id ?? ""),
      markerEpochMs: toEpochMs(d.last_seen_at),
      values: { install_id: d.install_id ?? null, version: d.software_version_installed ?? null },
    }))
    .filter((r: KeyedProjection) => r.key !== "");

  const pgRows = await deps.prisma.femInstance.findMany({
    select: { instanceKey: true, version: true },
  });
  const owner: KeyedProjection[] = pgRows.map((o: any) => ({
    key: String(o.instanceKey),
    markerEpochMs: null,
    values: { install_id: o.instanceKey, version: o.version ?? null },
  }));

  // Tolerance basis = the canonical (PG owner) distinct set size (owner has no
  // dupes). max(5, 1%) → 5 at the current ~466 installs.
  const tolerance = femTolerance(owner.length);
  const priorOwnerBaseline = femBaseline();

  const set = compareDedupSets({
    fields: m.fields,
    owner,
    target,
    tolerance,
    priorOwnerBaseline,
  });

  return {
    key: m.key,
    pgCount,
    mongoCount,
    newestSyncedEpochMs: set.newestSyncedEpochMs,
    // For a set-keyed mapping the checksum sample IS the deduped intersection;
    // report it honestly so logs show how many shared installs were compared.
    checksumSampleSize: set.intersectionSize,
    checksumMismatches: set.intersectionMismatches,
    setDrift: { drift: set.drift, reasons: set.reasons },
  };
}

/**
 * blacklist_ban (MONGO_TO_PG): owner Mongo main.blacklist-devices (membership =
 * banned), target PG Device.banned. Sample the N newest devices by lastSeenAt,
 * checksum `banned` against blacklist membership. Counts are banned-only on both
 * sides (Device WHERE banned=true vs blacklist-devices total) so the count delta
 * is meaningful, not total-devices-vs-11. READ-ONLY on both stores.
 */
async function sampleBlacklistBan(
  deps: LiveDeps,
  m: FieldMapping,
  checksumN: number,
): Promise<MappingSample> {
  const bl = deps.mongo.db(deps.mongoDbName).collection("blacklist-devices");
  const mongoCount = await bl.countDocuments({});
  const pgCount = await deps.prisma.device.count({ where: { banned: true } });

  // NULLS LAST: Postgres orders DESC as NULLS FIRST by default, which would
  // sample devices that have never reported (lastSeenAt IS NULL) instead of the
  // freshest ones. `nulls: "last"` picks the truly most-recently-seen devices.
  const devs = await deps.prisma.device.findMany({
    orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
    take: checksumN,
    select: { minerKey: true, banned: true, lastSeenAt: true },
  });
  const target: KeyedProjection[] = devs.map((d: any) => ({
    key: String(d.minerKey ?? ""),
    markerEpochMs: toEpochMs(d.lastSeenAt),
    values: { banned: !!d.banned },
  }));

  const keys = target.map((t) => t.key).filter((k) => k !== "");
  const bannedDocs = keys.length
    ? await bl
        .find({ miner_key: { $in: keys } }, { projection: { _id: 0, miner_key: 1 } })
        .toArray()
    : [];
  const bannedSet = new Set(bannedDocs.map((b: any) => String(b.miner_key)));
  const owner: KeyedProjection[] = keys.map((k) => ({
    key: k,
    markerEpochMs: null,
    values: { banned: bannedSet.has(k) },
  }));

  const cmp = compareFields({ fields: m.fields, owner, target, sampleN: checksumN });
  return {
    key: m.key,
    pgCount,
    mongoCount,
    newestSyncedEpochMs: cmp.newestSyncedEpochMs,
    checksumSampleSize: cmp.sampleSize,
    checksumMismatches: cmp.mismatches,
  };
}

/** Honest "not sampled" observation for a mapping with no live-schema binding. */
function unsampled(m: FieldMapping): MappingSample {
  return {
    key: m.key,
    pgCount: 0,
    mongoCount: 0,
    newestSyncedEpochMs: null,
    checksumSampleSize: 0, // honest: not sampled (NOT a fabricated clean 0)
    checksumMismatches: 0,
  };
}

/**
 * Comparator sample for a mapping. Bound mappings run a REAL field checksum via
 * compare.ts (READ-ONLY reads of the newest keys on both stores); unbound
 * mappings report an honest not-sampled observation (checksumSampleSize:0).
 */
export async function liveSample(
  deps: LiveDeps,
  m: FieldMapping,
  checksumN: number,
): Promise<MappingSample> {
  switch (m.key) {
    case "fem_installs":
      return sampleFemInstalls(deps, m, checksumN);
    case "blacklist_ban":
      return sampleBlacklistBan(deps, m, checksumN);
    default:
      return unsampled(m);
  }
}

/**
 * Source rows to sync (owner store). The write-sync projections + the PG upsert
 * sink are finalized at the P9c flip session; pre-flip the writer is dry-run
 * (writes nothing) regardless, so this returns [] and the bridge writes nothing.
 * The drift DETECTION that makes tooth-B non-vacuous is liveSample (above), not
 * this write path.
 */
export async function liveReadSource(_deps: LiveDeps, _m: FieldMapping): Promise<SourceRow[]> {
  return [];
}

/** Live upsert sink (only reached when dryRun=false, i.e. at/after flip). */
export async function liveSink(deps: LiveDeps, op: UpsertOp): Promise<void> {
  if (op.store === "MONGO") {
    const col = deps.mongo.db(deps.mongoDbName).collection(op.target.replace(/^main\./, ""));
    await col.updateOne({ [op.keyBy]: op.keyValue }, { $set: op.set }, { upsert: true });
  } else {
    // PG upserts route through Prisma per-model at flip; guarded until then.
    throw new Error(`pg_sink_unbound:${op.keyBy}=${op.keyValue}`);
  }
}

export async function close(deps: LiveDeps): Promise<void> {
  await deps.mongo.close();
  await deps.prisma.$disconnect();
}
