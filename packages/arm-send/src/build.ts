/**
 * R14.5.2/6 — build ONE independent per-ASA AssetTransfer txn.
 *
 * Carries the intent note + a 32-byte lease derived from the intent-id, with a long
 * (~1000-round) validity window so (Sender, Lease) makes the network reject an in-window
 * duplicate. Amount is the exact base-unit bigint the AssetTransferTxn consumes. FRY3 and
 * fNODE are ALWAYS separate single txns — never assembled into an atomic group.
 */
import algosdk from "algosdk";
import { VALIDITY_WINDOW_ROUNDS, type SendUnit } from "./types.js";
import { leaseFor, noteFor } from "./intent.js";

export interface BuiltTxn {
  txn: algosdk.Transaction;
  txid: string;
}

/** Suggested params as returned by AlgodLike.suggestedParams (flat min-fee). */
export interface Sp {
  fee: number;
  flatFee: boolean;
  firstRound: number;
  lastRound: number;
  genesisID: string;
  genesisHash: string;
}

export function buildAssetTransfer(unit: SendUnit, hotWallet: string, sp: Sp): BuiltTxn {
  const firstRound = sp.firstRound;
  const lastRound = firstRound + VALIDITY_WINDOW_ROUNDS;
  const suggestedParams: algosdk.SuggestedParams = {
    fee: sp.fee,
    flatFee: true, // arm uses a flat min-fee; fee budget is asserted against total send count
    firstRound,
    lastRound,
    genesisID: sp.genesisID,
    genesisHash: sp.genesisHash,
  };
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: hotWallet,
    to: unit.address,
    amount: unit.amountBase, // bigint — exact base units
    assetIndex: unit.asaId,
    note: noteFor(unit.intentId, unit.intentDomain),
    suggestedParams,
  });
  // 32-byte lease derived from the frozen intent-id (in-window duplicate guard).
  txn.addLease(leaseFor(unit.intentId, unit.intentDomain));
  return { txn, txid: txn.txID() };
}
