import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { parseSettlementManifest } from "../src/settlement.js";

const TFRY_ASA = 2681521901;

// Envelopes in main.reward_pending_claims are short-lived: claim.js writes
// expiresAt = new Date(Date.now() + 3e5), i.e. createdAt + 5 minutes.
// On 2026-07-24 the settlement driver paid two envelopes that had expired on 2026-07-17 —
// seven days earlier — because nothing on the settlement path ever consulted expiry.
const GENERATED_AT = "2026-07-24T21:16:35.000Z";
const EXPIRED_AT = "2026-07-17T03:03:36.752Z"; // the real LCJZOB envelope expiry
const STILL_VALID_AT = "2026-07-24T21:21:35.000Z";

function manifest(rowExtra: Record<string, unknown>, generatedAt = GENERATED_AT) {
  return JSON.stringify({
    version: 1,
    batchId: "audit_1785138747",
    network: "mainnet",
    payer: algosdk.generateAccount().addr,
    generatedAt,
    rows: [
      {
        claimId: "6812b9ab-3b50-4866-8e0c-f5f625e72765",
        address: algosdk.generateAccount().addr,
        asaId: TFRY_ASA,
        amountBase: "103020000",
        ...rowExtra,
      },
    ],
    exclusions: [],
    aggregateBase: "103020000",
  });
}

describe("envelope expiry gate (audit_1785138747 / M.2)", () => {
  it("REFUSES a row whose envelope expired before the manifest was generated", () => {
    expect(() => parseSettlementManifest(manifest({ envelopeExpiresAt: EXPIRED_AT }))).toThrow(
      /expired envelope/i
    );
  });

  it("names the offending claim and both timestamps so the refusal is diagnosable", () => {
    try {
      parseSettlementManifest(manifest({ envelopeExpiresAt: EXPIRED_AT }));
      throw new Error("expected a throw");
    } catch (error) {
      const m = (error as Error).message;
      expect(m).toContain("6812b9ab-3b50-4866-8e0c-f5f625e72765");
      expect(m).toContain(EXPIRED_AT);
      expect(m).toContain(GENERATED_AT);
    }
  });

  it("ACCEPTS a row whose envelope is still valid at generation time", () => {
    expect(() =>
      parseSettlementManifest(manifest({ envelopeExpiresAt: STILL_VALID_AT }))
    ).not.toThrow();
  });

  it("ACCEPTS a row with no envelopeExpiresAt (backwards compatible)", () => {
    expect(() => parseSettlementManifest(manifest({}))).not.toThrow();
  });

  it("rejects a non-string envelopeExpiresAt", () => {
    expect(() => parseSettlementManifest(manifest({ envelopeExpiresAt: 12345 }))).toThrow(
      /envelopeExpiresAt/i
    );
  });

  it("rejects an unparseable envelopeExpiresAt rather than silently ignoring it", () => {
    expect(() =>
      parseSettlementManifest(manifest({ envelopeExpiresAt: "not-a-timestamp" }))
    ).toThrow(/envelopeExpiresAt/i);
  });

  it("treats expiry exactly at generatedAt as expired (boundary fails closed)", () => {
    expect(() =>
      parseSettlementManifest(manifest({ envelopeExpiresAt: GENERATED_AT }))
    ).toThrow(/expired envelope/i);
  });
});
