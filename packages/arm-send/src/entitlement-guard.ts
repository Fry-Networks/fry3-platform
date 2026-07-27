/**
 * Entitlement-keyed duplicate-payment guard.
 *
 * Why this exists: on 2026-07-24 the settlement driver paid 103,020,000 base units of tFRY twice,
 * 11 seconds apart, to the same wallet. Two distinct claim UUIDs
 * (6812b9ab-… and 8d502632-…) had been minted over ONE underlying entitlement — the same
 * miner_key and the same weekly reward records. Because every idempotency layer keyed off the
 * claim/envelope id (intentId embeds claimId; the transaction lease and note derive from
 * intentId; the production guard reserves by claimId), the twins produced different intentIds,
 * different notes and different leases, so nothing — not even Algorand's own (Sender, Lease)
 * dedupe — could see them as the same obligation.
 *
 * The rule enforced here: within one batch, two payments that are indistinguishable on the wire
 * — same receiver, same asset, same amount — must each prove they discharge a DIFFERENT
 * entitlement. Absence of proof fails closed. Two rows claiming the SAME entitlement fail closed
 * too.
 *
 * This deliberately does not change intentId, note or lease derivation: those are recorded in the
 * append-only send ledger and on chain, and altering their preimage would invalidate every prior
 * record and break crash-resume.
 */

/** The minimum shape needed to detect an indistinguishable-on-chain payment. */
export interface PaymentTupleLike {
  readonly address: string;
  readonly asaId: number;
  readonly amountBase: bigint;
  /** Stable identifier of the underlying obligation, e.g. `${minerKey}|${rewardNumbers}|${asaId}`. */
  readonly entitlementKey?: string;
  /** For diagnostics only. */
  readonly claimId?: string;
  readonly deviceId?: string;
}

/** The on-wire identity of a payment: what a receiver and the chain actually observe. */
export function paymentTupleOf(item: PaymentTupleLike): string {
  return `${item.address}|${item.asaId}|${item.amountBase.toString()}`;
}

function label(item: PaymentTupleLike): string {
  return item.claimId ?? item.deviceId ?? "<unidentified>";
}

/**
 * Throws unless every group of rows sharing a payment tuple proves distinct entitlements.
 * Safe for zero- and one-element inputs.
 */
export function assertNoDuplicatePaymentTuples(items: readonly PaymentTupleLike[]): void {
  const byTuple = new Map<string, PaymentTupleLike[]>();
  for (const item of items) {
    const tuple = paymentTupleOf(item);
    const group = byTuple.get(tuple);
    if (group) group.push(item);
    else byTuple.set(tuple, [item]);
  }

  for (const [tuple, group] of byTuple) {
    if (group.length < 2) continue;
    const ids = group.map(label).join(", ");

    const missing = group.filter((item) => !item.entitlementKey || !item.entitlementKey.trim());
    if (missing.length > 0)
      throw new Error(
        `duplicate payment tuple ${tuple} across [${ids}] — each row must carry a distinct ` +
          `entitlementKey proving it discharges a separate obligation`
      );

    const distinct = new Set(group.map((item) => item.entitlementKey as string));
    if (distinct.size !== group.length)
      throw new Error(
        `rows [${ids}] resolve to the same entitlement for payment tuple ${tuple} — ` +
          `refusing to pay one entitlement more than once`
      );
  }
}
