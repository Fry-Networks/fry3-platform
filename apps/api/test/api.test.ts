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

// in-memory mock store (proves DB-backed handlers without a live PG)
function makeStore(over: Partial<ApiStore> = {}): ApiStore & { heartbeats: any[]; claims: Map<string, any> } {
  const heartbeats: any[] = [];
  const claims = new Map<string, any>();
  const nonces = new Set<string>();
  const store: any = {
    heartbeats, claims,
    async getDeviceState(id: string) {
      if (id === "d-online") return { lastHeartbeatAt: new Date(), banned: false, disabled: false };
      if (id === "d-banned") return { lastHeartbeatAt: new Date(), banned: true, disabled: false };
      return null;
    },
    async heartbeatNonceExists(n: string) { return nonces.has(n); },
    async persistHeartbeat(hb: any) { nonces.add(hb.nonce); heartbeats.push(hb); },
    async getReservableBalanceBase(uid: string) { return uid === "u-rich" ? 5000n : 0n; },
    async claimByIdempotencyKey(k: string) { return claims.get(k) ?? null; },
    async createClaimTransactional(input: any) {
      const c = { id: "claim-1", status: "RESERVED", ...input };
      claims.set(input.idempotencyKey, c);
      return c;
    },
    ...over,
  };
  return store;
}

const ADDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

describe("api (DB-backed handlers)", () => {
  let app: ReturnType<typeof buildServer>;
  let store: ReturnType<typeof makeStore>;
  beforeAll(async () => { store = makeStore(); app = buildServer({ policy, store }); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("health", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });

  it("heartbeat persists + replay rejected", async () => {
    const hb = { deviceId: "d-online", nonce: "nonce-unique-1", signature: "sig" };
    const r1 = await app.inject({ method: "POST", url: "/api/v1/heartbeat", payload: hb });
    expect(r1.statusCode).toBe(200);
    expect(store.heartbeats).toHaveLength(1);
    // replay same nonce -> 409
    const r2 = await app.inject({ method: "POST", url: "/api/v1/heartbeat", payload: hb });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().reason).toBe("nonce_replay");
  });

  it("device status DB-backed", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/devices/d-online/status" });
    expect(r.json().status).toBe("ONLINE");
    const rb = await app.inject({ method: "GET", url: "/api/v1/devices/d-banned/status" });
    expect(rb.json().status).toBe("BANNED");
    const rn = await app.inject({ method: "GET", url: "/api/v1/devices/unknown/status" });
    expect(rn.statusCode).toBe(404);
  });

  it("reward preview offline=0", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/rewards/preview", payload: { deviceId: "d1", status: "OFFLINE", secondsSinceLastHeartbeat: 9999, evidence: [] } });
    expect(r.json().amountBase).toBe("0");
  });

  it("claim: server-calculated, transactional, idempotent", async () => {
    const payload = { requestingUserId: "u-rich", destinationOwnerUserId: "u-rich", destination: ADDR, hotWalletBalanceBase: "10000", idempotencyKey: "u-rich:k1" };
    const r1 = await app.inject({ method: "POST", url: "/api/v1/claims", payload });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().status).toBe("RESERVED");
    expect(r1.json().amountBase).toBe("5000"); // server-derived reservable, not client
    // idempotent replay -> returns existing, no duplicate
    const r2 = await app.inject({ method: "POST", url: "/api/v1/claims", payload });
    expect(r2.json().idempotent).toBe(true);
    expect(store.claims.size).toBe(1);
  });

  it("claim: zero balance rejected", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/claims", payload: { requestingUserId: "u-poor", destinationOwnerUserId: "u-poor", destination: ADDR, hotWalletBalanceBase: "10000", idempotencyKey: "u-poor:k1" } });
    expect(r.statusCode).toBe(400);
  });

  it("claim: cross-user rejected", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/claims", payload: { requestingUserId: "u-rich", destinationOwnerUserId: "u-other", destination: ADDR, hotWalletBalanceBase: "10000", idempotencyKey: "u-rich:k2" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toBe("destination_not_owned_by_requester");
  });

  it("claim: idempotency key required", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/claims", payload: { requestingUserId: "u-rich" } });
    expect(r.statusCode).toBe(400);
  });
});
