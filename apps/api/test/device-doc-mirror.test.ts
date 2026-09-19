/**
 * Item 1 — main.devices mirror for the public registration route.
 *
 * Gap being closed: ZEUS00's hardwareapi creates the pending `main.devices` doc on
 * registration via MongoStore._ensure_fem_device_doc (storage.py:1084), whose prefix
 * guard was widened to ("FEM-", "IOT-") on 2026-09-08. After the registration split,
 * IOT- devices register against fry3-api on ARES00 instead, which had no equivalent
 * mirror — so 13 live IOT devices heartbeat into Postgres with no main.devices doc and
 * are invisible to the dashboard and reward tooling.
 *
 * This suite is NEW (the six pre-existing harness files are byte-frozen for this run).
 * Doc shape is ported verbatim from storage.py:1094-1113 — same collection, same
 * $setOnInsert field set, same per-family display name, same never-clobber contract.
 */
import { describe, it, expect } from "vitest";
import { buildServer, ApiStore } from "../src/server";
import { buildDeviceDocInsert, deviceDocName, DEVICE_DOC_DB, DEVICE_DOC_COLLECTION } from "../src/fem-token-mongo-sink";
import { RewardPolicyConfig } from "@fry3/reward-policy";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: { BANDWIDTH: 100n } as any,
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

// The mirror's family tuple still contains IOT-, and buildDeviceDocInsert must keep
// handling it: documents created before the 2026-09-18 prefix migration still carry IOT-
// keys. So the PURE cases below deliberately keep an IOT- key. The ROUTE cases use
// ESP_KEY, because after the migration IOT- is no longer open registration and would be
// answered with a 401 rather than exercising the mirror.
const IOT_KEY = "IOT-8E6709628F2B553A5680E9329B941A64";
const ESP_KEY = "FEM-8E6709628F2B553A5680E9329B941A64";
const FEM_KEY = "FEM-A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6";
const BM_KEY = "BM-000000000000000000000000000000AA";

function makeStore() {
  const store: any = {
    async getDeviceState() { return null; },
    async heartbeatNonceExists() { return false; },
    async persistHeartbeat() {},
    async getReservableBalanceBase() { return 0n; },
    async claimByIdempotencyKey() { return null; },
    async createClaimTransactional() { return { id: "x" }; },
    async legacyInstallationHeartbeat() { return { ok: true }; },
    async legacyMeasurement() { return { ok: true }; },
  };
  return store as ApiStore;
}

function heartbeatBody(minerKey: string, installId: string) {
  return {
    miner_key: minerKey,
    install_id: installId,
    minerCode: "IOTVPN",
    software_version_installed: "0.3.1",
    poc_version_installed: "1.0.0",
    hostname: "regtest",
    os: "esp32",
    is_installed: true,
  };
}

describe("main.devices doc shape (ported from ZEUS00 storage.py:1084)", () => {
  it("targets the same database and collection as the hardwareapi dual-write", () => {
    expect(DEVICE_DOC_DB).toBe("main");
    expect(DEVICE_DOC_COLLECTION).toBe("devices");
  });

  it("names an IOT- device 'Fry IoT VPN Node'", () => {
    expect(deviceDocName(IOT_KEY)).toBe("Fry IoT VPN Node");
  });

  it("names a FEM- device 'Fry Edge Miner'", () => {
    expect(deviceDocName(FEM_KEY)).toBe("Fry Edge Miner");
  });

  it("builds the canonical $setOnInsert field set for an IOT- key", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const doc = buildDeviceDocInsert(IOT_KEY, now);
    expect(doc).toEqual({
      miner_key: IOT_KEY,
      created_at: now,
      is_registered: false,
      enabled: true,
      verified: false,
      name: "Fry IoT VPN Node",
    });
  });

  it("builds the same shape for a FEM- key, differing only in name", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const doc = buildDeviceDocInsert(FEM_KEY, now) as Record<string, unknown>;
    expect(doc.name).toBe("Fry Edge Miner");
    expect(Object.keys(doc).sort()).toEqual(
      ["created_at", "enabled", "is_registered", "miner_key", "name", "verified"],
    );
  });

  it("returns null for a key outside the (FEM-, IOT-) family tuple", () => {
    // Mirrors storage.py's early `return` — BM/RDN/etc. get no device doc.
    expect(buildDeviceDocInsert(BM_KEY, new Date())).toBeNull();
  });

  it("never includes dashboard-owned mutable fields in the insert", () => {
    // _ensure_fem_device_doc deliberately never clobbers these on an existing doc.
    // They may only ever appear under $setOnInsert, never $set.
    const doc = buildDeviceDocInsert(IOT_KEY, new Date()) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("address");
    expect(doc).not.toHaveProperty("reward_wallet");
    expect(doc).not.toHaveProperty("device_algo_address");
  });
});

describe("registration route invokes the device-doc mirror", () => {
  it("calls the mirror with the miner key on a successful IOT- registration", async () => {
    const seen: string[] = [];
    const app = buildServer({
      policy,
      store: makeStore(),
      deviceDocMirror: async (minerKey: string) => { seen.push(minerKey); return { ok: true }; },
    } as any);
    const res = await app.inject({
      method: "POST",
      url: `/installations/${ESP_KEY}/installations/inst-1`,
      payload: heartbeatBody(ESP_KEY, "inst-1"),
    });
    expect(res.statusCode).toBe(202);
    expect(seen).toEqual([ESP_KEY]);
  });

  it("still returns 202 when the mirror fails — the device must never see the error", async () => {
    const app = buildServer({
      policy,
      store: makeStore(),
      deviceDocMirror: async () => ({ ok: false, error: "mongo down" }),
    } as any);
    const res = await app.inject({
      method: "POST",
      url: `/installations/${ESP_KEY}/installations/inst-2`,
      payload: heartbeatBody(ESP_KEY, "inst-2"),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "ok", device_token: expect.stringMatching(/^fem_[0-9a-f]{64}$/) });
  });

  it("still returns 202 when the mirror throws", async () => {
    const app = buildServer({
      policy,
      store: makeStore(),
      deviceDocMirror: async () => { throw new Error("boom"); },
    } as any);
    const res = await app.inject({
      method: "POST",
      url: `/installations/${ESP_KEY}/installations/inst-3`,
      payload: heartbeatBody(ESP_KEY, "inst-3"),
    });
    expect(res.statusCode).toBe(202);
  });

  it("behaves identically to pre-change when no mirror is injected", async () => {
    const app = buildServer({ policy, store: makeStore() });
    const res = await app.inject({
      method: "POST",
      url: `/installations/${ESP_KEY}/installations/inst-4`,
      payload: heartbeatBody(ESP_KEY, "inst-4"),
    });
    expect(res.statusCode).toBe(202);
  });
});
