import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { noteStringFor } from "../src/intent.js";
import { reconcileUnit } from "../src/reconcile.js";
import { FRY3_ASA, type AlgodLike, type SendUnit } from "../src/types.js";
import { freshChain, mockAlgod, mockIndexer } from "./mocks.js";

function setup() {
  const payer = algosdk.generateAccount();
  const receiver = algosdk.generateAccount();
  const unit: SendUnit = {
    deviceId: "pending-tuple",
    address: receiver.addr,
    asaId: FRY3_ASA,
    amountBase: 19n,
    intentId: "b".repeat(64),
  };
  const chain = freshChain();
  const base = mockAlgod(chain, payer.addr);
  return { payer, receiver, unit, chain, base };
}

function fullTupleAlgod(
  base: AlgodLike,
  pending: Record<string, unknown>
): AlgodLike {
  return {
    ...base,
    pendingTupleMode: "full",
    async pendingFromSender() {
      return [pending] as any;
    },
  } as AlgodLike;
}

describe("pending pool full-tuple reconciliation", () => {
  it("accepts exact pending sender/receiver/ASA/amount/note tuple", async () => {
    const { payer, receiver, unit, chain, base } = setup();
    const note = noteStringFor(unit.intentId);
    const algod = fullTupleAlgod(base, {
      txid: "PENDING_EXACT",
      note,
      sender: payer.addr,
      receiver: receiver.addr,
      assetId: unit.asaId,
      amount: unit.amountBase,
    });

    const result = await reconcileUnit(unit, payer.addr, algod, mockIndexer(chain));

    expect(result).toEqual({ committed: false, pending: true, txid: "PENDING_EXACT" });
  });

  const wrongCases: Array<{
    field: string;
    mutate: (tuple: Record<string, unknown>) => void;
  }> = [
    {
      field: "sender",
      mutate: (tuple) => {
        tuple.sender = algosdk.generateAccount().addr;
      },
    },
    {
      field: "receiver",
      mutate: (tuple) => {
        tuple.receiver = algosdk.generateAccount().addr;
      },
    },
    {
      field: "assetId",
      mutate: (tuple) => {
        tuple.assetId = FRY3_ASA + 1;
      },
    },
    {
      field: "amount",
      mutate: (tuple) => {
        tuple.amount = 18n;
      },
    },
  ];

  for (const wrongCase of wrongCases) {
    it(`rejects note-only pending match with wrong ${wrongCase.field}`, async () => {
      const state = setup();
      const note = noteStringFor(state.unit.intentId);
      const tuple: Record<string, unknown> = {
        txid: "PENDING_WRONG_TUPLE",
        note,
        sender: state.payer.addr,
        receiver: state.receiver.addr,
        assetId: state.unit.asaId,
        amount: state.unit.amountBase,
      };
      wrongCase.mutate(tuple);
      const algod = fullTupleAlgod(state.base, tuple);

      const result = await reconcileUnit(
        state.unit,
        state.payer.addr,
        algod,
        mockIndexer(state.chain)
      );

      expect(result).toEqual({ committed: false, pending: false, txid: null });
    });
  }
});
