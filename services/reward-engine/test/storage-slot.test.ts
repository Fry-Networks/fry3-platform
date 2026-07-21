import { describe, it, expect } from "vitest";
import { accrueDeviceFromEvidence, buildHealthySetForAccrual } from "../src/storage-slot";
import { IntegrationKind, RewardPolicyConfig } from "@fry3/reward-policy";
import { HealthEvidence, verifiedHealthySet, STORAGE_ATTESTATION_MAX_AGE_SECONDS } from "@fry3/integration-health";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: {
    [IntegrationKind.BANDWIDTH]: 100n,
    [IntegrationKind.COMPUTE]: 200n,
  },
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const now = new Date("2026-07-21T12:00:00.000Z");
const intervalStart = new Date("2026-07-21T11:00:00.000Z");
const online = { deviceId: "d1", banned: false, disabled: false, lastHeartbeatAt: new Date(now.getTime() - 60 * 1000) };
const H = 3600;

const ev = (integration: IntegrationKind, ageSeconds: number, healthy = true): HealthEvidence => ({
  integration,
  healthy,
  evidenceAt: new Date(now.getTime() - ageSeconds * 1000),
  evidenceType: "telemetry",
});

describe("storage slot — single daily attestation (1 slot/day, not 144)", () => {
  it("storj-only attestation 20h old earns the slot", () => {
    const r = accrueDeviceFromEvidence(online, [ev(IntegrationKind.STORJ, 20 * H)], intervalStart, policy, now);
    expect(r.eligible).toBe(true);
    expect(r.amountBase).toBe(50n);
    expect(r.storageCapabilityCounted).toBe(true);
  });
  it("wiring is load-bearing: the default 600s set would DROP that attestation", () => {
    expect(verifiedHealthySet([ev(IntegrationKind.STORJ, 20 * H)], now).has(IntegrationKind.STORJ)).toBe(false);
    expect(buildHealthySetForAccrual([ev(IntegrationKind.STORJ, 20 * H)], now, policy).has(IntegrationKind.STORJ)).toBe(true);
  });
  it("space_acres-only attestation 20h old earns the slot equally (no penalty for missing storj)", () => {
    const r = accrueDeviceFromEvidence(online, [ev(IntegrationKind.SPACE_ACRES, 20 * H)], intervalStart, policy, now);
    expect(r.eligible).toBe(true);
    expect(r.amountBase).toBe(50n);
    expect(r.storageCapabilityCounted).toBe(true);
  });
  it("both healthy -> slot counted ONCE (50n, not 100n)", () => {
    const r = accrueDeviceFromEvidence(
      online,
      [ev(IntegrationKind.STORJ, 1 * H), ev(IntegrationKind.SPACE_ACRES, 20 * H)],
      intervalStart,
      policy,
      now
    );
    expect(r.amountBase).toBe(50n);
    expect(r.storageCapabilityCounted).toBe(true);
  });
  it("neither provider present: other integrations pay in full — absence is never a penalty", () => {
    const r = accrueDeviceFromEvidence(online, [ev(IntegrationKind.BANDWIDTH, 60)], intervalStart, policy, now);
    expect(r.eligible).toBe(true);
    expect(r.amountBase).toBe(100n);
    expect(r.storageCapabilityCounted).toBe(false);
  });
});

describe("storage slot — binary 100%/0%, failure = ineligibility not reduction", () => {
  it("attestation beyond 24h -> slot lost ENTIRELY, other integrations unaffected", () => {
    const r = accrueDeviceFromEvidence(
      online,
      [ev(IntegrationKind.STORJ, 25 * H), ev(IntegrationKind.BANDWIDTH, 60)],
      intervalStart,
      policy,
      now
    );
    expect(r.amountBase).toBe(100n);
    expect(r.storageCapabilityCounted).toBe(false);
  });
  it("boundary: exactly 24h earns, 24h+1s loses (binary)", () => {
    const atWin = accrueDeviceFromEvidence(
      online, [ev(IntegrationKind.STORJ, STORAGE_ATTESTATION_MAX_AGE_SECONDS)], intervalStart, policy, now);
    expect(atWin.amountBase).toBe(50n);
    const past = accrueDeviceFromEvidence(
      online, [ev(IntegrationKind.STORJ, STORAGE_ATTESTATION_MAX_AGE_SECONDS + 1)], intervalStart, policy, now);
    expect(past.amountBase).toBe(0n);
    expect(past.eligible).toBe(false);
  });
  it("amount sweep: always exactly 0n or the full slot weight — never fractional", () => {
    for (const age of [0, 1 * H, 12 * H, 23 * H, 24 * H, 24 * H + 1, 48 * H]) {
      const r = accrueDeviceFromEvidence(online, [ev(IntegrationKind.STORJ, age)], intervalStart, policy, now);
      expect([0n, 50n]).toContain(r.amountBase);
    }
  });
  it("unhealthy storage attestation (reported failure) -> slot ineligible", () => {
    const r = accrueDeviceFromEvidence(online, [ev(IntegrationKind.STORJ, 60, false)], intervalStart, policy, now);
    expect(r.amountBase).toBe(0n);
    expect(r.storageCapabilityCounted).toBe(false);
  });
});

describe("storage window never loosens non-storage integrations", () => {
  it("COMPUTE evidence 20h old stays excluded (default 600s window)", () => {
    const set = buildHealthySetForAccrual([ev(IntegrationKind.COMPUTE, 20 * H)], now, policy);
    expect(set.has(IntegrationKind.COMPUTE)).toBe(false);
    const r = accrueDeviceFromEvidence(online, [ev(IntegrationKind.COMPUTE, 20 * H)], intervalStart, policy, now);
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReason).toBe("no_qualifying_integration");
  });
});

describe("ghost gate composes: offline pays zero even with a valid storage attestation", () => {
  it("stale heartbeat + healthy storj -> zero", () => {
    const offline = { ...online, lastHeartbeatAt: new Date(now.getTime() - 2 * H * 1000) };
    const r = accrueDeviceFromEvidence(offline, [ev(IntegrationKind.STORJ, 60)], intervalStart, policy, now);
    expect(r.eligible).toBe(false);
    expect(r.amountBase).toBe(0n);
    expect(r.ineligibleReason).toBe("offline_or_stale_heartbeat");
  });
});

describe("policy override of the attestation window", () => {
  it("storageAttestationMaxAgeSeconds honored", () => {
    const tight: RewardPolicyConfig = { ...policy, storageAttestationMaxAgeSeconds: 3600 };
    expect(
      accrueDeviceFromEvidence(online, [ev(IntegrationKind.STORJ, 30 * 60)], intervalStart, tight, now).amountBase
    ).toBe(50n);
    expect(
      accrueDeviceFromEvidence(online, [ev(IntegrationKind.STORJ, 2 * H)], intervalStart, tight, now).amountBase
    ).toBe(0n);
  });
});
