import { describe, it, expect } from "vitest";
import {
  compareDedupSets,
  dedupByKey,
  type KeyedProjection,
} from "../src/compare.js";

const T0 = 1_784_700_000_000;

function inst(key: string, marker: number | null, version: unknown): KeyedProjection {
  return { key, markerEpochMs: marker, values: { install_id: key, version } };
}

const FIELDS = ["install_id", "version"];

/**
 * OPTION 1 (P9f) TEETH — compareDedupSets must catch REAL drift (out-of-tolerance
 * churn, intersection field divergence, PG owner regression) while tolerating
 * live-Mongo duplicate docs + benign additive new-install churn. It must NEVER
 * report clean unconditionally.
 */
describe("compareDedupSets: dedup + benign churn (must NOT false-alarm)", () => {
  it("identical distinct sets => clean, intersection all match", () => {
    const owner = [inst("a", null, "1"), inst("b", null, "2"), inst("c", null, "3")];
    const target = [inst("a", T0, "1"), inst("b", T0, "2"), inst("c", T0, "3")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.drift).toBe(false);
    expect(r.symmetricDiff).toBe(0);
    expect(r.intersectionSize).toBe(3);
    expect(r.intersectionMismatches).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("live-Mongo DUPLICATE docs collapse and do NOT inflate drift (dedup TOOTH)", () => {
    const owner = [inst("a", null, "1"), inst("b", null, "2")];
    // 'a' appears TWICE in Mongo (junk dup); distinct target set is still {a,b}.
    const target = [inst("a", T0, "1"), inst("a", T0 - 10, "1"), inst("b", T0, "2")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.distinctTarget).toBe(2); // 3 raw docs -> 2 distinct
    expect(r.symmetricDiff).toBe(0);
    expect(r.drift).toBe(false);
  });

  it("ratification scenario: 1 new + 1 removed + junk dupes within tolerance => clean", () => {
    // owner (PG snapshot) = {a,b,c,d,PGONLY}; target (live Mongo) = {a,b,c,d,NEW} with dupes.
    const owner = [inst("a", null, "1"), inst("b", null, "1"), inst("c", null, "1"), inst("d", null, "1"), inst("PGONLY", null, "1")];
    const target = [
      inst("a", T0, "1"), inst("b", T0, "1"), inst("c", T0, "1"), inst("d", T0, "1"),
      inst("NEW", T0, "1"),                 // new install after snapshot (targetOnly)
      inst("00000000", null, null), inst("00000000", null, null), // test/placeholder dup ×2
    ];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    // ownerOnly = {PGONLY}=1 ; targetOnly = {NEW,00000000}=2 ; symDiff=3 <= tol 5
    expect(r.ownerOnly).toBe(1);
    expect(r.targetOnly).toBe(2);
    expect(r.symmetricDiff).toBe(3);
    expect(r.withinTolerance).toBe(true);
    expect(r.drift).toBe(false);
  });

  it("owner-missing target key is CHURN (targetOnly), NOT an intersection checksum mismatch", () => {
    const owner = [inst("a", null, "1")];
    const target = [inst("a", T0, "1"), inst("kX", T0, "9")]; // kX only in Mongo
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.targetOnly).toBe(1);
    expect(r.intersectionMismatches).toBe(0); // distinct from compareFields (which counts owner-missing)
    expect(r.drift).toBe(false);
  });

  it("cross-store value equality reused: version 6 (number) == '6' (string) on intersection", () => {
    const owner = [inst("a", null, 6)];
    const target = [inst("a", T0, "6")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.intersectionMismatches).toBe(0);
    expect(r.drift).toBe(false);
  });
});

describe("compareDedupSets: real drift (must alarm)", () => {
  it("churn BEYOND tolerance => drift (set_churn reason)", () => {
    const owner = [inst("a", null, "1"), inst("b", null, "1")];
    const target = [inst("x", T0, "1"), inst("y", T0, "1")]; // disjoint: symDiff=4
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 1, priorOwnerBaseline: null });
    expect(r.symmetricDiff).toBe(4);
    expect(r.withinTolerance).toBe(false);
    expect(r.drift).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("set_churn="))).toBe(true);
  });

  it("intersection field divergence => drift even WITHIN tolerance (checksum TOOTH)", () => {
    const owner = [inst("a", null, "1"), inst("b", null, "2")];
    const target = [inst("a", T0, "1"), inst("b", T0, "999")]; // b version diverges
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.symmetricDiff).toBe(0);
    expect(r.intersectionMismatches).toBe(1);
    expect(r.intersectionMismatchKeys).toEqual(["b"]);
    expect(r.drift).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("intersection_checksum="))).toBe(true);
  });

  it("PG owner regression below pinned baseline => drift (regression TOOTH)", () => {
    const owner = [inst("a", null, "1"), inst("b", null, "1")]; // distinctOwner=2
    const target = [inst("a", T0, "1"), inst("b", T0, "1")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: 10 });
    expect(r.ownerRegression).toBe(8);
    expect(r.drift).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("owner_regression="))).toBe(true);
  });

  it("null baseline => no regression signal even when owner is small", () => {
    const owner = [inst("a", null, "1")];
    const target = [inst("a", T0, "1")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.ownerRegression).toBe(0);
    expect(r.drift).toBe(false);
  });

  it("owner GREW past baseline => no regression", () => {
    const owner = [inst("a", null, "1"), inst("b", null, "1"), inst("c", null, "1")];
    const target = [inst("a", T0, "1"), inst("b", T0, "1"), inst("c", T0, "1")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: 2 });
    expect(r.ownerRegression).toBe(0);
    expect(r.drift).toBe(false);
  });

  it("newestSyncedEpochMs = newest target marker", () => {
    const owner = [inst("a", null, "1")];
    const target = [inst("a", T0, "1"), inst("a", T0 + 500, "1")];
    const r = compareDedupSets({ fields: FIELDS, owner, target, tolerance: 5, priorOwnerBaseline: null });
    expect(r.newestSyncedEpochMs).toBe(T0 + 500);
  });
});

describe("dedupByKey: deterministic canonical row per key", () => {
  it("newest marker wins on a duplicate key", () => {
    const m = dedupByKey([inst("a", T0, "old"), inst("a", T0 + 100, "new")]);
    expect(m.get("a")?.values.version).toBe("new");
  });

  it("a real marker beats a null marker", () => {
    const m = dedupByKey([inst("a", null, "nullish"), inst("a", T0, "real")]);
    expect(m.get("a")?.values.version).toBe("real");
    // order-independent
    const m2 = dedupByKey([inst("a", T0, "real"), inst("a", null, "nullish")]);
    expect(m2.get("a")?.values.version).toBe("real");
  });

  it("tie on marker => lexicographically-smallest values wins (order-independent)", () => {
    const m = dedupByKey([inst("a", T0, "zzz"), inst("a", T0, "aaa")]);
    expect(m.get("a")?.values.version).toBe("aaa");
    const m2 = dedupByKey([inst("a", T0, "aaa"), inst("a", T0, "zzz")]);
    expect(m2.get("a")?.values.version).toBe("aaa");
  });
});
