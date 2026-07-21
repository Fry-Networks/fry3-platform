import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer, ApiStore } from "../src/server";
import { RewardPolicyConfig } from "@fry3/reward-policy";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: { BANDWIDTH: 100n } as any,
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const NOW_ISH = new Date("2026-07-20T12:00:00Z");

function makeStore() {
  // one unbound ACTIVE license, one bound license, one revoked
  const licenses: Record<string, any> = {
    "KEY-UNBOUND-1": { id: "lic-1", userId: "user-a", status: "ACTIVE", activatedAt: null, expiresAt: null, createdAt: NOW_ISH, deviceId: null },
    "KEY-BOUND-1": { id: "lic-2", userId: "user-a", status: "ACTIVE", activatedAt: NOW_ISH, expiresAt: null, createdAt: NOW_ISH, deviceId: "dev-a1" },
    "KEY-REVOKED-1": { id: "lic-3", userId: "user-a", status: "REVOKED", activatedAt: null, expiresAt: null, createdAt: NOW_ISH, deviceId: null },
  };
  const devices: Record<string, any> = {
    "dev-a1": { id: "dev-a1", ownerUserId: "user-a", label: "alpha", lastHeartbeatAt: null, banned: false, disabled: false },
    "dev-b1": { id: "dev-b1", ownerUserId: "user-b", label: "bravo", lastHeartbeatAt: null, banned: false, disabled: false },
  };
  const store: any = {
    async getDeviceState() { return null; },
    async heartbeatNonceExists() { return false; },
    async persistHeartbeat() {},
    async getReservableBalanceBase() { return 0n; },
    async claimByIdempotencyKey() { return null; },
    async createClaimTransactional() { return { id: "x" }; },
    async byodLicenseLookup(licenseKey: string) {
      const lic = licenses[licenseKey];
      if (!lic) return null;
      const d = lic.deviceId ? devices[lic.deviceId] : null;
      return {
        status: lic.status, activatedAt: lic.activatedAt, expiresAt: lic.expiresAt, createdAt: lic.createdAt,
        device: d ? { id: d.id, label: d.label, lastHeartbeatAt: d.lastHeartbeatAt, banned: d.banned, disabled: d.disabled } : null,
      };
    },
    async byodActivate(input: { licenseKey: string; deviceRef: string; now: Date }) {
      const lic = licenses[input.licenseKey];
      if (!lic) return { ok: false, code: 404, reason: "license_not_found" };
      if (lic.status !== "ACTIVE") return { ok: false, code: 409, reason: "license_not_active" };
      const d = devices[input.deviceRef];
      if (!d) return { ok: false, code: 404, reason: "device_not_found" };
      if (lic.deviceId && lic.deviceId === d.id) return { ok: true, deviceId: d.id, activatedAt: lic.activatedAt ?? input.now, idempotent: true };
      if (lic.deviceId) return { ok: false, code: 409, reason: "license_device_bound" };
      if (d.ownerUserId !== lic.userId) return { ok: false, code: 403, reason: "cross_account_denied" };
      lic.deviceId = d.id; lic.activatedAt = input.now;
      return { ok: true, deviceId: d.id, activatedAt: input.now };
    },
  };
  return store as ApiStore;
}

describe("byod licensing surface", () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(async () => { app = buildServer({ policy, store: makeStore() }); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("lookup: short/missing key -> 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/lookup", payload: { licenseKey: "abc" } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ reason: "license_key_required" });
  });

  it("lookup: unknown key -> 404, no identity leak", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/lookup", payload: { licenseKey: "KEY-DOES-NOT-EXIST" } });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ reason: "license_not_found" });
  });

  it("lookup: unbound license -> 200, device null, no userId in response", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/lookup", payload: { licenseKey: "KEY-UNBOUND-1" } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.found).toBe(true);
    expect(j.license.status).toBe("ACTIVE");
    expect(j.license.device).toBeNull();
    expect(JSON.stringify(j)).not.toContain("user-a");
  });

  it("lookup: bound license -> device present with computed status", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/lookup", payload: { licenseKey: "KEY-BOUND-1" } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.license.device.id).toBe("dev-a1");
    expect(j.license.device.label).toBe("alpha");
    expect(typeof j.license.device.status).toBe("string"); // classifyOnlineState output
  });

  it("activate: missing device -> 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/activate", payload: { licenseKey: "KEY-UNBOUND-1" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toBe("device_required");
  });

  it("activate: cross-account device -> 403", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/activate", payload: { licenseKey: "KEY-UNBOUND-1", device: "dev-b1" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ success: false, reason: "cross_account_denied" });
  });

  it("activate: revoked license -> 409", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/byod/activate", payload: { licenseKey: "KEY-REVOKED-1", device: "dev-a1" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toBe("license_not_active");
  });

  it("activate: owned device -> 200 success, then idempotent repeat", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/v1/byod/activate", payload: { licenseKey: "KEY-UNBOUND-1", device: "dev-a1" } });
    // dev-a1 already bound to KEY-BOUND-1 in mock? no cross-license check in mock — route contract is what matters here
    expect(r1.statusCode).toBe(200);
    expect(r1.json().success).toBe(true);
    expect(r1.json().deviceId).toBe("dev-a1");
    expect(r1.json().idempotent).toBe(false);
    const r2 = await app.inject({ method: "POST", url: "/api/v1/byod/activate", payload: { licenseKey: "KEY-UNBOUND-1", device: "dev-a1" } });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().idempotent).toBe(true);
  });

  it("store without byod methods -> 503 (optional interface stays optional)", async () => {
    const bare: any = {
      async getDeviceState() { return null; },
      async heartbeatNonceExists() { return false; },
      async persistHeartbeat() {},
      async getReservableBalanceBase() { return 0n; },
      async claimByIdempotencyKey() { return null; },
      async createClaimTransactional() { return { id: "x" }; },
    };
    const app2 = buildServer({ policy, store: bare as ApiStore });
    await app2.ready();
    const r = await app2.inject({ method: "POST", url: "/api/v1/byod/lookup", payload: { licenseKey: "KEY-UNBOUND-1" } });
    expect(r.statusCode).toBe(503);
    await app2.close();
  });
});
