/**
 * Manual claim dispatch — server-calculated, idempotent, hot-wallet-safe.
 * No smart-contract modification. Integer/base-unit arithmetic only.
 */

export enum ClaimStatus {
  PENDING = "PENDING",
  RESERVED = "RESERVED",
  DISPATCHED = "DISPATCHED",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
  RECONCILED = "RECONCILED",
}

export interface ClaimRequest {
  userId: string;
  idempotencyKey: string;
  destination: string; // Algorand address
  /** client-supplied amount is NEVER trusted; server computes entitlement */
}

export interface ClaimDecision {
  allowed: boolean;
  reason?: string;
  amountBase?: bigint;
}

/** Server-side claim amount: the reservable balance, never a client number. */
export function computeClaimAmount(reservableBalanceBase: bigint): bigint {
  if (reservableBalanceBase <= 0n) return 0n;
  return reservableBalanceBase;
}

/** Validate claim request server-side. */
export function evaluateClaim(
  reservableBalanceBase: bigint,
  hotWalletBalanceBase: bigint,
  destination: string,
  destinationOwnerUserId: string,
  requestingUserId: string,
  estimatedFeeBase: bigint
): ClaimDecision {
  // cross-user claim prevention
  if (destinationOwnerUserId !== requestingUserId) {
    return { allowed: false, reason: "destination_not_owned_by_requester" };
  }
  const amount = computeClaimAmount(reservableBalanceBase);
  if (amount <= 0n) {
    return { allowed: false, reason: "zero_reservable_balance" };
  }
  // hot-wallet sufficiency (amount + fee)
  if (hotWalletBalanceBase < amount + estimatedFeeBase) {
    return { allowed: false, reason: "hot_wallet_insufficient" };
  }
  // basic address shape (Algorand 58-char base32)
  if (!/^[A-Z2-7]{58}$/.test(destination)) {
    return { allowed: false, reason: "invalid_destination_address" };
  }
  return { allowed: true, amountBase: amount };
}

/** Idempotency: same key => same claim, never a duplicate. */
export function claimIdempotencyKey(userId: string, clientNonce: string): string {
  return `${userId}:${clientNonce}`;
}

/** State machine: legal transitions only. */
const LEGAL: Record<ClaimStatus, ClaimStatus[]> = {
  [ClaimStatus.PENDING]: [ClaimStatus.RESERVED, ClaimStatus.FAILED],
  [ClaimStatus.RESERVED]: [ClaimStatus.DISPATCHED, ClaimStatus.FAILED],
  [ClaimStatus.DISPATCHED]: [ClaimStatus.CONFIRMED, ClaimStatus.FAILED],
  [ClaimStatus.CONFIRMED]: [ClaimStatus.RECONCILED],
  [ClaimStatus.FAILED]: [ClaimStatus.PENDING], // safe retry re-reserves; ledger release is separate
  [ClaimStatus.RECONCILED]: [],
};

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

/** A failed dispatch must release the reservation exactly once. */
export function shouldReleaseReservation(from: ClaimStatus, to: ClaimStatus): boolean {
  return from === ClaimStatus.RESERVED && to === ClaimStatus.FAILED;
}
