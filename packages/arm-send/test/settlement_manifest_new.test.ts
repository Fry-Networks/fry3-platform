import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import {
  deriveSettlementUnits,
  parseSettlementManifest,
  settlementManifestSha256,
} from "../src/settlement.js";

const BATCH_ID = "p9final_1784868963";
const C9 = "c9c5ba35-92a9-496a-83ef-f83cf69cd8ed";
const C9_CANONICAL = "5Z37MVY5INQGCWIVY6V2KAYOOHIMBSWZAMVKFM5TQ4URA7CCJDUA";
const C9_DUPLICATE = "4ZUHEVEWY6AER5SLHGTNK3SBV3F7LROX3DMOZ7WXBAXOCXMQPKVQ";
const TFRY_ASA = 2681521901;

function makeRaw(over: Record<string, unknown> = {}) {
  const payer = algosdk.generateAccount().addr;
  const rows = [
    ["69872efd-d079-494e-854b-413e8f24d4fb", "556388000"],
    ["6812b9ab-3b50-4866-8e0c-f5f625e72765", "103020000"],
    ["da6b9447-190f-4054-859c-2d04d71e22c5", "432621000"],
    ["9ada251d-977a-464d-8858-8b140438556a", "216321000"],
    ["8d502632-d46b-4ca0-81bb-4d3abb10a13f", "103020000"],
  ].map(([claimId, amountBase]) => ({
    claimId,
    address: algosdk.generateAccount().addr,
    asaId: TFRY_ASA,
    amountBase,
  }));
  return JSON.stringify({
    version: 1,
    batchId: BATCH_ID,
    network: "mainnet",
    payer,
    generatedAt: "2026-07-24T04:30:00.000Z",
    rows,
    exclusions: [
      {
        claimId: C9,
        resolution: "duplicate-exact-payment",
        requestedBase: "216321000",
        canonicalTxid: C9_CANONICAL,
        evidenceTxids: [C9_CANONICAL, C9_DUPLICATE],
      },
    ],
    aggregateBase: "1411370000",
    ...over,
  });
}

describe("settlement manifest and intent domain", () => {
  it("derives five deterministic tFRY units and excludes paid-twice c9", () => {
    const raw = makeRaw();
    const manifest = parseSettlementManifest(raw);
    const units = deriveSettlementUnits(manifest);

    expect(units).toHaveLength(5);
    expect(units.map((unit) => unit.deviceId)).toEqual(
      [...units.map((unit) => unit.deviceId)].sort()
    );
    expect(units.every((unit) => unit.asaId === TFRY_ASA)).toBe(true);
    expect(units.reduce((sum, unit) => sum + unit.amountBase, 0n)).toBe(1411370000n);
    expect(units.some((unit) => unit.deviceId === C9)).toBe(false);
    expect(manifest.exclusions[0]).toMatchObject({
      claimId: C9,
      canonicalTxid: C9_CANONICAL,
    });
    expect(settlementManifestSha256(raw)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds intent to batch, payer, claim, receiver, ASA, and amount", () => {
    const raw = JSON.parse(makeRaw());
    const first = parseSettlementManifest(JSON.stringify(raw));
    const second = parseSettlementManifest(
      JSON.stringify({ ...raw, payer: algosdk.generateAccount().addr })
    );
    const firstIntent = deriveSettlementUnits(first)[0]?.intentId;
    const secondIntent = deriveSettlementUnits(second)[0]?.intentId;

    expect(firstIntent).toMatch(/^[0-9a-f]{64}$/);
    expect(secondIntent).toMatch(/^[0-9a-f]{64}$/);
    expect(firstIntent).not.toBe(secondIntent);
  });

  it("rejects a claim listed as both payable and excluded", () => {
    const parsed = JSON.parse(makeRaw());
    parsed.rows.push({
      claimId: C9,
      address: algosdk.generateAccount().addr,
      asaId: TFRY_ASA,
      amountBase: "216321000",
    });
    parsed.aggregateBase = "1627691000";

    expect(() => parseSettlementManifest(JSON.stringify(parsed))).toThrow(/both|excluded/i);
  });

  it("rejects JSON numbers and fractional base units", () => {
    const parsed = JSON.parse(makeRaw());
    parsed.rows[0].amountBase = 556388000.5;

    expect(() => parseSettlementManifest(JSON.stringify(parsed))).toThrow(/base unit|integer|string/i);
  });
});
