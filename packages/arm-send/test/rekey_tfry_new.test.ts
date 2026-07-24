import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { MAINNET_NETWORK } from "../src/driver.js";
import { makeSkSigner } from "../src/adapters.js";
import { ArmSanityFailed } from "../src/manifest.js";
import { runSendBatch } from "../src/send.js";
import {
  FRY3_ASA,
  TFRY_ASA,
  type AlgodLike,
  type PaymentAsset,
  type SendUnit,
} from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T04:30:00.000Z";

function makeUnit(
  address: string,
  asaId: PaymentAsset,
  amountBase = 7n
): SendUnit {
  return {
    deviceId: "claim-regression",
    address,
    asaId,
    amountBase,
    intentId: "a".repeat(64),
  };
}

function fullMockAlgod(
  chain: Parameters<typeof mockAlgod>[0],
  payer: string
): AlgodLike {
  const base = mockAlgod(chain, payer);
  const baseSuggestedParams = base.suggestedParams.bind(base);
  return Object.assign(base, {
    pendingTupleMode: "full" as const,
    async suggestedParams() {
      const params = await baseSuggestedParams();
      return { ...params, lastRound: params.firstRound + 1000 };
    },
  });
}

function networkIndexer(chain: Parameters<typeof mockIndexer>[0]) {
  return Object.assign(mockIndexer(chain), {
    async networkIdentity() {
      return MAINNET_NETWORK;
    },
  });
}

describe("rekey-aware and tFRY batch safety", () => {
  it("keeps payer as transaction sender while live authAddr signs", async () => {
    const payer = algosdk.generateAccount();
    const auth = algosdk.generateAccount();
    const receiver = algosdk.generateAccount();
    const unit = makeUnit(receiver.addr, FRY3_ASA);
    const chain = freshChain({ authAddr: auth.addr });
    chain.hotHoldings.set(FRY3_ASA, unit.amountBase);
    chain.recvHoldings.set(`${receiver.addr}:${FRY3_ASA}`, 0n);
    const store = new MemLedger();

    const result = await runSendBatch({
      units: [unit],
      hotWallet: payer.addr,
      store,
      algod: fullMockAlgod(chain, payer.addr),
      indexer: networkIndexer(chain),
      signer: makeSkSigner(auth.addr, auth.sk),
      dryRun: true,
      now: NOW,
      scope: { kind: "arm", epoch: 77 },
      expectedNetwork: MAINNET_NETWORK,
    } as any);

    expect(result.outcomes[0]?.outcome.status).toBe("dry-run");
    expect(chain.submitted).toBe(0);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.armEpoch).toBe(77);
  });

  it("checks tFRY balance as part of remaining manifest", async () => {
    const payer = algosdk.generateAccount();
    const receiver = algosdk.generateAccount();
    const unit = makeUnit(receiver.addr, TFRY_ASA, 11n);
    const chain = freshChain();
    chain.hotHoldings.set(TFRY_ASA, 10n);
    chain.recvHoldings.set(`${receiver.addr}:${TFRY_ASA}`, 0n);

    await expect(
      runSendBatch({
        units: [unit],
        hotWallet: payer.addr,
        store: new MemLedger(),
        algod: fullMockAlgod(chain, payer.addr),
        indexer: networkIndexer(chain),
        signer: makeSkSigner(payer.addr, payer.sk),
        dryRun: true,
        now: NOW,
        scope: { kind: "settlement", batchId: "p9final-regression" },
        expectedNetwork: MAINNET_NETWORK,
      } as any)
    ).rejects.toBeInstanceOf(ArmSanityFailed);
  });

  it("accepts allowlisted tFRY and records settlement scope", async () => {
    const payer = algosdk.generateAccount();
    const receiver = algosdk.generateAccount();
    const unit = makeUnit(receiver.addr, TFRY_ASA, 11n);
    const chain = freshChain();
    chain.hotHoldings.set(TFRY_ASA, 11n);
    chain.recvHoldings.set(`${receiver.addr}:${TFRY_ASA}`, 0n);
    const store = new MemLedger();

    const result = await runSendBatch({
      units: [unit],
      hotWallet: payer.addr,
      store,
      algod: fullMockAlgod(chain, payer.addr),
      indexer: networkIndexer(chain),
      signer: makeSkSigner(payer.addr, payer.sk),
      dryRun: true,
      now: NOW,
      scope: { kind: "settlement", batchId: "p9final-regression" },
      expectedNetwork: MAINNET_NETWORK,
    } as any);

    expect(result.remainingAsserted).toContainEqual({
      asaId: TFRY_ASA,
      remaining: 11n,
      balance: 11n,
    });
    expect(store.records[0]).toMatchObject({
      armEpoch: 0,
      batchId: "p9final-regression",
      intentDomain: "settlement",
    });
  });
});
