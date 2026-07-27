import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { deriveSettlementUnits, parseSettlementManifest } from "../src/settlement.js";
import { assertNoDuplicatePaymentTuples } from "../src/entitlement-guard.js";

const BATCH_ID = "audit_1785138747";
const TFRY_ASA = 2681521901;

// The exact shape that caused the realized 103,020,000 base-unit overpayment on 2026-07-24:
// two distinct claim UUIDs, one entitlement, same receiver, same amount, same batch.
const TWIN_A = "6812b9ab-3b50-4866-8e0c-f5f625e72765";
const TWIN_B = "8d502632-d46b-4ca0-81bb-4d3abb10a13f";
const TWIN_ADDRESS = "LCJZOBDVUJXRIK6L6U3L2KDXWS2FJ6NHCWMWYXM6DK6URHKJCXAI4GYJSY";
const TWIN_AMOUNT = "103020000";

function makeTwinManifest(rowOverrides: Array<Record<string, unknown>> = [{}, {}]) {
  const payer = algosdk.generateAccount().addr;
  const rows = [
    { claimId: TWIN_A, address: TWIN_ADDRESS, asaId: TFRY_ASA, amountBase: TWIN_AMOUNT, ...rowOverrides[0] },
    { claimId: TWIN_B, address: TWIN_ADDRESS, asaId: TFRY_ASA, amountBase: TWIN_AMOUNT, ...rowOverrides[1] },
  ];
  return JSON.stringify({
    version: 1,
    batchId: BATCH_ID,
    network: "mainnet",
    payer,
    generatedAt: "2026-07-27T08:00:00.000Z",
    rows,
    exclusions: [],
    aggregateBase: "206040000",
  });
}

describe("entitlement-keyed duplicate-payment guard (audit_1785138747 / F3)", () => {
  it("REFUSES a manifest with two rows sharing (address, asaId, amountBase) and no entitlementKey", () => {
    // Regression for the realized double-payment: distinct claimIds must NOT be enough
    // to authorise two identical payments to the same wallet in one batch.
    expect(() => parseSettlementManifest(makeTwinManifest())).toThrow(
      /duplicate payment tuple/i
    );
  });

  it("REFUSES the twin rows when both carry the SAME entitlementKey", () => {
    const raw = makeTwinManifest([
      { entitlementKey: "FEM-IDGAVZS4LF1RRG86WRBARKO0MVNV95HR|31,32,33|2681521901" },
      { entitlementKey: "FEM-IDGAVZS4LF1RRG86WRBARKO0MVNV95HR|31,32,33|2681521901" },
    ]);
    expect(() => parseSettlementManifest(raw)).toThrow(/same entitlement/i);
  });

  it("ALLOWS the twin rows only when each proves a DISTINCT entitlementKey", () => {
    const raw = makeTwinManifest([
      { entitlementKey: "FEM-IDGAVZS4LF1RRG86WRBARKO0MVNV95HR|31,32,33|2681521901" },
      { entitlementKey: "FEM-IDGAVZS4LF1RRG86WRBARKO0MVNV95HR|34,35,36|2681521901" },
    ]);
    const manifest = parseSettlementManifest(raw);
    const units = deriveSettlementUnits(manifest);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.entitlementKey).sort()).toEqual([
      "FEM-IDGAVZS4LF1RRG86WRBARKO0MVNV95HR|31,32,33|2681521901",
      "FEM-IDGAVZS4LF1RRG86WRBARKO0MVNV95HR|34,35,36|2681521901",
    ]);
  });

  it("leaves a manifest with genuinely different receivers untouched", () => {
    const payer = algosdk.generateAccount().addr;
    const raw = JSON.stringify({
      version: 1,
      batchId: BATCH_ID,
      network: "mainnet",
      payer,
      generatedAt: "2026-07-27T08:00:00.000Z",
      rows: [
        { claimId: TWIN_A, address: algosdk.generateAccount().addr, asaId: TFRY_ASA, amountBase: TWIN_AMOUNT },
        { claimId: TWIN_B, address: algosdk.generateAccount().addr, asaId: TFRY_ASA, amountBase: TWIN_AMOUNT },
      ],
      exclusions: [],
      aggregateBase: "206040000",
    });
    expect(() => parseSettlementManifest(raw)).not.toThrow();
  });

  describe("send-path guard (defence in depth, independent of the manifest)", () => {
    const unit = (deviceId: string, over: Record<string, unknown> = {}) => ({
      deviceId,
      address: TWIN_ADDRESS,
      asaId: TFRY_ASA,
      amountBase: BigInt(TWIN_AMOUNT),
      intentId: `intent-${deviceId}`,
      intentDomain: "settlement" as const,
      ...over,
    });

    it("throws on two units with an identical payment tuple and no entitlementKey", () => {
      expect(() =>
        assertNoDuplicatePaymentTuples([unit(TWIN_A), unit(TWIN_B)] as never)
      ).toThrow(/duplicate payment tuple/i);
    });

    it("throws on two units sharing an entitlementKey", () => {
      expect(() =>
        assertNoDuplicatePaymentTuples([
          unit(TWIN_A, { entitlementKey: "E1" }),
          unit(TWIN_B, { entitlementKey: "E1" }),
        ] as never)
      ).toThrow(/same entitlement/i);
    });

    it("permits two units with distinct entitlementKeys", () => {
      expect(() =>
        assertNoDuplicatePaymentTuples([
          unit(TWIN_A, { entitlementKey: "E1" }),
          unit(TWIN_B, { entitlementKey: "E2" }),
        ] as never)
      ).not.toThrow();
    });

    it("permits a single unit", () => {
      expect(() => assertNoDuplicatePaymentTuples([unit(TWIN_A)] as never)).not.toThrow();
    });
  });
});
