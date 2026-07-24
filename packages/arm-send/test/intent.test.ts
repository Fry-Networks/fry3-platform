import { describe, it, expect } from "vitest";
import { computeIntentId, noteFor, noteStringFor, leaseFor } from "../src/intent.js";
import { NOTE_PREFIX, FRY3_ASA, FNODE_ASA } from "../src/types.js";

describe("intent-id determinism + freeze (R14.5.1)", () => {
  const dev = "dev-abc";
  it("same inputs → same id (crash/resume/succession stable)", () => {
    const a = computeIntentId(dev, FRY3_ASA, 336483000n, 1784733595);
    const b = computeIntentId(dev, FRY3_ASA, 336483000n, 1784733595);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("any field change → different id (device/asa/owed/epoch all bound)", () => {
    const base = computeIntentId(dev, FRY3_ASA, 100n, 1784733595);
    expect(computeIntentId("dev-abd", FRY3_ASA, 100n, 1784733595)).not.toBe(base);
    expect(computeIntentId(dev, FNODE_ASA, 100n, 1784733595)).not.toBe(base);
    expect(computeIntentId(dev, FRY3_ASA, 101n, 1784733595)).not.toBe(base);
    expect(computeIntentId(dev, FRY3_ASA, 100n, 1784733596)).not.toBe(base);
  });

  it("owed is base-unit exact — 1 vs 10 differ (no 10^decimals collision)", () => {
    expect(computeIntentId(dev, FNODE_ASA, 1n, 1)).not.toBe(computeIntentId(dev, FNODE_ASA, 10n, 1));
  });

  it("no delimiter-ambiguity collision between adjacent fields", () => {
    // ("a","1"...) vs ("a 1"...) must not collide (space-in-device is rejected anyway)
    const x = computeIntentId("a", 1 as any, 2n, 3);
    // asaId must be a positive int; use two valid-but-different tuples that could concat-collide
    const p = computeIntentId("ab", 12, 3n, 4);
    const q = computeIntentId("a", 123, 4n, 4); // "a"+"123" vs "ab"+"12" — delimiter prevents collision
    expect(p).not.toBe(q);
    expect(x).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects negative owed / bad asa / bad epoch", () => {
    expect(() => computeIntentId(dev, FRY3_ASA, -1n, 1)).toThrow();
    expect(() => computeIntentId(dev, 0, 1n, 1)).toThrow();
    expect(() => computeIntentId(dev, FRY3_ASA, 1n, 0)).toThrow();
  });

  it("note carries the id and round-trips", () => {
    const id = computeIntentId(dev, FRY3_ASA, 5n, 9);
    expect(noteStringFor(id)).toBe(NOTE_PREFIX + id);
    expect(new TextDecoder().decode(noteFor(id))).toBe(NOTE_PREFIX + id);
  });

  it("lease is exactly 32 bytes and deterministic + domain-separated from note", () => {
    const id = computeIntentId(dev, FRY3_ASA, 5n, 9);
    const l1 = leaseFor(id);
    const l2 = leaseFor(id);
    expect(l1.length).toBe(32);
    expect(Buffer.from(l1).equals(Buffer.from(l2))).toBe(true);
    // lease bytes must not equal the note prefix bytes (independent derivation)
    expect(Buffer.from(l1).toString("hex")).not.toBe(Buffer.from(noteFor(id).slice(0, 32)).toString("hex"));
  });
});
