import { describe, it, expect } from "vitest";
import {
  evaluateClaim,
  computeClaimAmount,
  claimIdempotencyKey,
  canTransition,
  shouldReleaseReservation,
  ClaimStatus,
} from "../src/claim";

const ADDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ"; // 58-char

describe("computeClaimAmount (server-side, never client)", () => {
  it("uses reservable balance", () => {
    expect(computeClaimAmount(1000n)).toBe(1000n);
  });
  it("zero balance -> zero", () => {
    expect(computeClaimAmount(0n)).toBe(0n);
  });
  it("negative -> zero", () => {
    expect(computeClaimAmount(-5n)).toBe(0n);
  });
});

describe("evaluateClaim", () => {
  const base = {
    reservable: 1000n,
    hot: 5000n,
    fee: 1000n,
    dest: ADDR,
    owner: "user-1",
    requester: "user-1",
  };
  it("allows valid claim", () => {
    const d = evaluateClaim(base.reservable, base.hot, base.dest, base.owner, base.requester, base.fee);
    expect(d.allowed).toBe(true);
    expect(d.amountBase).toBe(1000n);
  });
  it("rejects cross-user claim", () => {
    const d = evaluateClaim(base.reservable, base.hot, base.dest, "user-2", base.requester, base.fee);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("destination_not_owned_by_requester");
  });
  it("rejects zero balance", () => {
    const d = evaluateClaim(0n, base.hot, base.dest, base.owner, base.requester, base.fee);
    expect(d.reason).toBe("zero_reservable_balance");
  });
  it("rejects insufficient hot wallet (amount+fee)", () => {
    const d = evaluateClaim(base.reservable, 1500n, base.dest, base.owner, base.requester, base.fee);
    expect(d.reason).toBe("hot_wallet_insufficient");
  });
  it("allows when hot wallet exactly covers amount+fee", () => {
    const d = evaluateClaim(base.reservable, 2000n, base.dest, base.owner, base.requester, base.fee);
    expect(d.allowed).toBe(true);
  });
  it("rejects invalid address", () => {
    const d = evaluateClaim(base.reservable, base.hot, "not-an-address", base.owner, base.requester, base.fee);
    expect(d.reason).toBe("invalid_destination_address");
  });
});

describe("idempotency", () => {
  it("deterministic key", () => {
    expect(claimIdempotencyKey("u1", "n1")).toBe("u1:n1");
  });
});

describe("claim state machine", () => {
  it("legal forward transitions", () => {
    expect(canTransition(ClaimStatus.PENDING, ClaimStatus.RESERVED)).toBe(true);
    expect(canTransition(ClaimStatus.RESERVED, ClaimStatus.DISPATCHED)).toBe(true);
    expect(canTransition(ClaimStatus.DISPATCHED, ClaimStatus.CONFIRMED)).toBe(true);
    expect(canTransition(ClaimStatus.CONFIRMED, ClaimStatus.RECONCILED)).toBe(true);
  });
  it("illegal transitions rejected", () => {
    expect(canTransition(ClaimStatus.PENDING, ClaimStatus.CONFIRMED)).toBe(false);
    expect(canTransition(ClaimStatus.RECONCILED, ClaimStatus.PENDING)).toBe(false);
    expect(canTransition(ClaimStatus.CONFIRMED, ClaimStatus.DISPATCHED)).toBe(false);
  });
  it("failed can retry to pending", () => {
    expect(canTransition(ClaimStatus.FAILED, ClaimStatus.PENDING)).toBe(true);
  });
  it("reservation released exactly once on RESERVED->FAILED", () => {
    expect(shouldReleaseReservation(ClaimStatus.RESERVED, ClaimStatus.FAILED)).toBe(true);
    expect(shouldReleaseReservation(ClaimStatus.DISPATCHED, ClaimStatus.FAILED)).toBe(false);
    expect(shouldReleaseReservation(ClaimStatus.PENDING, ClaimStatus.FAILED)).toBe(false);
  });
});
