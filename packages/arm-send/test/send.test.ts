import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { runSendBatch, ArmSigningAuthaddrMismatch } from "../src/send.js";
import { ArmSanityFailed } from "../src/manifest.js";
import { makeSkSigner } from "../src/adapters.js";
import { noteStringFor } from "../src/intent.js";
import { deriveSendUnits, parseManifest } from "../src/manifest.js";
import { FRY3_ASA, FNODE_ASA, type SendUnit, type AlgodLike } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer, type MockChain } from "./mocks.js";

const NOW = "2026-07-22T15:00:00Z";

function acct() {
  const a = algosdk.generateAccount();
  return { addr: a.addr, sk: a.sk };
}

function setup() {
  const hot = acct();
  const r1 = algosdk.generateAccount().addr;
  const r2 = algosdk.generateAccount().addr;
  const signer = makeSkSigner(hot.addr, hot.sk);
  const m = parseManifest(
    JSON.stringify({
      epoch: 1784733595,
      generatedAt: NOW,
      rows: [
        { deviceId: "d1", address: r1, fry3Base: "100", fnodeBase: "200" },
        { deviceId: "d2", address: r2, fry3Base: "50", fnodeBase: "0" },
      ],
      aggregates: { fry3Total: "150", fnodeTotal: "200", deviceCount: 2 },
      owed: { fry3Total: "150", fnodeTotal: "200" },
    })
  );
  const units = deriveSendUnits(m); // d1-fry3, d1-fnode, d2-fry3
  const c = freshChain();
  c.hotHoldings.set(FRY3_ASA, 1000n);
  c.hotHoldings.set(FNODE_ASA, 1000n);
  c.recvHoldings.set(`${r1}:${FRY3_ASA}`, 0n);
  c.recvHoldings.set(`${r1}:${FNODE_ASA}`, 0n);
  c.recvHoldings.set(`${r2}:${FRY3_ASA}`, 0n);
  return { hot, r1, r2, signer, units, c };
}

function base(over: Partial<Parameters<typeof runSendBatch>[0]>, s = setup()) {
  const store = new MemLedger();
  return {
    s,
    store,
    opts: {
      units: s.units,
      hotWallet: s.hot.addr,
      store,
      algod: mockAlgod(s.c, s.hot.addr),
      indexer: mockIndexer(s.c),
      signer: s.signer,
      dryRun: true,
      now: NOW,
      ...over,
    } as Parameters<typeof runSendBatch>[0],
  };
}

