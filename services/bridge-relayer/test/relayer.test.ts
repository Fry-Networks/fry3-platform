import { describe, it, expect } from "vitest";
import {
  canTransition,
  relayAllowed,
  isReplay,
  dedupeBySourceTx,
  reconcileEvents,
  validAmount,
  BridgeStatus,
  BridgeEvent,
} from "../src/relayer";

const ev = (id: string, src: string, status = BridgeStatus.OBSERVED): BridgeEvent => ({ id, sourceTxId: src, amountBase: "100", assetRef: "FRY", status });

describe("state machine", () => {
  it("legal transitions", () => {
    expect(canTransition(BridgeStatus.OBSERVED, BridgeStatus.RELAYED)).toBe(true);
    expect(canTransition(BridgeStatus.RELAYED, BridgeStatus.CONFIRMED)).toBe(true);
  });
  it("illegal transitions rejected", () => {
    expect(canTransition(BridgeStatus.OBSERVED, BridgeStatus.CONFIRMED)).toBe(false);
    expect(canTransition(BridgeStatus.CONFIRMED, BridgeStatus.RELAYED)).toBe(false);
  });
});

describe("relay safety gate (mainnet OFF by default)", () => {
  it("mainnet blocked by default", () => {
    expect(relayAllowed("mainnet")).toBe(false);
  });
  it("mainnet allowed only when explicitly enabled", () => {
    expect(relayAllowed("mainnet", true)).toBe(true);
  });
  it("mock/dry-run/testnet always allowed", () => {
    expect(relayAllowed("mock")).toBe(true);
    expect(relayAllowed("dry-run")).toBe(true);
    expect(relayAllowed("testnet")).toBe(true);
  });
});

describe("replay protection", () => {
  it("same sourceTxId rejected", () => {
    const processed = new Set(["tx1"]);
    expect(isReplay("tx1", processed)).toBe(true);
    expect(isReplay("tx2", processed)).toBe(false);
  });
});

describe("dedupe + reconcile", () => {
  it("dedupes by sourceTxId", () => {
    expect(dedupeBySourceTx([ev("1", "tx1"), ev("2", "tx1"), ev("3", "tx2")])).toHaveLength(2);
  });
  it("reconcile detects missing + duplicated", () => {
    const observed = [ev("1", "tx1"), ev("2", "tx2")];
    const relayed = [ev("a", "tx1", BridgeStatus.RELAYED), ev("b", "tx1", BridgeStatus.RELAYED)];
    const r = reconcileEvents(observed, relayed);
    expect(r.missing).toEqual(["tx2"]);
    expect(r.duplicated).toEqual(["tx1"]);
  });
});

describe("validAmount (integer base-units, no float)", () => {
  it("accepts integer", () => {
    expect(validAmount("1000")).toBe(true);
    expect(validAmount("0")).toBe(true);
  });
  it("rejects float/negative/non-numeric", () => {
    expect(validAmount("1.5")).toBe(false);
    expect(validAmount("-5")).toBe(false);
    expect(validAmount("abc")).toBe(false);
  });
});
