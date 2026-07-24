import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeSkSigner } from "../src/adapters.js";
import { ArmSanityFailed } from "../src/manifest.js";
import { runSendBatch } from "../src/send.js";
import { FRY3_ASA, type AlgodLike, type SendUnit } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T04:30:00.000Z";

describe("ALGO minimum-balance headroom", () => {
  it("uses spendable amount after minimum balance, not total account amount", async () => {
    const payer = algosdk.generateAccount();
    const receiver = algosdk.generateAccount();
    const unit: SendUnit = {
      deviceId: "min-balance",
      address: receiver.addr,
      asaId: FRY3_ASA,
      amountBase: 1n,
      intentId: "d".repeat(64),
    };
    const chain = freshChain({ algoMicro: 10_000n, minFee: 1000 });
    chain.hotHoldings.set(FRY3_ASA, 1n);
    chain.recvHoldings.set(`${receiver.addr}:${FRY3_ASA}`, 0n);
    const base = mockAlgod(chain, payer.addr);
    const algod = {
      ...base,
      async accountInfo(address: string) {
        const account = await base.accountInfo(address);
        return { ...account, minBalance: 9_500n };
      },
    } as AlgodLike;

    await expect(
      runSendBatch({
        units: [unit],
        hotWallet: payer.addr,
        store: new MemLedger(),
        algod,
        indexer: mockIndexer(chain),
        signer: makeSkSigner(payer.addr, payer.sk),
        dryRun: true,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(ArmSanityFailed);
  });
});
