import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeAlgod, makeIndexer } from "../src/adapters.js";
import { buildAssetTransfer } from "../src/build.js";
import { FRY3_ASA, type SendUnit } from "../src/types.js";

const SENDER = algosdk.generateAccount().addr;
const RECEIVER = algosdk.generateAccount().addr;
const OTHER = algosdk.generateAccount().addr;
const UNIT: SendUnit = {
  deviceId: "adapter-security",
  address: RECEIVER,
  asaId: FRY3_ASA,
  amountBase: 23n,
  intentId: "e".repeat(64),
};

function encodedTransaction() {
  return buildAssetTransfer(UNIT, SENDER, {
    fee: 1000,
    flatFee: true,
    firstRound: 5000,
    lastRound: 6000,
    genesisID: "mainnet-v1.0",
    genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  }).txn.get_obj_for_encoding() as unknown as Record<string, unknown>;
}

describe("live adapter payment tuple validation", () => {
  it("decodes base64 sender and receiver keys from pending REST payloads", async () => {
    const transaction = encodedTransaction() as any;
    transaction.snd = Buffer.from(transaction.snd).toString("base64");
    transaction.arcv = Buffer.from(transaction.arcv).toString("base64");
    const client = {
      pendingTransactionByAddress() {
        return { async do() { return { "top-transactions": [{ txn: { txn: transaction } }] }; } };
      },
    };

    const [pending] = await makeAlgod(client as any).pendingFromSender(SENDER);

    expect(pending).toMatchObject({ sender: SENDER, receiver: RECEIVER });
  });

  it("rejects unsafe numeric pending amounts instead of converting rounded values", async () => {
    const transaction = encodedTransaction() as any;
    transaction.aamt = Number.MAX_SAFE_INTEGER + 1;
    const client = {
      pendingTransactionByAddress() {
        return { async do() { return { "top-transactions": [{ txn: { txn: transaction } }] }; } };
      },
    };

    await expect(
      makeAlgod(client as any).pendingFromSender(SENDER)
    ).rejects.toThrow(/safe integer|exact integer/);
  });

  it("rejects algod submit responses without a transaction id", async () => {
    const client = {
      sendRawTransaction() {
        return { async do() { return {}; } };
      },
    };

    await expect(
      makeAlgod(client as any).submit(new Uint8Array([1]))
    ).rejects.toThrow(/transaction id/);
  });

  it("discards indexer results whose actual receiver differs from query", async () => {
    const note = `fry3-arm:v1:${UNIT.intentId}`;
    const query = {
      address() { return this; },
      addressRole() { return this; },
      assetID() { return this; },
      notePrefix() { return this; },
      async do() {
        return {
          transactions: [
            {
              id: "A".repeat(52),
              sender: SENDER,
              note: Buffer.from(note).toString("base64"),
              "asset-transfer-transaction": {
                receiver: OTHER,
                "asset-id": FRY3_ASA,
                amount: "23",
              },
            },
          ],
        };
      },
    };
    const client = { searchForTransactions() { return query; } };

    const matches = await makeIndexer(client as any).findByNote({
      sender: SENDER,
      receiver: RECEIVER,
      assetId: FRY3_ASA,
      note,
    });

    expect(matches).toEqual([]);
  });
});
