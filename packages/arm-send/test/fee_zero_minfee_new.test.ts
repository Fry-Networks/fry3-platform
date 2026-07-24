import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeSkSigner } from "../src/adapters.js";
import { runSendBatch } from "../src/send.js";
import { FRY3_ASA, type AlgodLike, type SendUnit } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T20:55:00.000Z";

describe("live algod fee=0 minFee budgeting", () => {
  it("accepts suggested fee 0 when minFee is the positive network floor", async () => {
    const payer = algosdk.generateAccount();
    const receiver = algosdk.generateAccount();
    const chain = freshChain({ algoMicro: 2_000_000n, minFee: 1000 });
    chain.hotHoldings.set(FRY3_ASA, 1n);
    chain.recvHoldings.set(`${receiver.addr}:${FRY3_ASA}`, 0n);
    const unit: SendUnit = {
      deviceId: "fee-zero",
      address: receiver.addr,
      asaId: FRY3_ASA,
      amountBase: 1n,
      intentId: "f".repeat(64),
    };
    const base = mockAlgod(chain, payer.addr);
    const algod = {
      ...base,
      async suggestedParams() {
        const params = await base.suggestedParams();
        // Live mainnet algod commonly returns fee=0 with min-fee=1000.
        return { ...params, fee: 0, minFee: 1000, flatFee: false };
      },
    } as AlgodLike;

    const result = await runSendBatch({
      units: [unit],
      hotWallet: payer.addr,
      store: new MemLedger(),
      algod,
      indexer: mockIndexer(chain),
      signer: makeSkSigner(payer.addr, payer.sk),
      dryRun: true,
      now: NOW,
      algoHeadroomMicro: 0n,
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.outcome.status).toBe("dry-run");
  });
});
