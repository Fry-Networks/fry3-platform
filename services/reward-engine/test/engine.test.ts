import { describe, it, expect } from "vitest";
import { accrueDevice, backfillDevice, filterAlreadyPersisted, DeviceState } from "../src/engine";
import { IntegrationKind, RewardPolicyConfig } from "@fry3/reward-policy";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: { [IntegrationKind.BANDWIDTH]: 100n } as any,
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const now = new Date("2026-07-19T12:00:00.000Z");
const intervalStart = new Date("2026-07-19T11:00:00.000Z");

function st(over: Partial<DeviceState>): DeviceState {
  return { deviceId: "d1", banned: false, disabled: false, lastHeartbeatAt: new Date(now.getTime() - 60 * 1000), healthyIntegrations: new Set(), ...over };
}

describe("accrueDevice", () => {
  it("online + bandwidth -> eligible", () => {
    const r = accrueDevice(st({ healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]) }), intervalStart, policy, now);
    expect(r.eligible).toBe(true);
    expect(r.amountBase).toBe(100n);
  });
  it("offline -> zero", () => {
    const r = accrueDevice(st({ lastHeartbeatAt: new Date(now.getTime() - 5000 * 1000) }), intervalStart, policy, now);
    expect(r.eligible).toBe(false);
  });
  it("idempotency key deterministic", () => {
    const r = accrueDevice(st({}), intervalStart, policy, now);
    expect(r.idempotencyKey).toBe("d1:2026-07-19T11:00:00.000Z:v1");
  });
  it("banned -> zero", () => {
    expect(accrueDevice(st({ banned: true }), intervalStart, policy, now).eligible).toBe(false);
  });
});

describe("backfillDevice (maintenance window)", () => {
  const mk = (over: any) => ({ intervalStart, secondsSinceLastHeartbeat: 60, healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]), banned: false, disabled: false, ...over });
  it("eligible maintenance-window interval accrues", () => {
    const rs = backfillDevice("d1", [mk({})], policy);
    expect(rs[0].eligible).toBe(true);
    expect(rs[0].amountBase).toBe(100n);
  });
  it("offline interval in window -> zero", () => {
    const rs = backfillDevice("d1", [mk({ secondsSinceLastHeartbeat: 9999 })], policy);
    expect(rs[0].eligible).toBe(false);
  });
  it("multiple intervals -> one record each, deterministic keys", () => {
    const iv2 = new Date(intervalStart.getTime() + 3600 * 1000);
    const rs = backfillDevice("d1", [mk({}), mk({ intervalStart: iv2 })], policy);
    expect(rs).toHaveLength(2);
    expect(rs[0].idempotencyKey).not.toBe(rs[1].idempotencyKey);
  });
  it("storj+space_acres both -> storage counted once", () => {
    const rs = backfillDevice("d1", [mk({ healthyIntegrations: new Set([IntegrationKind.STORJ, IntegrationKind.SPACE_ACRES]) })], policy);
    expect(rs[0].amountBase).toBe(50n);
    expect(rs[0].storageCapabilityCounted).toBe(true);
  });
});

describe("filterAlreadyPersisted (idempotent re-run)", () => {
  it("drops already-persisted keys", () => {
    const rs = backfillDevice("d1", [{ intervalStart, secondsSinceLastHeartbeat: 60, healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]), banned: false, disabled: false }], policy);
    const persisted = new Set([rs[0].idempotencyKey]);
    expect(filterAlreadyPersisted(rs, persisted)).toHaveLength(0);
    expect(filterAlreadyPersisted(rs, new Set())).toHaveLength(1);
  });
});
