/** Deterministic in-memory mocks for the arm-send gate (no network, no fs, no creds). */
import type { AlgodLike, IndexerLike, LedgerRecord } from "../src/types.js";
import type { LedgerStore } from "../src/ledger.js";

export class MemLedger implements LedgerStore {
  records: LedgerRecord[] = [];
  async append(rec: LedgerRecord) {
    // clone to defend against later mutation.
    this.records.push({ ...rec });
  }
  async readAll() {
    return this.records.slice();
  }
}

export interface MockChain {
  tip: number;
  indexerRound: number;
  authAddr: string | null;
  algoMicro: bigint;
  minFee: number;
  genesisID: string;
  genesisHash: string; // base64
  firstRound: number;
  /** hotWallet ASA balances by assetId */
  hotHoldings: Map<number, bigint>;
  /** opted-in recipients: `${addr}:${assetId}` present → opted in (value=balance) */
  recvHoldings: Map<string, bigint>;
  /** committed txns keyed by exact note string → {sender, receiver, assetId, amount, txid} */
  committed: Map<string, { sender: string; receiver: string; assetId: number; amount: bigint; txid: string }>;
  /** pending pool notes by sender → note strings */
  pending: Map<string, string[]>;
  /** submitted signed txns count + assigned txids */
  submitted: number;
}

export function freshChain(over: Partial<MockChain> = {}): MockChain {
  return {
    tip: 1000,
    indexerRound: 1000,
    authAddr: null,
    algoMicro: 10_000_000n,
    minFee: 1000,
    genesisID: "mainnet-v1.0",
    genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    firstRound: 5000,
    hotHoldings: new Map(),
    recvHoldings: new Map(),
    committed: new Map(),
    pending: new Map(),
    submitted: 0,
    ...over,
  };
}

export function mockAlgod(c: MockChain, hotWallet: string): AlgodLike {
  return {
    async status() {
      return { lastRound: c.tip };
    },
    async suggestedParams() {
      return {
        fee: c.minFee,
        flatFee: true,
        firstRound: c.firstRound,
        lastRound: c.firstRound + 1,
        genesisID: c.genesisID,
        genesisHash: c.genesisHash,
        minFee: c.minFee,
      };
    },
    async accountInfo(addr) {
      if (addr === hotWallet) return { authAddr: c.authAddr, amount: c.algoMicro };
      return { authAddr: null, amount: 0n };
    },
    async assetHolding(addr, assetId) {
      if (addr === hotWallet) {
        const v = c.hotHoldings.get(assetId);
        return v === undefined ? null : { amount: v };
      }
      const v = c.recvHoldings.get(`${addr}:${assetId}`);
      return v === undefined ? null : { amount: v };
    },
    async pendingFromSender(addr) {
      return (c.pending.get(addr) ?? []).map((note) => ({ txid: "", note }));
    },
    async submit(_signed) {
      c.submitted++;
      return `TXID_SUBMIT_${c.submitted}`;
    },
  };
}

export function mockIndexer(c: MockChain): IndexerLike {
  return {
    async healthRound() {
      return c.indexerRound;
    },
    async findByNote({ sender, receiver, assetId, note }) {
      const hit = c.committed.get(note);
      if (hit && hit.sender === sender && hit.receiver === receiver && hit.assetId === assetId) {
        return [{ txid: hit.txid, amount: hit.amount }];
      }
      return [];
    },
  };
}
