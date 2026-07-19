import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer, DEFAULT_POLICY } from "../src/server";
import { RewardPolicyConfig } from "@fry3/reward-policy";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: { BANDWIDTH: 100n } as any,
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

let app: ReturnType<typeof buildServer>;
beforeAll(async () => { app = buildServer({ policy }); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("health", () => {
  it("GET /health", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("ok");
  });
});

describe("heartbeat", () => {
  it("rejects invalid envelope", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/heartbeat", payload: { deviceId: "", nonce: "x", signature: "" } });
    expect(r.statusCode).toBe(400);
  });
  it("accepts valid envelope", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/heartbeat", payload: { deviceId: "d1", nonce: "abcdefgh12345678", signature: "sig" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });
});

describe("reward preview", () => {
  it("offline device -> zero", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/rewards/preview", payload: { deviceId: "d1", status: "OFFLINE", secondsSinceLastHeartbeat: 9999, evidence: [] } });
    const j = r.json();
    expect(j.eligible).toBe(false);
    expect(j.amountBase).toBe("0");
  });
  it("online + bandwidth -> weight", async () => {
    const now = new Date().toISOString();
    const r = await app.inject({ method: "POST", url: "/api/v1/rewards/preview", payload: { deviceId: "d1", status: "ONLINE", secondsSinceLastHeartbeat: 10, evidence: [{ integration: "BANDWIDTH", healthy: true, evidenceAt: now, evidenceType: "telemetry" }] } });
    const j = r.json();
    expect(j.eligible).toBe(true);
    expect(j.amountBase).toBe("100");
  });
  it("storage counted once (storj+space_acres)", async () => {
    const now = new Date().toISOString();
    const ev = (i: string) => ({ integration: i, healthy: true, evidenceAt: now, evidenceType: "telemetry" });
    const r = await app.inject({ method: "POST", url: "/api/v1/rewards/preview", payload: { deviceId: "d1", status: "ONLINE", secondsSinceLastHeartbeat: 10, evidence: [ev("STORJ"), ev("SPACE_ACRES")] } });
    const j = r.json();
    expect(j.amountBase).toBe("50"); // NOT 100
    expect(j.storageCapabilityCounted).toBe(true);
  });
});

describe("claims", () => {
  it("rejects cross-user claim", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/claims", payload: { reservableBalanceBase: "1000", hotWalletBalanceBase: "5000", destination: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ", destinationOwnerUserId: "u2", requestingUserId: "u1", idempotencyKey: "u1:n1" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toBe("destination_not_owned_by_requester");
  });
  it("rejects insufficient hot wallet", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/claims", payload: { reservableBalanceBase: "1000", hotWalletBalanceBase: "500", destination: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ", destinationOwnerUserId: "u1", requestingUserId: "u1", idempotencyKey: "u1:n1" } });
    expect(r.statusCode).toBe(400);
  });
  it("accepts valid claim (server-calculated amount)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/claims", payload: { reservableBalanceBase: "1000", hotWalletBalanceBase: "5000", destination: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ", destinationOwnerUserId: "u1", requestingUserId: "u1", idempotencyKey: "u1:n1" } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.success).toBe(true);
    expect(j.amountBase).toBe("1000");
  });
});
