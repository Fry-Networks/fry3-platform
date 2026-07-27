import { describe, it, expect } from "vitest";
import {
  femTokenShimEnabled,
  buildInstallationsMirrorOp,
  planTokenReconcile,
  FEM_INSTALLATIONS_DB,
  FEM_INSTALLATIONS_COLLECTION,
  FEM_TOKEN_HASH_FIELD,
  FEM_TOKEN_ROTATED_AT_FIELD,
  type PgFemInstance,
  type MongoInstallation,
} from "../src/fem-token.js";

const H1 = "a".repeat(64); // valid sha256-hex shapes
const H2 = "b".repeat(64);
const NOW = "2026-07-22T08:00:00.000Z";

describe("fem-token gap-(b): shim enablement", () => {
  it("defaults OFF (no live Mongo write before flip)", () => {
    expect(femTokenShimEnabled({})).toBe(false);
    expect(femTokenShimEnabled({ FRY3_FEM_TOKEN_SHIM: "0" })).toBe(false);
    expect(femTokenShimEnabled({ FRY3_FEM_TOKEN_SHIM: "false" })).toBe(false);
    expect(femTokenShimEnabled({ FRY3_FEM_TOKEN_SHIM: "" })).toBe(false);
  });
  it("opts in only on 1/true (case/space tolerant)", () => {
    expect(femTokenShimEnabled({ FRY3_FEM_TOKEN_SHIM: "1" })).toBe(true);
    expect(femTokenShimEnabled({ FRY3_FEM_TOKEN_SHIM: " TRUE " })).toBe(true);
  });
});

describe("fem-token gap-(b): buildInstallationsMirrorOp", () => {
  it("targets PoC.installations keyed by {miner_key, install_id} and $sets the hash + marker", () => {
    const op = buildInstallationsMirrorOp("FEM-" + "0".repeat(32), "inst-1", H1, NOW);
    expect(op.db).toBe(FEM_INSTALLATIONS_DB);
    expect(op.db).toBe("PoC");
    expect(op.collection).toBe(FEM_INSTALLATIONS_COLLECTION);
    expect(op.collection).toBe("installations");
    expect(op.filter).toEqual({ miner_key: "FEM-" + "0".repeat(32), install_id: "inst-1" });
    expect(op.set[FEM_TOKEN_HASH_FIELD]).toBe(H1);
    expect(op.set[FEM_TOKEN_HASH_FIELD]).toBe(op.set.device_token_hash);
    expect(op.set[FEM_TOKEN_ROTATED_AT_FIELD]).toBe(NOW);
    // never sets anything else — pure additive field mirror, no canonical-field clobber
    expect(Object.keys(op.set).sort()).toEqual(["device_token_hash", "device_token_rotated_at"]);
  });
  it("rejects empty identity + malformed hash (guards corruption)", () => {
    expect(() => buildInstallationsMirrorOp("", "inst-1", H1, NOW)).toThrow(/empty_miner_key/);
    expect(() => buildInstallationsMirrorOp("mk", "", H1, NOW)).toThrow(/empty_install_id/);
    expect(() => buildInstallationsMirrorOp("mk", "inst-1", "not-a-hash", NOW)).toThrow(/bad_hash/);
    expect(() => buildInstallationsMirrorOp("mk", "inst-1", H1.toUpperCase(), NOW)).toThrow(/bad_hash/);
    expect(() => buildInstallationsMirrorOp("mk", "inst-1", "a".repeat(63), NOW)).toThrow(/bad_hash/);
  });
});

