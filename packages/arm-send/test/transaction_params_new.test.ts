import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeSkSigner } from "../src/adapters.js";
import { MAINNET_NETWORK } from "../src/driver.js";
import { ArmSanityFailed } from "../src/manifest.js";
import { runSendBatch } from "../src/send.js";
import { FRY3_ASA, type AlgodLike, type SendUnit } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T08:45:00.000Z";

function setup() {
  const payer = algosdk.generateAccount();
  const receiver = algosdk.generateAccount();
  const chain = freshChain();
  chain.hotHoldings.set(FRY3_ASA, 1n);
  chain.recvHoldings.set(`${receiver.addr}:${FRY3_ASA}`, 0n);
  const unit: SendUnit = {
    deviceId: "params-regression",
    address: receiver.addr,
    asaId: FRY3_ASA,
    amountBase: 1n,
    intentId: "8".repeat(64),
  };
  return { payer, receiver, chain, unit };
}

describe("transaction parameter safety", () => {
  it("budgets the actual flat transaction fee instead of lower minFee", async () => {
    const state = setup();
    state.chain.algoMicro = 1500n;
    const base = mockAlgod(state.chain, state.payer.addr);
    const algod = {
      ...base,
      async suggestedParams() {
        const params = await base.suggestedParams();
        return { ...params, fee: 2000, minFee: 1000 };
      },
    } as AlgodLike;

    await expect(
      runSendBatch({
        units: [state.unit],
        hotWallet: state.payer.addr,
        store: new MemLedger(),
        algod,
        indexer: mockIndexer(state.chain),
        signer: makeSkSigner(state.payer.addr, state.payer.sk),
        dryRun: true,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(ArmSanityFailed);
  });

  it("rejects scoped params whose validity window is shorter than required", async () => {
    const state = setup();
    const base = mockAlgod(state.chain, state.payer.addr);
    const algod = Object.assign(base, {
      pendingTupleMode: "full" as const,
    }) as AlgodLike;
    const indexer = Object.assign(mockIndexer(state.chain), {
      async networkIdentity() {
        return MAINNET_NETWORK;
      },
    });

    await expect(
      runSendBatch({
        units: [state.unit],
        hotWallet: state.payer.addr,
        store: new MemLedger(),
        algod,
        indexer,
        signer: makeSkSigner(state.payer.addr, state.payer.sk),
        dryRun: true,
        now: NOW,
        scope: { kind: "arm", epoch: 77 },
        expectedNetwork: MAINNET_NETWORK,
      })
    ).rejects.toBeInstanceOf(ArmSanityFailed);
  });
});
