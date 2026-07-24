import { describe, it, expect } from "vitest";
import {
  establishTip,
  reconcileUnit,
  ArmReconcileNodeStale,
  ArmReconcileIndexerStale,
  INDEXER_CATCHUP_TOLERANCE,
} from "../src/reconcile.js";
import { noteStringFor } from "../src/intent.js";
import { freshChain, mockAlgod, mockIndexer } from "./mocks.js";
import { FRY3_ASA, type SendUnit } from "../src/types.js";

const HOT = "H".repeat(58);
const RECV = "R".repeat(58);
const unit: SendUnit = {
  deviceId: "d1",
  address: RECV,
  asaId: FRY3_ASA,
  amountBase: 100n,
  intentId: "abc123",
};

describe("tip/liveness gate (R14.5.3)", () => {
  it("caught-up indexer passes", async () => {
    const c = freshChain({ tip: 1000, indexerRound: 999 }); // within tolerance
    const t = await establishTip(mockAlgod(c, HOT), mockIndexer(c));
    expect(t.algodTip).toBe(1000);
  });

  it("BLOCKER arm-reconcile-node-stale when no tip", async () => {
    const c = freshChain({ tip: 0 });
    await expect(establishTip(mockAlgod(c, HOT), mockIndexer(c))).rejects.toBeInstanceOf(ArmReconcileNodeStale);
  });

  it("BLOCKER arm-reconcile-indexer-stale when indexer behind tip", async () => {
    const c = freshChain({ tip: 1000, indexerRound: 1000 - INDEXER_CATCHUP_TOLERANCE - 1 });
    await expect(establishTip(mockAlgod(c, HOT), mockIndexer(c))).rejects.toBeInstanceOf(ArmReconcileIndexerStale);
  });
});

describe("reconcile full-tuple (R14.5.3)", () => {
  it("committed exact-tuple match → committed", async () => {
    const c = freshChain();
    c.committed.set(noteStringFor(unit.intentId), {
      sender: HOT,
      receiver: RECV,
      assetId: FRY3_ASA,
      amount: 100n,
      txid: "TXC",
    });
    const r = await reconcileUnit(unit, HOT, mockAlgod(c, HOT), mockIndexer(c));
    expect(r).toEqual({ committed: true, pending: false, txid: "TXC" });
  });

  it("note hit but WRONG amount → throws (never skip on note-alone)", async () => {
    const c = freshChain();
    c.committed.set(noteStringFor(unit.intentId), {
      sender: HOT,
      receiver: RECV,
      assetId: FRY3_ASA,
      amount: 999n, // wrong amount
      txid: "TXbad",
    });
    await expect(reconcileUnit(unit, HOT, mockAlgod(c, HOT), mockIndexer(c))).rejects.toThrow(/WRONG amount/);
  });

  it("wrong sender → not a match (indexer filter enforces sender)", async () => {
    const c = freshChain();
    c.committed.set(noteStringFor(unit.intentId), {
      sender: "X".repeat(58),
      receiver: RECV,
      assetId: FRY3_ASA,
      amount: 100n,
      txid: "TXx",
    });
    const r = await reconcileUnit(unit, HOT, mockAlgod(c, HOT), mockIndexer(c));
    expect(r.committed).toBe(false);
  });

  it("pending-pool note match → pending", async () => {
    const c = freshChain();
    c.pending.set(HOT, [noteStringFor(unit.intentId)]);
    const r = await reconcileUnit(unit, HOT, mockAlgod(c, HOT), mockIndexer(c));
    expect(r.pending).toBe(true);
    expect(r.committed).toBe(false);
  });

  it("nothing on chain / pending → none", async () => {
    const c = freshChain();
    const r = await reconcileUnit(unit, HOT, mockAlgod(c, HOT), mockIndexer(c));
    expect(r).toEqual({ committed: false, pending: false, txid: null });
  });
});
