import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { MAINNET_NETWORK } from "../src/driver.js";
import { makeSkSigner } from "../src/adapters.js";
import { noteStringFor } from "../src/intent.js";
import { runSendBatch } from "../src/send.js";
import { FRY3_ASA, type AlgodLike, type SendUnit } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T04:30:00.000Z";

function unit(receiver: string, suffix: string): SendUnit {
  return {
    deviceId: `scoped-${suffix}`,
    address: receiver,
    asaId: FRY3_ASA,
    amountBase: 1n,
    intentId: suffix.repeat(64),
    intentDomain: "settlement",
  };
}

function exactTxid(signed: Uint8Array): string {
  return algosdk.decodeSignedTransaction(signed).txn.txID().toString();
}

function networkIndexer(chain: ReturnType<typeof freshChain>) {
  return Object.assign(mockIndexer(chain), {
    async networkIdentity() {
      return MAINNET_NETWORK;
    },
  });
}

function setup() {
  const payer = algosdk.generateAccount();
  const receiver = algosdk.generateAccount();
  const chain = freshChain();
  chain.hotHoldings.set(FRY3_ASA, 10n);
  chain.recvHoldings.set(`${receiver.addr}:${FRY3_ASA}`, 0n);
  const raw = mockAlgod(chain, payer.addr);
  const base = {
    ...raw,
    async suggestedParams() {
      const params = await raw.suggestedParams();
      return { ...params, lastRound: params.firstRound + 1000 };
    },
  } as AlgodLike;
  return { payer, receiver, chain, base };
}

describe("scoped production send safety", () => {
  it("rejects a submit response that does not match the signed transaction id", async () => {
    const state = setup();
    const store = new MemLedger();
    const algod = {
      ...state.base,
      pendingTupleMode: "full" as const,
      async submit() { state.chain.submitted += 1; return "A".repeat(52); },
      async waitForConfirmation() {},
    } as AlgodLike;

    const result = await runSendBatch({
      units: [unit(state.receiver.addr, "a")],
      hotWallet: state.payer.addr,
      store,
      algod,
      indexer: networkIndexer(state.chain),
      signer: makeSkSigner(state.payer.addr, state.payer.sk),
      dryRun: false,
      now: NOW,
      scope: { kind: "settlement", batchId: "confirmation-check" },
      expectedNetwork: MAINNET_NETWORK,
    });

    expect(result.outcomes[0]?.outcome.status).toBe("failed");
    expect(store.records.map((record) => record.phase)).toEqual(["intent"]);
  });

  it("does not append confirmation when bounded confirmation fails", async () => {
    const state = setup();
    const store = new MemLedger();
    const algod = {
      ...state.base,
      pendingTupleMode: "full" as const,
      async submit(signed: Uint8Array) {
        state.chain.submitted += 1;
        return exactTxid(signed);
      },
      async waitForConfirmation() { throw new Error("confirmation timeout"); },
    } as AlgodLike;

    const result = await runSendBatch({
      units: [unit(state.receiver.addr, "b")],
      hotWallet: state.payer.addr,
      store,
      algod,
      indexer: networkIndexer(state.chain),
      signer: makeSkSigner(state.payer.addr, state.payer.sk),
      dryRun: false,
      now: NOW,
      scope: { kind: "settlement", batchId: "confirmation-timeout" },
      expectedNetwork: MAINNET_NETWORK,
    });

    expect(result.outcomes[0]?.outcome.status).toBe("failed");
    expect(store.records.map((record) => record.phase)).toEqual(["intent"]);
  });

  it("refuses a scoped ledger confirmation absent from caught-up chain", async () => {
    const state = setup();
    const sendUnit = unit(state.receiver.addr, "c");
    const store = new MemLedger();
    store.records.push({
      intentId: sendUnit.intentId,
      deviceId: sendUnit.deviceId,
      address: sendUnit.address,
      asaId: sendUnit.asaId,
      amountBase: sendUnit.amountBase.toString(),
      armEpoch: 0,
      batchId: "forged-ledger",
      intentDomain: "settlement",
      phase: "confirm",
      txid: "F".repeat(52),
      ts: NOW,
    });
    const algod = {
      ...state.base,
      pendingTupleMode: "full" as const,
      async waitForConfirmation() {},
    } as AlgodLike;

    await expect(
      runSendBatch({
        units: [sendUnit],
        hotWallet: state.payer.addr,
        store,
        algod,
        indexer: networkIndexer(state.chain),
        signer: makeSkSigner(state.payer.addr, state.payer.sk),
        dryRun: true,
        now: NOW,
        scope: { kind: "settlement", batchId: "forged-ledger" },
        expectedNetwork: MAINNET_NETWORK,
      })
    ).rejects.toThrow(/ledger confirmation.*chain/i);
  });

  it("refreshes algod/indexer parity before each unit reconciliation", async () => {
    const state = setup();
    const receiver2 = algosdk.generateAccount();
    state.chain.recvHoldings.set(`${receiver2.addr}:${FRY3_ASA}`, 0n);
    let statusCalls = 0;
    const algod = {
      ...state.base,
      pendingTupleMode: "full" as const,
      async status() { statusCalls += 1; return state.base.status(); },
      async waitForConfirmation() {},
    } as AlgodLike;

    await runSendBatch({
      units: [unit(state.receiver.addr, "d"), unit(receiver2.addr, "e")],
      hotWallet: state.payer.addr,
      store: new MemLedger(),
      algod,
      indexer: networkIndexer(state.chain),
      signer: makeSkSigner(state.payer.addr, state.payer.sk),
      dryRun: true,
      now: NOW,
      scope: { kind: "settlement", batchId: "freshness-check" },
      expectedNetwork: MAINNET_NETWORK,
    });

    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });
});
