import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeAlgod } from "../src/adapters.js";
import { buildAssetTransfer } from "../src/build.js";
import { FRY3_ASA, type SendUnit } from "../src/types.js";

const SENDER = algosdk.generateAccount().addr;
const RECEIVER = algosdk.generateAccount().addr;
const UNIT: SendUnit = {
  deviceId: "pending-adapter",
  address: RECEIVER,
  asaId: FRY3_ASA,
  amountBase: 23n,
  intentId: "c".repeat(64),
};

describe("live pending adapter", () => {
  it("returns txid and full tuple from nested pending signed transaction", async () => {
    const built = buildAssetTransfer(UNIT, SENDER, {
      fee: 1000,
      flatFee: true,
      firstRound: 5000,
      lastRound: 5001,
      genesisID: "mainnet-v1.0",
      genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    });
    const client = {
      pendingTransactionByAddress() {
        return {
          async do() {
            return {
              "top-transactions": [
                { txn: { txn: built.txn.get_obj_for_encoding() } },
              ],
            };
          },
        };
      },
    };
    const algod = makeAlgod(client as any);

    const pending = await algod.pendingFromSender(SENDER);

    expect(algod.pendingTupleMode).toBe("full");
    expect(pending).toEqual([
      {
        txid: built.txid,
        note: `fry3-arm:v1:${UNIT.intentId}`,
        sender: SENDER,
        receiver: RECEIVER,
        assetId: FRY3_ASA,
        amount: 23n,
      },
    ]);
  });
});
