/**
 * R14.5.4 — the ambiguous-JSONL resume decision tree (PURE).
 *
 *   (1) txid present in ledger              → SKIP
 *   (2) intent written, no txid             → indexer-check:
 *            committed  → SKIP + backfill txid
 *            pending    → SKIP (already broadcast; never resubmit)
 *            neither    → RESEND same id/note/lease/amount (fresh suggested-params)
 *   (3) no ledger entry                     → indexer-check by note:
 *            committed  → SKIP + backfill txid
 *            pending    → SKIP
 *            neither    → SEND fresh
 *
 * Invariant: NEVER decide "unpaid" from JSONL / paid-marker alone when the indexer is
 * unavailable. `reconcile` MUST be provided for every non-txid case (it is null ONLY when
 * a txid is already in the ledger). A null reconcile for a non-txid case throws.
 */
import type { FoldedIntent, ReconcileResult, SendDecision } from "./types.js";

export function decideSend(
  folded: FoldedIntent | undefined,
  reconcile: ReconcileResult | null
): SendDecision {
  // (1) txid already in the append-only ledger → paid, skip. (No indexer needed.)
  if (folded?.txid) return { kind: "SKIP_TXID_PRESENT", txid: folded.txid };

  // Every remaining path is indexer-authoritative — refuse to decide without it.
  if (!reconcile) {
    throw new Error(
      "decideSend: indexer reconcile missing for a non-txid intent — refusing to decide 'unpaid' from JSONL alone"
    );
  }

  if (reconcile.committed && reconcile.txid) {
    return { kind: "SKIP_COMMITTED_BACKFILL", txid: reconcile.txid };
  }
  if (reconcile.pending) return { kind: "SKIP_PENDING" };

  // Not on chain, not pending. Distinguish (2) resume-resend vs (3) first send.
  if (folded?.intentWritten) return { kind: "RESEND_SAME" };
  return { kind: "SEND_FRESH" };
}
