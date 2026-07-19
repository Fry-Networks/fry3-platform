import { describe, it, expect } from "vitest";
import {
  toBaseUnitsString,
  fromBaseUnitsString,
  legacyDeviceToCanonical,
  canonicalDeviceToLegacy,
  canonicalRewardBalanceToLegacy,
  validateLegacyDevice,
  validateLegacyRewardBalance,
} from "../src/index";

describe("amount helpers (integer, no float)", () => {
  it("accepts bigint/integer/int-string", () => {
    expect(toBaseUnitsString(100n)).toBe("100");
    expect(toBaseUnitsString(100)).toBe("100");
    expect(toBaseUnitsString("100")).toBe("100");
  });
  it("rejects float number", () => {
    expect(() => toBaseUnitsString(1.5)).toThrow("float_amount_not_allowed");
  });
  it("rejects non-integer string", () => {
    expect(() => toBaseUnitsString("1.5")).toThrow("invalid_base_units_string");
    expect(() => fromBaseUnitsString("abc")).toThrow("invalid_base_units_string");
  });
  it("fromBaseUnitsString", () => {
    expect(fromBaseUnitsString("1000")).toBe(1000n);
  });
});

describe("device adapters round-trip", () => {
  it("legacy -> canonical -> legacy", () => {
    const legacy = { device_id: "d1", owner: "u1", online: true, last_seen: "2026-07-19" };
    const canonical = legacyDeviceToCanonical(legacy);
    expect(canonical.status).toBe("ONLINE");
    const back = canonicalDeviceToLegacy(canonical);
    expect(back).toEqual(legacy);
  });
  it("offline maps correctly", () => {
    expect(legacyDeviceToCanonical({ device_id: "d1", owner: "u1", online: false }).status).toBe("OFFLINE");
  });
});

describe("reward balance adapter", () => {
  it("canonical -> legacy integer string", () => {
    expect(canonicalRewardBalanceToLegacy("500").pending).toBe("500");
    expect(canonicalRewardBalanceToLegacy("500").currency).toBe("FRY");
  });
  it("rejects float amount", () => {
    expect(() => canonicalRewardBalanceToLegacy(1.5 as any)).toThrow();
  });
});

describe("validators", () => {
  it("valid legacy device passes", () => {
    expect(validateLegacyDevice({ device_id: "d1", owner: "u1", online: true }).ok).toBe(true);
  });
  it("invalid device fails with errors", () => {
    const r = validateLegacyDevice({ device_id: "", online: "yes" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("valid balance passes", () => {
    expect(validateLegacyRewardBalance({ pending: "100", currency: "FRY" }).ok).toBe(true);
  });
  it("float-pending balance fails", () => {
    expect(validateLegacyRewardBalance({ pending: "1.5", currency: "FRY" }).ok).toBe(false);
  });
});
