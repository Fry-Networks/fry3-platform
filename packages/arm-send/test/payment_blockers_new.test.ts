import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { makeSkSigner } from "../src/adapters.js";
import {
  MainnetGateError,
  REQUIRED_MAINNET_PREDICATES,
  runSettlementDriver,
  signMainnetSafetyGate,
  type MainnetSafetyGate,
} from "../src/driver.js";
import { settlementManifestSha256 } from "../src/settlement.js";
import type { AlgodLike, IndexerLike } from "../src/types.js";
import { MemLedger, freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const NOW = "2026-07-24T07:00:00.000Z";
const EXPIRES = "2026-07-24T07:05:00.000Z";
const MAINNET = {
  genesisID: "mainnet-v1.0",
  genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
} as const;
const TESTNET = {
  genesisID: "testnet-v1.0",
  genesisHash: "SGO1GKSN5NQJHI266NCFCT4PAL4ZIUFQXQAX53NOA7A5XMGY4A6Q",
} as const;

function setup() {
  const payer = algosdk.generateAccount();
  const receiver = algosdk.generateAccount();
  const raw = JSON.stringify({
    version: 1,
    batchId: "p9final-high-blockers",
    network: "mainnet",
    payer: payer.addr,
    generatedAt: NOW,
    rows: [
      {
        claimId: "6812b9ab-3b50-4866-8e0c-f5f625e72765",
        address: receiver.addr,
        asaId: 2681521901,
        amountBase: "11",
      },
    ],
    exclusions: [],
    aggregateBase: "11",
  });
  const chain = freshChain();
  chain.hotHoldings.set(2681521901, 11n);
  chain.recvHoldings.set(`${receiver.addr}:2681521901`, 0n);

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
    async waitForConfirmation() {},
  }) as AlgodLike;
  const indexer = Object.assign(mockIndexer(chain), {
    async networkIdentity() {
      return MAINNET;
    },
  }) as IndexerLike;
  const signer = makeSkSigner(payer.addr, payer.sk);

  const gateFor = (expiresAt = EXPIRES): MainnetSafetyGate =>
    signMainnetSafetyGate(
      {
        version: 1,
        runId: "p9final-high-blockers",
        batchId: "p9final-high-blockers",
        manifestSha256: settlementManifestSha256(raw),
        observedAt: NOW,
        expiresAt,
        predicates: Object.fromEntries(
          REQUIRED_MAINNET_PREDICATES.map((predicate) => [predicate, true])
        ) as MainnetSafetyGate["predicates"],
      },
      payer.addr,
      payer.sk
    );

  const options = {
    manifestRaw: raw,
    expectedManifestSha256: settlementManifestSha256(raw),
    gate: gateFor(),
    network: "mainnet" as const,
    payerAddress: payer.addr,
    algod,
    indexer,
    signer,
    store: new MemLedger(),
    dryRun: true,
    now: NOW,
  };

  return { chain, payer, raw, algod, indexer, signer, gateFor, options };
}

const passThroughGuard = {
  async runExclusive<T>(
    _reservation: unknown,
    action: () => Promise<T>
  ): Promise<T> {
    return action();
  },
};

describe("production payment HIGH blocker regressions", () => {
  it("rejects a caught-up indexer whose genesis is not mainnet", async () => {
    const state = setup();
    const wrongIndexer = Object.assign(mockIndexer(state.chain), {
      async networkIdentity() {
        return TESTNET;
      },
    }) as IndexerLike;

    await expect(
      runSettlementDriver({
        ...state.options,
        indexer: wrongIndexer,
      } as any)
    ).rejects.toThrow(/indexer.*genesis|indexer.*network/i);
    expect(state.chain.submitted).toBe(0);
  });

  it("requires a runtime production guard before non-dry-run mainnet execution", async () => {
    const state = setup();

    await expect(
      runSettlementDriver({
        ...state.options,
        dryRun: false,
      } as any)
    ).rejects.toBeInstanceOf(MainnetGateError);
    expect(state.chain.submitted).toBe(0);
  });

  it("revalidates genesis on every transaction-building params response", async () => {
    const state = setup();
    let paramsCalls = 0;
    const algod = {
      ...state.algod,
      async suggestedParams() {
        paramsCalls += 1;
        const params = await state.algod.suggestedParams();
        return paramsCalls >= 3 ? { ...params, ...TESTNET } : params;
      },
    } as AlgodLike;

    await expect(
      runSettlementDriver({
        ...state.options,
        algod,
        dryRun: false,
        productionGuard: passThroughGuard,
      } as any)
    ).rejects.toThrow(/genesis|network identity/i);
    expect(state.chain.submitted).toBe(0);
  });

  it("rejects a signed safety gate exactly at its expiry boundary", async () => {
    const state = setup();

    await expect(
      runSettlementDriver({
        ...state.options,
        gate: state.gateFor(EXPIRES),
        now: EXPIRES,
      } as any)
    ).rejects.toBeInstanceOf(MainnetGateError);
    expect(state.chain.submitted).toBe(0);
  });
});
