import { describe, it, expect } from "vitest";
import {
  canon,
  rowsMatch,
  newestMarker,
  compareFields,
  type KeyedProjection,
} from "../src/compare.js";

const T0 = 1_784_700_000_000;

function proj(key: string, marker: number | null, values: Record<string, unknown>): KeyedProjection {
  return { key, markerEpochMs: marker, values };
}

describe("compare: canon (cross-store value equality)", () => {
  it("PG string base-units equal Mongo numeric base-units", () => {
    expect(canon("250")).toBe(canon(250));
    expect(canon("336483000")).toBe(canon(336483000));
  });
  it("booleans normalize (true/1 equal, false/0 equal)", () => {
    expect(canon(true)).toBe(canon(1));
    expect(canon(false)).toBe(canon(0));
  });
  it("null and undefined collapse to one sentinel, distinct from empty string", () => {
    expect(canon(null)).toBe(canon(undefined));
    expect(canon(null)).not.toBe(canon(""));
    expect(canon(null)).not.toBe(canon("null")); // literal string "null" is data, not absence
  });
  it("different numbers do NOT collapse", () => {
    expect(canon("250")).not.toBe(canon("251"));
    expect(canon(250)).not.toBe(canon(2500));
  });
  it("object field order does not fabricate drift", () => {
    expect(canon({ a: 1, b: 2 })).toBe(canon({ b: 2, a: 1 }));
  });
});

describe("compare: rowsMatch", () => {
  const fields = ["daily_multiplier_sum", "banned"];
  it("agrees on all owned fields => match (ignores non-owned fields)", () => {
    expect(rowsMatch(fields, { daily_multiplier_sum: "5", banned: true, extra: "x" }, { daily_multiplier_sum: 5, banned: 1, extra: "y" })).toBe(true);
  });
  it("any owned field diverging => no match", () => {
    expect(rowsMatch(fields, { daily_multiplier_sum: 5, banned: true }, { daily_multiplier_sum: 6, banned: true })).toBe(false);
  });
});

describe("compare: newestMarker", () => {
  it("returns max marker, ignoring nulls", () => {
    expect(newestMarker([proj("a", T0, {}), proj("b", T0 + 5, {}), proj("c", null, {})])).toBe(T0 + 5);
  });
  it("all-null => null", () => {
    expect(newestMarker([proj("a", null, {}), proj("b", null, {})])).toBeNull();
  });
  it("empty => null", () => {
    expect(newestMarker([])).toBeNull();
  });
});

describe("compare: compareFields (the TEETH — must catch real drift)", () => {
  const fields = ["amount", "status"];

  it("identical owner/target => ZERO mismatches (no false alarm)", () => {
    const owner = [proj("k1", T0, { amount: 100, status: "claimed" }), proj("k2", T0, { amount: "250", status: "pending" })];
    const target = [proj("k1", T0, { amount: "100", status: "claimed" }), proj("k2", T0, { amount: 250, status: "pending" })];
    const r = compareFields({ fields, owner, target, sampleN: 100 });
    expect(r.mismatches).toBe(0);
    expect(r.sampleSize).toBe(2);
    expect(r.newestSyncedEpochMs).toBe(T0);
    expect(r.mismatchKeys).toEqual([]);
  });

  it("a genuine field divergence surfaces as a nonzero mismatch (TOOTH)", () => {
    const owner = [proj("k1", T0, { amount: 100, status: "claimed" }), proj("k2", T0, { amount: 250, status: "pending" })];
    const target = [proj("k1", T0, { amount: 100, status: "claimed" }), proj("k2", T0, { amount: 999, status: "pending" })];
    const r = compareFields({ fields, owner, target, sampleN: 100 });
    expect(r.mismatches).toBe(1);
    expect(r.mismatchKeys).toEqual(["k2"]);
  });

  it("target key missing from owner => mismatch (drift both directions)", () => {
    const owner = [proj("k1", T0, { amount: 100, status: "ok" })];
    const target = [proj("k1", T0, { amount: 100, status: "ok" }), proj("kX", T0, { amount: 5, status: "ok" })];
    const r = compareFields({ fields, owner, target, sampleN: 100 });
    expect(r.mismatches).toBe(1);
    expect(r.mismatchKeys).toEqual(["kX"]);
  });

  it("samples only the N NEWEST target keys by marker", () => {
    // Newest two (k3,k2) are clean; an OLD key (k1) has drift but is outside the sample.
    const owner = [
      proj("k1", T0 - 100, { amount: 1, status: "ok" }),
      proj("k2", T0 - 50, { amount: 2, status: "ok" }),
      proj("k3", T0, { amount: 3, status: "ok" }),
    ];
    const target = [
      proj("k1", T0 - 100, { amount: 999, status: "ok" }), // drift, but oldest
      proj("k2", T0 - 50, { amount: 2, status: "ok" }),
      proj("k3", T0, { amount: 3, status: "ok" }),
    ];
    const r = compareFields({ fields, owner, target, sampleN: 2 });
    expect(r.sampleSize).toBe(2);
    expect(r.mismatches).toBe(0); // k1's drift is outside the newest-2 window
    // newestSyncedEpochMs still reflects the whole target set's freshest marker.
    expect(r.newestSyncedEpochMs).toBe(T0);
  });

  it("older drifting key INSIDE a large enough sample IS caught", () => {
    const owner = [
      proj("k1", T0 - 100, { amount: 1, status: "ok" }),
      proj("k2", T0, { amount: 2, status: "ok" }),
    ];
    const target = [
      proj("k1", T0 - 100, { amount: 999, status: "ok" }),
      proj("k2", T0, { amount: 2, status: "ok" }),
    ];
    const r = compareFields({ fields, owner, target, sampleN: 100 });
    expect(r.mismatches).toBe(1);
    expect(r.mismatchKeys).toEqual(["k1"]);
  });

  it("all-null markers => newestSyncedEpochMs null, still compares", () => {
    const owner = [proj("k1", null, { amount: 1, status: "ok" })];
    const target = [proj("k1", null, { amount: 2, status: "ok" })];
    const r = compareFields({ fields, owner, target, sampleN: 100 });
    expect(r.newestSyncedEpochMs).toBeNull();
    expect(r.mismatches).toBe(1);
  });

  it("empty target => zero sample, zero mismatch, null marker", () => {
    const r = compareFields({ fields, owner: [proj("k1", T0, { amount: 1, status: "ok" })], target: [], sampleN: 100 });
    expect(r.sampleSize).toBe(0);
    expect(r.mismatches).toBe(0);
    expect(r.newestSyncedEpochMs).toBeNull();
  });
});
