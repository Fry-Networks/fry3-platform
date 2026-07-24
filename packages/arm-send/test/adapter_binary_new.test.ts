import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeAlgod } from "../src/adapters.js";
import { buildAssetTransfer } from "../src/build.js";
import { FRY3_ASA, type SendUnit } from "../src/types.js";

const SENDER = algosdk.generateAccount().addr;
const RECEIVER = algosdk.generateAccount().addr;
const UNIT: SendUnit = {
  deviceId: "pending-binary",
  address: RECEIVER,
  asaId: FRY3_ASA,
  amountBase: 7n,
  intentId: "9".repeat(64),
};

it("reconstructs a pending txid when every REST binary field is base64", async () => {
  const built = buildAssetTransfer(UNIT, SENDER, {
    fee: 1000,
    flatFee: true,
    firstRound: 5000,
    lastRound: 6000,
    genesisID: "mainnet-v1.0",
    genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  });
  const transaction = built.txn.get_obj_for_encoding() as unknown as Record<
    string,
    unknown
  >;
  for (const field of ["snd", "arcv", "note", "lx", "gh"] as const) {
    const value = transaction[field];
    if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value))
      throw new Error(`fixture field ${field} is not binary`);
    transaction[field] = Buffer.from(value).toString("base64");
  }
  const client = {
    pendingTransactionByAddress() {
      return {
        async do() {
          return { "top-transactions": [{ txn: { txn: transaction } }] };
        },
      };
    },
  };

  const [pending] = await makeAlgod(client as any).pendingFromSender(SENDER);

  expect(pending?.txid).toBe(built.txid);
});
