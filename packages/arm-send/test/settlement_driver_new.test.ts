import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeSkSigner } from "../src/adapters.js";
import {
  MAINNET_NETWORK,
  MainnetGateError,
  REQUIRED_MAINNET_PREDICATES,
  runSettlementDriver,
  signMainnetSafetyGate,
  type MainnetSafetyGate,
} from "../src/driver.js";
import { noteStringFor } from "../src/intent.js";
import {
  deriveSettlementUnits,
  parseSettlementManifest,
  settlementManifestSha256,
} from "../src/settlement.js";
import type { AlgodLike } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T04:30:00.000Z";
const EXPIRES = "2026-07-24T04:35:00.000Z";
const TFRY_ASA = 2681521901;

function manifestRaw(payer: string, receiver: string) {
  return JSON.stringify({
    version: 1,
    batchId: "p9final_1784868963",
    network: "mainnet",
    payer,
    generatedAt: NOW,
    rows: [
      {
        claimId: "6812b9ab-3b50-4866-8e0c-f5f625e72765",
        address: receiver,
        asaId: TFRY_ASA,
        amountBase: "11",
      },
    ],
    exclusions: [
      {
        claimId: "c9c5ba35-92a9-496a-83ef-f83cf69cd8ed",
        resolution: "duplicate-exact-payment",
        requestedBase: "216321000",
        canonicalTxid: "5Z37MVY5INQGCWIVY6V2KAYOOHIMBSWZAMVKFM5TQ4URA7CCJDUA",
        evidenceTxids: [
          "5Z37MVY5INQGCWIVY6V2KAYOOHIMBSWZAMVKFM5TQ4URA7CCJDUA",
          "4ZUHEVEWY6AER5SLHGTNK3SBV3F7LROX3DMOZ7WXBAXOCXMQPKVQ",
        ],
      },
    ],
    aggregateBase: "11",
  });
}

function safetyGate(
  raw: string,
  signer: { addr: string; sk: Uint8Array }
): MainnetSafetyGate {
  return signMainnetSafetyGate(
    {
      version: 1,
      runId: "p9final_1784868963",
      batchId: "p9final_1784868963",
      manifestSha256: settlementManifestSha256(raw),
      observedAt: NOW,
      expiresAt: EXPIRES,
      predicates: Object.fromEntries(
        REQUIRED_MAINNET_PREDICATES.map((name) => [name, true])
      ) as MainnetSafetyGate["predicates"],
    },
    signer.addr,
    signer.sk
  );
}

const passThroughGuard = {
  async runExclusive<T>(
    _reservation: unknown,
    action: () => Promise<T>
  ): Promise<T> {
    return action();
  },
};

function setup() {
  const payer = algosdk.generateAccount();
  const receiver = algosdk.generateAccount();
  const raw = manifestRaw(payer.addr, receiver.addr);
  const chain = freshChain();
  chain.hotHoldings.set(TFRY_ASA, 11n);
  chain.recvHoldings.set(`${receiver.addr}:${TFRY_ASA}`, 0n);
  const settlementUnit = deriveSettlementUnits(parseSettlementManifest(raw))[0]!;
  const baseAlgod = mockAlgod(chain, payer.addr);
  const baseSuggestedParams = baseAlgod.suggestedParams.bind(baseAlgod);
  const algod = Object.assign(baseAlgod, {
    pendingTupleMode: "full" as const,
    async suggestedParams() {
      const params = await baseSuggestedParams();
      return { ...params, lastRound: params.firstRound + 1000 };
    },
    async submit(signed: Uint8Array) {
      chain.submitted += 1;
      return algosdk.decodeSignedTransaction(signed).txn.txID().toString();
    },
    async waitForConfirmation(txid: string) {
      chain.committed.set(
        noteStringFor(settlementUnit.intentId, settlementUnit.intentDomain),
        {
          sender: payer.addr,
          receiver: receiver.addr,
          assetId: TFRY_ASA,
          amount: 11n,
          txid,
        }
      );
    },
  }) as AlgodLike;
  return {
    payer,
    receiver,
    raw,
    chain,
    algod,
    indexer: Object.assign(mockIndexer(chain), {
      async networkIdentity() {
        return MAINNET_NETWORK;
      },
    }),
    signer: makeSkSigner(payer.addr, payer.sk),
    store: new MemLedger(),
  };
}

