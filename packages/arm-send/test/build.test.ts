import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildAssetTransfer, type Sp } from "../src/build.js";
import { computeIntentId, noteStringFor, leaseFor } from "../src/intent.js";
import { FRY3_ASA, FNODE_ASA, VALIDITY_WINDOW_ROUNDS, type SendUnit } from "../src/types.js";

const GH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="; // mainnet genesis hash (b64)
const HOT = algosdk.generateAccount().addr;
const RECV = algosdk.generateAccount().addr;
const sp: Sp = { fee: 1000, flatFee: true, firstRound: 5000, lastRound: 5001, genesisID: "mainnet-v1.0", genesisHash: GH };

function mkUnit(over: Partial<SendUnit> = {}): SendUnit {
  const asaId = over.asaId ?? FRY3_ASA;
  const amountBase = over.amountBase ?? 336483000n;
  const deviceId = over.deviceId ?? "d1";
  return {
    deviceId,
    address: over.address ?? RECV,
    asaId,
    amountBase,
    intentId: over.intentId ?? computeIntentId(deviceId, asaId, amountBase, 1784733595),
  };
}

describe("buildAssetTransfer (R14.5.2/6 — real algosdk txn)", () => {
  it("carries exact note + 32-byte lease + base-unit amount + long window", () => {
    const u = mkUnit();
    const { txn, txid } = buildAssetTransfer(u, HOT, sp);
    expect(new TextDecoder().decode(txn.note!)).toBe(noteStringFor(u.intentId));
    expect(txn.lease!.length).toBe(32);
    expect(Buffer.from(txn.lease!).equals(Buffer.from(leaseFor(u.intentId)))).toBe(true);
    expect(BigInt(txn.amount as any)).toBe(336483000n); // exact base units
    expect(txn.assetIndex).toBe(FRY3_ASA);
    expect(txn.lastRound - txn.firstRound).toBe(VALIDITY_WINDOW_ROUNDS); // ~1000-round window
    expect(txn.flatFee).toBe(true);
    expect(txid).toMatch(/^[A-Z2-7]{52}$/); // canonical Algorand txid
  });

  it("txID is deterministic for identical (unit, params) — same lease/note/amount/rounds", () => {
    const u = mkUnit();
    expect(buildAssetTransfer(u, HOT, sp).txid).toBe(buildAssetTransfer(u, HOT, sp).txid);
  });

  it("FRY3 and fNODE build with distinct asset indexes (independent per-ASA txns)", () => {
    const f = buildAssetTransfer(mkUnit({ asaId: FRY3_ASA }), HOT, sp);
    const n = buildAssetTransfer(mkUnit({ asaId: FNODE_ASA }), HOT, sp);
    expect(f.txn.assetIndex).toBe(FRY3_ASA);
    expect(n.txn.assetIndex).toBe(FNODE_ASA);
    expect(f.txn.type).toBe("axfer");
    // not grouped
    expect(f.txn.group).toBeUndefined();
    expect(n.txn.group).toBeUndefined();
  });
});
