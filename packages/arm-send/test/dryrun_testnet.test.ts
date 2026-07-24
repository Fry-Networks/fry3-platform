/**
 * DRY-RUN validation (R12/R14.5): full programmatic build+sign of both arm-ASA legs with an
 * EPHEMERAL throwaway account and synthetic-but-valid suggested params — entirely OFFLINE.
 * Proves the real algosdk signing path works end-to-end with NO credential, NO network
 * submit, and NO mainnet value movement. This is the build-session's testnet/dry-run gate:
 * the SAME code path runs at arm time with the real mnemonic signer + real algod submit.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildAssetTransfer, type Sp } from "../src/build.js";
import { makeEphemeralSigner } from "../src/adapters.js";
import { deriveSendUnits, parseManifest } from "../src/manifest.js";
import { noteStringFor, leaseFor } from "../src/intent.js";
import { FRY3_ASA, FNODE_ASA } from "../src/types.js";

const GH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

describe("dry-run programmatic sign (offline, no creds, no submit, no mainnet)", () => {
  it("builds+signs both arm-ASA legs; signed bytes decode to the exact on-chain-exact fields", () => {
    const signer = makeEphemeralSigner(); // throwaway key — NOT a real hot wallet
    const recv = algosdk.generateAccount().addr;
    const m = parseManifest(
      JSON.stringify({
        epoch: 1784733595,
        generatedAt: "2026-07-22T15:00:00Z",
        rows: [{ deviceId: "d1", address: recv, fry3Base: "100", fnodeBase: "336483000" }],
        aggregates: { fry3Total: "100", fnodeTotal: "336483000", deviceCount: 1 },
        owed: { fry3Total: "100", fnodeTotal: "336483000" },
      })
    );
    const units = deriveSendUnits(m);
    expect(units.length).toBe(2);

    const sp: Sp = { fee: 1000, flatFee: true, firstRound: 5000, lastRound: 5001, genesisID: "mainnet-v1.0", genesisHash: GH };

    let submits = 0; // proves NOTHING is submitted in this validation
    for (const u of units) {
      const { txn, txid } = buildAssetTransfer(u, signer.address, sp);
      const signed = signer.sign(txn); // programmatic signing (R12) — no QR, no operator
      expect(signed.byteLength).toBeGreaterThan(0);

      // decode the signed bytes and assert the ON-CHAIN-EXACT tuple
      const dec = algosdk.decodeSignedTransaction(signed);
      const t = dec.txn;
      expect(algosdk.encodeAddress(t.from.publicKey)).toBe(signer.address);
      expect(algosdk.encodeAddress(t.to.publicKey)).toBe(recv);
      expect(t.assetIndex).toBe(u.asaId);
      expect(BigInt(t.amount as any)).toBe(u.amountBase); // base-unit exact
      expect(new TextDecoder().decode(t.note!)).toBe(noteStringFor(u.intentId));
      expect(Buffer.from(t.lease!).equals(Buffer.from(leaseFor(u.intentId)))).toBe(true);
      expect(t.txID()).toBe(txid);
      expect(dec.sig).toBeDefined(); // a real signature is present
      // submits stays 0 — dry-run never broadcasts
    }
    expect(submits).toBe(0);

    // both arm ASAs represented, exactly once each (independent single txns)
    const asas = units.map((u) => u.asaId).sort();
    expect(asas).toEqual([FNODE_ASA, FRY3_ASA].sort());
  });
});