describe("composed settlement driver", () => {
  it("refuses mainnet before chain or ledger access when a gate predicate is false", async () => {
    const state = setup();
    let statusCalls = 0;
    const algod = {
      ...state.algod,
      async status() {
        statusCalls += 1;
        return state.algod.status();
      },
    } as AlgodLike;
    const gate = safetyGate(state.raw, state.payer);
    gate.predicates.exactClaimResolution = false;

    await expect(
      runSettlementDriver({
        manifestRaw: state.raw,
        expectedManifestSha256: settlementManifestSha256(state.raw),
        gate,
        network: "mainnet",
        dryRun: false,
        payerAddress: state.payer.addr,
        store: state.store,
        algod,
        indexer: state.indexer,
        signer: state.signer,
        productionGuard: passThroughGuard,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(MainnetGateError);

    expect(statusCalls).toBe(0);
    expect(state.store.records).toHaveLength(0);
    expect(state.chain.submitted).toBe(0);
  });

  it("refuses changed manifest hash and note-only pending adapters", async () => {
    const state = setup();
    const gate = safetyGate(state.raw, state.payer);

    await expect(
      runSettlementDriver({
        manifestRaw: state.raw,
        expectedManifestSha256: "0".repeat(64),
        gate,
        network: "mainnet",
        dryRun: false,
        payerAddress: state.payer.addr,
        store: state.store,
        algod: state.algod,
        indexer: state.indexer,
        signer: state.signer,
        productionGuard: passThroughGuard,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(MainnetGateError);

    const noteOnly = mockAlgod(state.chain, state.payer.addr);
    await expect(
      runSettlementDriver({
        manifestRaw: state.raw,
        expectedManifestSha256: settlementManifestSha256(state.raw),
        gate,
        network: "mainnet",
        dryRun: false,
        payerAddress: state.payer.addr,
        store: state.store,
        algod: noteOnly,
        indexer: state.indexer,
        signer: state.signer,
        productionGuard: passThroughGuard,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(MainnetGateError);

    expect(state.store.records).toHaveLength(0);
    expect(state.chain.submitted).toBe(0);
  });

  it("dry-runs full composed tFRY path with zero submit", async () => {
    const state = setup();
    const result = await runSettlementDriver({
      manifestRaw: state.raw,
      expectedManifestSha256: settlementManifestSha256(state.raw),
      gate: safetyGate(state.raw, state.payer),
      network: "mainnet",
      dryRun: true,
      payerAddress: state.payer.addr,
      store: state.store,
      algod: state.algod,
      indexer: state.indexer,
      signer: state.signer,
      productionGuard: passThroughGuard,
      now: NOW,
    });

    expect(result.manifestSha256).toBe(settlementManifestSha256(state.raw));
    expect(result.batch.outcomes[0]?.outcome.status).toBe("dry-run");
    expect(result.batch.remainingAsserted).toContainEqual({
      asaId: TFRY_ASA,
      remaining: 11n,
      balance: 11n,
    });
    expect(state.chain.submitted).toBe(0);
  });

  it("submits once and crash-resume short-circuits from confirmed ledger", async () => {
    const state = setup();
    const options = {
      manifestRaw: state.raw,
      expectedManifestSha256: settlementManifestSha256(state.raw),
      gate: safetyGate(state.raw, state.payer),
      network: "mainnet" as const,
      dryRun: false,
      payerAddress: state.payer.addr,
      store: state.store,
      algod: state.algod,
      indexer: state.indexer,
      signer: state.signer,
      productionGuard: passThroughGuard,
      now: NOW,
    };

    const first = await runSettlementDriver(options);
    const second = await runSettlementDriver(options);

    expect(first.batch.outcomes[0]?.outcome.status).toBe("paid");
    expect(second.batch.outcomes[0]?.outcome).toMatchObject({
      status: "skipped",
      reason: "txid-present",
    });
    expect(state.chain.submitted).toBe(1);
    expect(state.store.records.map((record) => record.phase)).toEqual([
      "intent",
      "confirm",
    ]);
    expect(
      state.store.records.every(
        (record) =>
          record.batchId === "p9final_1784868963" &&
          record.intentDomain === "settlement"
      )
    ).toBe(true);
  });


  it("rejects mainnet algod configured for another genesis", async () => {
    const state = setup();
    const algod = {
      ...state.algod,
      async suggestedParams() {
        const params = await state.algod.suggestedParams();
        return { ...params, genesisID: "testnet-v1.0" };
      },
    } as AlgodLike;

    await expect(
      runSettlementDriver({
        manifestRaw: state.raw,
        expectedManifestSha256: settlementManifestSha256(state.raw),
        gate: safetyGate(state.raw, state.payer),
        network: "mainnet",
        dryRun: true,
        payerAddress: state.payer.addr,
        store: state.store,
        algod,
        indexer: state.indexer,
        signer: state.signer,
        productionGuard: passThroughGuard,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(MainnetGateError);
    expect(state.chain.submitted).toBe(0);
  });
});
