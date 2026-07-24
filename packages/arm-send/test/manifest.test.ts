import { describe, it, expect } from "vitest";
import {
  parseManifest,
  assertSanity,
  deriveSendUnits,
  perAsaSendCount,
  parseBaseUnit,
  ArmSanityFailed,
  ArmAmountUnitsFailed,
  type Entitlement,
} from "../src/manifest.js";
import { FRY3_ASA, FNODE_ASA } from "../src/types.js";

const ADDR_A = "A".repeat(58);
const ADDR_B = "B".repeat(58);

function manifestJson(over: any = {}): string {
  return JSON.stringify({
    epoch: 1784733595,
    generatedAt: "2026-07-22T15:00:00Z",
    rows: over.rows ?? [
      { deviceId: "d1", address: ADDR_A, fry3Base: "100", fnodeBase: "336483000" },
      { deviceId: "d2", address: ADDR_B, fry3Base: "50", fnodeBase: "0" },
    ],
    aggregates: over.aggregates ?? { fry3Total: "150", fnodeTotal: "336483000", deviceCount: 2 },
    owed: over.owed ?? { fry3Total: "150", fnodeTotal: "336483000" },
    ...over.top,
  });
}

const bigEnt = (): Map<string, Entitlement> =>
  new Map([
    ["d1", { fry3Base: 1000n, fnodeBase: 1_000_000_000n }],
    ["d2", { fry3Base: 1000n, fnodeBase: 1_000_000_000n }],
  ]);
const CEIL = { fry3: 10n ** 18n, fnode: 10n ** 18n };

describe("base-unit parsing (R14.2 base-unit assertion)", () => {
  it("accepts integer strings", () => {
    expect(parseBaseUnit("336483000", "x")).toBe(336483000n);
  });
  it("rejects JSON number amounts (10^decimals hazard)", () => {
    expect(() => parseBaseUnit(336483000, "x")).toThrow(ArmAmountUnitsFailed);
  });
  it("rejects float / non-integer strings", () => {
    expect(() => parseBaseUnit("1.5", "x")).toThrow(ArmAmountUnitsFailed);
    expect(() => parseBaseUnit("abc", "x")).toThrow(ArmAmountUnitsFailed);
  });
});

describe("manifest parse + sanity gate (R14.2)", () => {
  it("parses a well-formed manifest with bigint amounts", () => {
    const m = parseManifest(manifestJson());
    expect(m.rows[0].fnodeBase).toBe(336483000n);
    expect(m.aggregates.fry3Total).toBe(150n);
  });

  it("passes sanity for a consistent, within-band manifest", () => {
    const m = parseManifest(manifestJson());
    expect(() => assertSanity(m, bigEnt(), CEIL)).not.toThrow();
  });

  it("BLOCKER when aggregate exceeds owed (can't-exceed-owed R14.2.1)", () => {
    const m = parseManifest(manifestJson({ owed: { fry3Total: "149", fnodeTotal: "336483000" } }));
    expect(() => assertSanity(m, bigEnt(), CEIL)).toThrow(ArmSanityFailed);
  });

  it("BLOCKER when a row exceeds its entitlement (derived-sanity band R14.2.2)", () => {
    const m = parseManifest(manifestJson());
    const ent = new Map([
      ["d1", { fry3Base: 100n, fnodeBase: 1n }], // fnode entitlement below the 336483000 row
      ["d2", { fry3Base: 1000n, fnodeBase: 1000n }],
    ]);
    expect(() => assertSanity(m, ent, CEIL)).toThrow(/exceeds entitlement/);
  });

  it("BLOCKER when a device is missing from the reconciled ledger", () => {
    const m = parseManifest(manifestJson());
    const ent = new Map([["d1", { fry3Base: 1000n, fnodeBase: 1_000_000_000n }]]);
    expect(() => assertSanity(m, ent, CEIL)).toThrow(/no entitlement/);
  });

  it("BLOCKER on absurd magnitude", () => {
    const m = parseManifest(manifestJson());
    expect(() => assertSanity(m, bigEnt(), { fry3: 10n, fnode: 10n ** 18n })).toThrow(/absurd/);
  });

  it("BLOCKER when aggregates disagree with row sums", () => {
    const m = parseManifest(manifestJson({ aggregates: { fry3Total: "999", fnodeTotal: "336483000", deviceCount: 2 } }));
    expect(() => assertSanity(m, bigEnt(), CEIL)).toThrow(/agg/);
  });

  it("BLOCKER on duplicate deviceId", () => {
    expect(() =>
      parseManifest(
        manifestJson({
          rows: [
            { deviceId: "d1", address: ADDR_A, fry3Base: "1", fnodeBase: "0" },
            { deviceId: "d1", address: ADDR_B, fry3Base: "1", fnodeBase: "0" },
          ],
        })
      )
    ).toThrow(/duplicate/);
  });

  it("BLOCKER on bad address length", () => {
    expect(() =>
      parseManifest(manifestJson({ rows: [{ deviceId: "d1", address: "short", fry3Base: "1", fnodeBase: "0" }] }))
    ).toThrow(/address/);
  });
});

describe("send-unit derivation", () => {
  it("derives one leg per nonzero (device,ASA); skips zero legs", () => {
    const m = parseManifest(manifestJson());
    const units = deriveSendUnits(m);
    // d1: fry3(100)+fnode(336483000)=2 ; d2: fry3(50)+fnode(0)=1 → 3 legs
    expect(units.length).toBe(3);
    const asaCount = perAsaSendCount(units);
    expect(asaCount.get(FRY3_ASA)).toBe(2);
    expect(asaCount.get(FNODE_ASA)).toBe(1);
    // frozen intent-ids
    expect(units.every((u) => /^[0-9a-f]{64}$/.test(u.intentId))).toBe(true);
    // amounts are exact base-unit bigints
    expect(units.find((u) => u.asaId === FNODE_ASA)!.amountBase).toBe(336483000n);
  });
});