describe("runSendBatch orchestration (R14.5)", () => {
  it("dry-run: builds+signs, writes intent BEFORE submit, NEVER submits", async () => {
    const { s, store, opts } = base({ dryRun: true });
    const res = await runSendBatch(opts);
    expect(res.outcomes.every((o) => o.outcome.status === "dry-run")).toBe(true);
    expect(s.c.submitted).toBe(0); // NO mainnet/testnet submit
    // intent records written for all 3 units; NO confirm records (nothing on chain)
    const recs = store.records;
    expect(recs.filter((r) => r.phase === "intent").length).toBe(3);
    expect(recs.filter((r) => r.phase === "confirm").length).toBe(0);
    expect(res.failedSet.length).toBe(0);
  });

  it("live: submits each independent per-ASA txn, appends intent+confirm", async () => {
    const { s, store, opts } = base({ dryRun: false });
    const res = await runSendBatch(opts);
    expect(res.outcomes.every((o) => o.outcome.status === "paid")).toBe(true);
    expect(s.c.submitted).toBe(3);
    expect(store.records.filter((r) => r.phase === "confirm").length).toBe(3);
  });

  it("resume: txid already in ledger → SKIP, no resubmit, no indexer call", async () => {
    const built = base({ dryRun: false });
    // pre-seed a confirm for the first unit's intent
    const u0 = built.s.units[0];
    await built.store.append({
      intentId: u0.intentId, deviceId: u0.deviceId, address: u0.address, asaId: u0.asaId,
      amountBase: u0.amountBase.toString(), armEpoch: 0, phase: "confirm", txid: "TXPRE", ts: NOW,
    });
    const res = await runSendBatch(built.opts);
    const o0 = res.outcomes.find((o) => o.unit.intentId === u0.intentId)!;
    expect(o0.outcome.status).toBe("skipped");
    expect(built.s.c.submitted).toBe(2); // only the other two sent
  });

  it("resume: intent written, committed on chain → SKIP + backfill txid (no double-pay)", async () => {
    const built = base({ dryRun: false });
    const u0 = built.s.units[0];
    await built.store.append({
      intentId: u0.intentId, deviceId: u0.deviceId, address: u0.address, asaId: u0.asaId,
      amountBase: u0.amountBase.toString(), armEpoch: 0, phase: "intent", ts: NOW,
    });
    built.s.c.committed.set(noteStringFor(u0.intentId), {
      sender: built.s.hot.addr, receiver: u0.address, assetId: u0.asaId, amount: u0.amountBase, txid: "TXCHAIN",
    });
    const res = await runSendBatch(built.opts);
    const o0 = res.outcomes.find((o) => o.unit.intentId === u0.intentId)!;
    expect(o0.outcome).toMatchObject({ status: "skipped", txid: "TXCHAIN" });
    expect(built.s.c.submitted).toBe(2); // NOT resubmitted
    // a confirm was backfilled for the committed intent
    expect(built.store.records.some((r) => r.intentId === u0.intentId && r.phase === "confirm" && r.txid === "TXCHAIN")).toBe(true);
  });

  it("resume: intent written, NOT on chain, NOT pending → RESEND same", async () => {
    const built = base({ dryRun: false });
    const u0 = built.s.units[0];
    await built.store.append({
      intentId: u0.intentId, deviceId: u0.deviceId, address: u0.address, asaId: u0.asaId,
      amountBase: u0.amountBase.toString(), armEpoch: 0, phase: "intent", ts: NOW,
    });
    const res = await runSendBatch(built.opts);
    const o0 = res.outcomes.find((o) => o.unit.intentId === u0.intentId)!;
    expect(o0.outcome.status).toBe("paid"); // resent
    expect(built.s.c.submitted).toBe(3);
  });

  it("opt-in: recipient not opted in → recipient-not-opted-in, never fabricated as paid; per-ASA partial", async () => {
    const s = setup();
    // remove d1's fNODE opt-in only → d1-fry3 pays, d1-fnode fails, d2-fry3 pays
    s.c.recvHoldings.delete(`${s.r1}:${FNODE_ASA}`);
    const built = base({ dryRun: false }, s);
    const res = await runSendBatch(built.opts);
    const fnodeLeg = res.outcomes.find((o) => o.unit.asaId === FNODE_ASA)!;
    expect(fnodeLeg.outcome).toMatchObject({ status: "failed", reason: "recipient-not-opted-in" });
    expect(res.outcomes.filter((o) => o.outcome.status === "paid").length).toBe(2);
    expect(res.failedSet.some((f) => f.reason === "recipient-not-opted-in")).toBe(true);
    expect(s.c.submitted).toBe(2);
  });

  it("BLOCKER arm-signing-authaddr-mismatch when on-chain auth-addr != signing key", async () => {
    const s = setup();
    s.c.authAddr = algosdk.generateAccount().addr; // rekeyed away
    const built = base({ dryRun: false }, s);
    await expect(runSendBatch(built.opts)).rejects.toBeInstanceOf(ArmSigningAuthaddrMismatch);
  });

  it("BLOCKER when signer address != hot wallet", async () => {
    const s = setup();
    const other = algosdk.generateAccount();
    const built = base({ dryRun: false, signer: makeSkSigner(other.addr, other.sk) }, s);
    await expect(runSendBatch(built.opts)).rejects.toBeInstanceOf(ArmSigningAuthaddrMismatch);
  });

  it("BLOCKER arm-sanity-failed when hot-wallet ASA balance < REMAINING", async () => {
    const s = setup();
    s.c.hotHoldings.set(FRY3_ASA, 10n); // < 150 remaining fry3
    const built = base({ dryRun: false }, s);
    await expect(runSendBatch(built.opts)).rejects.toBeInstanceOf(ArmSanityFailed);
  });

  it("BLOCKER arm-sanity-failed when ALGO fee budget insufficient", async () => {
    const s = setup();
    s.c.algoMicro = 100n; // < minFee(1000) × 3
    const built = base({ dryRun: false }, s);
    await expect(runSendBatch(built.opts)).rejects.toBeInstanceOf(ArmSanityFailed);
  });

  it("crash-safety: submit throws → intent persisted, NO confirm, classified failed; resume resends (no double)", async () => {
    const s = setup();
    const throwingAlgod: AlgodLike = { ...mockAlgod(s.c, s.hot.addr), async submit() { throw new Error("network ECONNREFUSED"); } };
    const store = new MemLedger();
    const opts1 = {
      units: s.units, hotWallet: s.hot.addr, store, algod: throwingAlgod,
      indexer: mockIndexer(s.c), signer: s.signer, dryRun: false, now: NOW,
    } as Parameters<typeof runSendBatch>[0];
    const r1 = await runSendBatch(opts1);
    expect(r1.outcomes.every((o) => o.outcome.status === "failed")).toBe(true);
    expect(r1.failedSet.every((f) => f.reason === "network")).toBe(true);
    // intent lines written (before the failed submit); zero confirms
    expect(store.records.filter((x) => x.phase === "intent").length).toBe(3);
    expect(store.records.filter((x) => x.phase === "confirm").length).toBe(0);
    // resume with a WORKING node — nothing committed on chain → RESEND_SAME, now succeeds, exactly once each
    const r2 = await runSendBatch({ ...opts1, algod: mockAlgod(s.c, s.hot.addr) } as any);
    expect(r2.outcomes.every((o) => o.outcome.status === "paid")).toBe(true);
    expect(s.c.submitted).toBe(3); // exactly 3 total submits across both runs (no double)
  });
});
