import { describe, it, expect } from "vitest";
import {
  computeReward,
  storageCapability,
  isOnlineEligible,
  accrualIdempotencyKey,
  DeviceStatus,
  IntegrationKind,
  RewardPolicyConfig,
  DeviceRewardInput,
} from "../src/index";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: {
    [IntegrationKind.BANDWIDTH]: 100n,
    [IntegrationKind.COMPUTE]: 200n,
    [IntegrationKind.STORJ]: 999n, // should be ignored in favor of storageCapabilityWeight
    [IntegrationKind.SPACE_ACRES]: 999n,
  },
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

function device(over: Partial<DeviceRewardInput>): DeviceRewardInput {
  return {
    deviceId: "dev-1",
    status: DeviceStatus.ONLINE,
    banned: false,
    secondsSinceLastHeartbeat: 10,
    healthyIntegrations: new Set(),
    ...over,
  };
}

describe("storage_capability (Storj/Space Acres OR-substitution)", () => {
  it("neither healthy -> not counted", () => {
    expect(storageCapability(new Set())).toBe(false);
  });
  it("storj only -> counted", () => {
    expect(storageCapability(new Set([IntegrationKind.STORJ]))).toBe(true);
  });
  it("space_acres only -> counted", () => {
    expect(storageCapability(new Set([IntegrationKind.SPACE_ACRES]))).toBe(true);
  });
  it("both -> counted once", () => {
    expect(storageCapability(new Set([IntegrationKind.STORJ, IntegrationKind.SPACE_ACRES]))).toBe(true);
  });
});

describe("4-row Storj/SpaceAcres reward matrix", () => {
  it("Off+Off -> no storage weight", () => {
    const r = computeReward(device({ healthyIntegrations: new Set() }), policy);
    expect(r.eligible).toBe(false); // no qualifying integration
    expect(r.storageCapabilityCounted).toBe(false);
  });
  it("Storj healthy, SpaceAcres off -> storage counted once (50)", () => {
    const r = computeReward(device({ healthyIntegrations: new Set([IntegrationKind.STORJ]) }), policy);
    expect(r.eligible).toBe(true);
    expect(r.amountBase).toBe(50n);
    expect(r.storageCapabilityCounted).toBe(true);
  });
  it("SpaceAcres healthy, Storj off -> storage counted once (50)", () => {
    const r = computeReward(device({ healthyIntegrations: new Set([IntegrationKind.SPACE_ACRES]) }), policy);
    expect(r.eligible).toBe(true);
    expect(r.amountBase).toBe(50n);
    expect(r.storageCapabilityCounted).toBe(true);
  });
  it("both healthy -> storage counted ONCE (50, not 100)", () => {
    const r = computeReward(
      device({ healthyIntegrations: new Set([IntegrationKind.STORJ, IntegrationKind.SPACE_ACRES]) }),
      policy
    );
    expect(r.amountBase).toBe(50n); // NOT doubled
    expect(r.storageCapabilityCounted).toBe(true);
  });
});

describe("offline gating (no ghost rewards)", () => {
  it("offline device -> zero", () => {
    const r = computeReward(
      device({ status: DeviceStatus.OFFLINE, secondsSinceLastHeartbeat: 9999, healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]) }),
      policy
    );
    expect(r.eligible).toBe(false);
    expect(r.amountBase).toBe(0n);
    expect(r.ineligibleReason).toBe("offline_or_stale_heartbeat");
  });
  it("stale heartbeat beyond threshold -> zero", () => {
    const r = computeReward(device({ secondsSinceLastHeartbeat: 301 }), policy);
    expect(r.ineligibleReason).toBe("offline_or_stale_heartbeat");
  });
  it("never-seen device -> zero", () => {
    const r = computeReward(device({ secondsSinceLastHeartbeat: null }), policy);
    expect(r.ineligibleReason).toBe("offline_or_stale_heartbeat");
  });
  it("heartbeat exactly at threshold -> eligible boundary", () => {
    const r = computeReward(
      device({ secondsSinceLastHeartbeat: 300, healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]) }),
      policy
    );
    expect(r.eligible).toBe(true);
  });
});

describe("disabled/banned gating", () => {
  it("banned -> zero", () => {
    const r = computeReward(device({ banned: true, healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]) }), policy);
    expect(r.ineligibleReason).toBe("device_banned");
  });
  it("disabled -> zero", () => {
    const r = computeReward(device({ status: DeviceStatus.DISABLED, healthyIntegrations: new Set([IntegrationKind.BANDWIDTH]) }), policy);
    expect(r.ineligibleReason).toBe("device_disabled");
  });
});

describe("integration weights", () => {
  it("sums non-storage integration weights", () => {
    const r = computeReward(
      device({ healthyIntegrations: new Set([IntegrationKind.BANDWIDTH, IntegrationKind.COMPUTE]) }),
      policy
    );
    expect(r.amountBase).toBe(300n); // 100+200
  });
  it("storage + other integrations", () => {
    const r = computeReward(
      device({ healthyIntegrations: new Set([IntegrationKind.BANDWIDTH, IntegrationKind.STORJ]) }),
      policy
    );
    expect(r.amountBase).toBe(150n); // 100 + 50
  });
});

describe("online eligibility", () => {
  it("isOnlineEligible", () => {
    expect(isOnlineEligible(10, 300)).toBe(true);
    expect(isOnlineEligible(300, 300)).toBe(true);
    expect(isOnlineEligible(301, 300)).toBe(false);
    expect(isOnlineEligible(null, 300)).toBe(false);
  });
});

describe("idempotency", () => {
  it("accrualIdempotencyKey deterministic", () => {
    const d = new Date("2026-07-19T00:00:00.000Z");
    expect(accrualIdempotencyKey("dev-1", d, 1)).toBe("dev-1:2026-07-19T00:00:00.000Z:v1");
  });
});
