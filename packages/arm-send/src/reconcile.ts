/**
 * R14.5.2/3 — across-window reconciliation, INDEXER-authoritative.
 *
 * algod cannot search note/lease history, so "already committed?" across windows is
 * answered by the indexer, and ONLY trusted when the indexer is confirmed caught-up to
 * the algod round-tip. A positive match asserts the FULL tuple (sender, receiver, asset,
 * amount, note) — never note-alone. algod supplies tip/liveness/pending-pool. Any staleness
 * → the named BLOCKER; do NOT send, do NOT resume the ambiguous remainder.
 */
import type {
  AlgodLike,
  IndexerLike,
  NetworkIdentity,
  ReconcileResult,
  SendUnit,
} from "./types.js";
import { noteStringFor } from "./intent.js";

export class ArmReconcileNodeStale extends Error {
  constructor(msg: string) {
    super(`arm-reconcile-node-stale: ${msg}`);
    this.name = "ArmReconcileNodeStale";
  }
}
export class ArmReconcileIndexerStale extends Error {
  constructor(msg: string) {
    super(`arm-reconcile-indexer-stale: ${msg}`);
    this.name = "ArmReconcileIndexerStale";
  }
}

export class ArmReconcileIndexerNetworkMismatch extends Error {
  constructor(msg: string) {
    super(`arm-reconcile-indexer-network-mismatch: ${msg}`);
    this.name = "ArmReconcileIndexerNetworkMismatch";
  }
}

/** Maximum lag allowed while searching for a positive committed or pending match. */
export const INDEXER_CATCHUP_TOLERANCE = 2;

export interface TipState {
  algodTip: number;
  indexerRound: number;
}

/**
 * Establish tip/liveness ONCE per batch/resume before any send. Throws the node/indexer
 * BLOCKER on staleness. Returns the observed rounds for the run log.
 */
export async function establishTip(
  algod: AlgodLike,
  indexer: IndexerLike,
  expectedNetwork?: NetworkIdentity
): Promise<TipState> {
  const status = await algod.status();
  if (!Number.isFinite(status.lastRound) || status.lastRound <= 0)
    throw new ArmReconcileNodeStale(`no current tip (lastRound=${status.lastRound})`);
  const indexerRound = await indexer.healthRound();
  if (!Number.isFinite(indexerRound) || indexerRound <= 0)
    throw new ArmReconcileIndexerStale(`indexer health round invalid (${indexerRound})`);
  if (indexerRound < status.lastRound - INDEXER_CATCHUP_TOLERANCE)
    throw new ArmReconcileIndexerStale(
      `indexer round ${indexerRound} behind algod tip ${status.lastRound} (tolerance ${INDEXER_CATCHUP_TOLERANCE})`
    );
  if (expectedNetwork) {
    if (!indexer.networkIdentity)
      throw new ArmReconcileIndexerNetworkMismatch(
        "indexer adapter cannot prove network identity"
      );
    const actualNetwork = await indexer.networkIdentity(indexerRound);
    if (
      actualNetwork.genesisID !== expectedNetwork.genesisID ||
      actualNetwork.genesisHash !== expectedNetwork.genesisHash
    )
      throw new ArmReconcileIndexerNetworkMismatch(
        `indexer genesis ${actualNetwork.genesisID}/${actualNetwork.genesisHash} != expected ${expectedNetwork.genesisID}/${expectedNetwork.genesisHash}`
      );
  }
  return { algodTip: status.lastRound, indexerRound };
}

/**
 * Reconcile ONE send unit against chain history + pending pool.
 * Full-tuple assert: a committed match must have sender=hotWallet, receiver=unit.address,
 * asset=unit.asaId, amount=unit.amountBase, note=intent note. Amount mismatch on a note
 * hit is treated as NOT-a-match (never pay/skip on note-alone).
 */
export async function reconcileUnit(
  unit: SendUnit,
  hotWallet: string,
  algod: AlgodLike,
  indexer: IndexerLike,
  expectedNetwork?: NetworkIdentity
): Promise<ReconcileResult> {
  const tip = await establishTip(algod, indexer, expectedNetwork);
  const note = noteStringFor(unit.intentId, unit.intentDomain);
  const matches = await indexer.findByNote({
    sender: hotWallet,
    receiver: unit.address,
    assetId: unit.asaId,
    note,
  });
  const exact = matches.find((transaction) => transaction.amount === unit.amountBase);
  if (exact) return { committed: true, pending: false, txid: exact.txid };
  if (matches.length > 0) {
    throw new Error(
      `reconcile: note match for intent ${unit.intentId} with WRONG amount (chain != owed ${unit.amountBase}) — refusing to skip`
    );
  }

  const pending = await algod.pendingFromSender(hotWallet);
  const exactPending = pending.find((transaction) => {
    if (transaction.note !== note) return false;
    if (algod.pendingTupleMode !== "full") return true;
    return (
      transaction.txid.length > 0 &&
      transaction.sender === hotWallet &&
      transaction.receiver === unit.address &&
      transaction.assetId === unit.asaId &&
      transaction.amount === unit.amountBase
    );
  });
  if (exactPending)
    return { committed: false, pending: true, txid: exactPending.txid };
  if (tip.indexerRound < tip.algodTip)
    throw new ArmReconcileIndexerStale(
      `negative lookup requires exact catch-up: indexer round ${tip.indexerRound}, algod tip ${tip.algodTip}`
    );
  return { committed: false, pending: false, txid: null };
}