describe("fem-token gap-(b): planTokenReconcile", () => {
  const mk = (n: number) => "FEM-" + String(n).padStart(32, "0");

  it("emits ZERO ops when every PG hash already matches Mongo (convergence)", () => {
    const pg: PgFemInstance[] = [{ minerKey: mk(1), installId: "i1", deviceTokenHash: H1 }];
    const mongo: MongoInstallation[] = [{ miner_key: mk(1), install_id: "i1", device_token_hash: H1 }];
    const plan = planTokenReconcile(pg, mongo, NOW);
    expect(plan.drift).toBe(0);
    expect(plan.ops).toHaveLength(0);
    expect(plan.missingInMongo).toBe(0);
    expect(plan.mismatched).toBe(0);
  });

  it("mirrors a hash the OLD side has never seen (Mongo doc/field absent -> missingInMongo)", () => {
    const pg: PgFemInstance[] = [{ minerKey: mk(2), installId: "i2", deviceTokenHash: H1 }];
    // no matching mongo doc
    const plan = planTokenReconcile(pg, [], NOW);
    expect(plan.drift).toBe(1);
    expect(plan.missingInMongo).toBe(1);
    expect(plan.mismatched).toBe(0);
    expect(plan.ops[0].filter).toEqual({ miner_key: mk(2), install_id: "i2" });
    expect(plan.ops[0].set.device_token_hash).toBe(H1);

    // doc exists but field absent -> still missingInMongo
    const plan2 = planTokenReconcile(pg, [{ miner_key: mk(2), install_id: "i2" }], NOW);
    expect(plan2.missingInMongo).toBe(1);
    expect(plan2.mismatched).toBe(0);
  });

  it("mirrors a rotated hash (Mongo has an old value -> mismatched)", () => {
    const pg: PgFemInstance[] = [{ minerKey: mk(3), installId: "i3", deviceTokenHash: H2 }];
    const mongo: MongoInstallation[] = [{ miner_key: mk(3), install_id: "i3", device_token_hash: H1 }];
    const plan = planTokenReconcile(pg, mongo, NOW);
    expect(plan.drift).toBe(1);
    expect(plan.missingInMongo).toBe(0);
    expect(plan.mismatched).toBe(1);
    expect(plan.ops[0].set.device_token_hash).toBe(H2);
  });

  it("skips PG rows with no hash (non-FEM / never issued)", () => {
    const pg: PgFemInstance[] = [{ minerKey: mk(4), installId: "i4", deviceTokenHash: null }];
    expect(planTokenReconcile(pg, [], NOW).drift).toBe(0);
  });

  it("handles a mixed fleet deterministically (identity-scoped, not global-hash)", () => {
    const pg: PgFemInstance[] = [
      { minerKey: mk(1), installId: "i1", deviceTokenHash: H1 }, // in sync
      { minerKey: mk(2), installId: "i2", deviceTokenHash: H1 }, // missing
      { minerKey: mk(3), installId: "i3", deviceTokenHash: H2 }, // mismatch
      { minerKey: mk(5), installId: "i5", deviceTokenHash: null }, // skip
    ];
    const mongo: MongoInstallation[] = [
      { miner_key: mk(1), install_id: "i1", device_token_hash: H1 },
      { miner_key: mk(3), install_id: "i3", device_token_hash: H1 },
    ];
    const plan = planTokenReconcile(pg, mongo, NOW);
    expect(plan.drift).toBe(2);
    expect(plan.missingInMongo).toBe(1);
    expect(plan.mismatched).toBe(1);
    const keys = plan.ops.map((o) => `${o.filter.miner_key}/${o.filter.install_id}`).sort();
    expect(keys).toEqual([`${mk(2)}/i2`, `${mk(3)}/i3`]);
  });

  it("distinguishes identical hashes under DIFFERENT identities (no cross-identity match)", () => {
    // Same hash value but different (miner_key,install_id): each identity evaluated on its own.
    const pg: PgFemInstance[] = [
      { minerKey: mk(1), installId: "i1", deviceTokenHash: H1 },
      { minerKey: mk(2), installId: "i2", deviceTokenHash: H1 },
    ];
    const mongo: MongoInstallation[] = [{ miner_key: mk(1), install_id: "i1", device_token_hash: H1 }];
    const plan = planTokenReconcile(pg, mongo, NOW);
    expect(plan.drift).toBe(1); // only identity 2 needs the mirror
    expect(plan.ops[0].filter).toEqual({ miner_key: mk(2), install_id: "i2" });
  });
});
