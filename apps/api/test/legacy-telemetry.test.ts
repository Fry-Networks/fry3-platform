/**
 * P7.1 conformance suite for the legacy hardwareapi telemetry compat routes.
 * Every asserted status code and body shape below is proven verbatim from the frozen
 * source (ZEUS00 hardware_exe_api app.py + models.py, read 2026-07-21) — this file
 * REPLACES the P4b4b suite whose shapes were explicitly logged as guessed
 * ("{detail:} error shape guessed (P7 replay asserts)"). Correction justification and
 * the frozen-source evidence are in C:/FryRewrite/progress.log (P7.1 entry).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildServer, ApiStore } from "../src/server";
import { measurementTypeToKind, hashDeviceToken, FEM_KEY_RE } from "../src/legacy-telemetry";
import { RewardPolicyConfig } from "@fry3/reward-policy";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: { BANDWIDTH: 100n } as any,
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const FEM_KEY = "REDACTED_ROTATE_ME"; // matches ^FEM-[a-zA-Z0-9]{32}$
const GENERAL_TOKEN = "test-general-bearer";

function makeStore() {
  const installs: any[] = [];
  const measurements: any[] = [];
  const store: any = {
    async getDeviceState() { return null; },
    async heartbeatNonceExists() { return false; },
    async persistHeartbeat() {},
    async getReservableBalanceBase() { return 0n; },
    async claimByIdempotencyKey() { return null; },
    async createClaimTransactional() { return { id: "x" }; },
    async legacyInstallationHeartbeat(input: any) {
      // Open registration: the real store auto-creates unknown miners; it only
      // refuses on pathological state (registration owner row missing).
      if (input.minerKey === "mk-owner-missing") return { ok: false, reason: "registration_owner_missing" };
      installs.push(input);
      return { ok: true };
    },
    async legacyMeasurement(input: any) {
      if (input.installId === "inst-unknown") return { ok: false, reason: "unknown_install" };
      measurements.push(input);
      return { ok: true };
    },
  };
  return Object.assign(store as ApiStore, { installs, measurements });
}

describe("legacy hardwareapi telemetry conformance (frozen-source shapes)", () => {
  let app: ReturnType<typeof buildServer>;
  let store: ReturnType<typeof makeStore>;
  const savedEnv = process.env.API_BEARER_TOKEN;
  beforeAll(async () => { store = makeStore(); app = buildServer({ policy, store }); await app.ready(); });
  afterAll(async () => { await app.close(); process.env.API_BEARER_TOKEN = savedEnv; });
  beforeEach(() => { store.installs.length = 0; store.measurements.length = 0; process.env.API_BEARER_TOKEN = GENERAL_TOKEN; });

  it("measurementTypeToKind mapping unchanged", () => {
    expect(measurementTypeToKind("storj")).toBe("STORJ");
    expect(measurementTypeToKind("space-acres")).toBe("SPACE_ACRES");
    expect(measurementTypeToKind("satellite")).toBe("OTHER");
    expect(measurementTypeToKind(null)).toBe("OTHER");
  });

  // ---- heartbeat: POST /installations/{mk}/installations/{iid} ----

  it("FEM heartbeat -> 202 {status:'ok', device_token: fem_<64hex>}; sha256 hash reaches store", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/installations/${FEM_KEY}/installations/inst-1`,
      payload: { miner_key: FEM_KEY, install_id: "inst-1", software_version_installed: "1.2.3" },
    });
    expect(r.statusCode).toBe(202);
    const j = r.json();
    expect(j.status).toBe("ok");
    expect(j.device_token).toMatch(/^fem_[0-9a-f]{64}$/);
    expect(j.device_token).toHaveLength(68);
    expect(store.installs).toHaveLength(1);
    expect(store.installs[0].deviceTokenHash).toBe(hashDeviceToken(j.device_token));
    expect(store.installs[0].version).toBe("1.2.3");
  });

  it("FEM heartbeat rotates device_token per request (fresh token each time)", async () => {
    const t1 = (await app.inject({ method: "POST", url: `/installations/${FEM_KEY}/installations/inst-1`, payload: { miner_key: FEM_KEY, install_id: "inst-1" } })).json().device_token;
    const t2 = (await app.inject({ method: "POST", url: `/installations/${FEM_KEY}/installations/inst-1`, payload: { miner_key: FEM_KEY, install_id: "inst-1" } })).json().device_token;
    expect(t1).not.toBe(t2);
  });

  it("FEM heartbeat is open registration — no auth header required, never 404", async () => {
    delete process.env.API_BEARER_TOKEN;
    const r = await app.inject({
      method: "POST",
      url: `/installations/${FEM_KEY}/installations/inst-new`,
      payload: { miner_key: FEM_KEY, install_id: "inst-new" },
    });
    expect(r.statusCode).toBe(202);
    expect(store.installs).toHaveLength(1);
  });

  it("non-FEM heartbeat with correct shared bearer -> 202 {status:'ok', device_token:null}", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/installations/BM-abc/installations/inst-2",
      headers: { authorization: `Bearer ${GENERAL_TOKEN}` },
      payload: { miner_key: "BM-abc", install_id: "inst-2" },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ status: "ok", device_token: null });
    expect(store.installs[0].deviceTokenHash).toBeNull();
  });

  it("non-FEM heartbeat without bearer -> 401 {'detail':'Invalid authentication token'} + WWW-Authenticate", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/installations/BM-abc/installations/inst-2",
      payload: { miner_key: "BM-abc", install_id: "inst-2" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ detail: "Invalid authentication token" });
    expect(r.headers["www-authenticate"]).toBe("Bearer");
    expect(store.installs).toHaveLength(0);
  });

  it("non-FEM heartbeat with wrong bearer -> 401 same shape", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/installations/BM-abc/installations/inst-2",
      headers: { authorization: "Bearer nope" },
      payload: { miner_key: "BM-abc", install_id: "inst-2" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ detail: "Invalid authentication token" });
  });

  it("non-FEM heartbeat with env unset -> 401 (frozen: expected='' rejects every token)", async () => {
    delete process.env.API_BEARER_TOKEN;
    const r = await app.inject({
      method: "POST",
      url: "/installations/BM-abc/installations/inst-2",
      headers: { authorization: `Bearer ${GENERAL_TOKEN}` },
      payload: { miner_key: "BM-abc", install_id: "inst-2" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("body/path identity mismatch -> 400 {'detail':'Body miner identity mismatch'} (before auth)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/installations/BM-abc/installations/inst-2",
      payload: { miner_key: "BM-other", install_id: "inst-2" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ detail: "Body miner identity mismatch" });
    expect(store.installs).toHaveLength(0);
  });

  it("missing required heartbeat fields -> 422 FastAPI-style detail array", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/installations/${FEM_KEY}/installations/inst-1`,
      payload: { install_id: "inst-1" },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ detail: [{ type: "missing", loc: ["body", "miner_key"], msg: "Field required", input: null }] });
  });

  it("pathological store refusal (owner row missing) -> 500, not 404", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/installations/mk-owner-missing/installations/inst-9",
      headers: { authorization: `Bearer ${GENERAL_TOKEN}` },
      payload: { miner_key: "mk-owner-missing", install_id: "inst-9" },
    });
    expect(r.statusCode).toBe(500);
  });

  // ---- measurement: POST /measurements/{hex_id} ----

  const MEAS = { miner_code: "BM", install_id: "inst-1", timestamp: "2026-07-20T12:00:00Z", measurement_type: "storj", value: { used_gb: 10 } };

  it("measurement happy path -> 202 {'ok':true}; STORJ kind + timestamp reach store", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/measurements/abc123",
      headers: { authorization: `Bearer ${GENERAL_TOKEN}` },
      payload: MEAS,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    expect(store.measurements).toHaveLength(1);
    expect(store.measurements[0].hexId).toBe("abc123");
    expect(store.measurements[0].integration).toBe("STORJ");
    expect(store.measurements[0].timestamp?.toISOString()).toBe("2026-07-20T12:00:00.000Z");
  });

  it("measurement env unset -> 500 {'detail':'API_BEARER_TOKEN not configured on server'}", async () => {
    delete process.env.API_BEARER_TOKEN;
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: `Bearer ${GENERAL_TOKEN}` }, payload: MEAS });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ detail: "API_BEARER_TOKEN not configured on server" });
  });

  it("measurement without token -> 401 {'detail':'Missing authentication token'}", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", payload: MEAS });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ detail: "Missing authentication token" });
    expect(r.headers["www-authenticate"]).toBe("Bearer");
  });

  it("measurement with wrong token -> 401 {'detail':'Invalid authentication token'}", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: "Bearer nope" }, payload: MEAS });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ detail: "Invalid authentication token" });
  });

  it("measurement unresolvable install -> STILL 202 {'ok':true} (frozen backend never 404s)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/measurements/abc123",
      headers: { authorization: `Bearer ${GENERAL_TOKEN}` },
      payload: { ...MEAS, install_id: "inst-unknown" },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    expect(store.measurements).toHaveLength(0);
  });

  it("measurement missing fields -> 422 with one entry per missing field", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: `Bearer ${GENERAL_TOKEN}` }, payload: { miner_code: "BM" } });
    expect(r.statusCode).toBe(422);
    const d = r.json().detail;
    expect(d.map((e: any) => e.loc[1]).sort()).toEqual(["install_id", "measurement_type", "timestamp", "value"]);
    for (const e of d) expect(e).toMatchObject({ type: "missing", msg: "Field required" });
  });

  it("measurement invalid miner_code -> 422 enum error", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: `Bearer ${GENERAL_TOKEN}` }, payload: { ...MEAS, miner_code: "ZZ" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail[0]).toMatchObject({ type: "enum", loc: ["body", "miner_code"], input: "ZZ" });
  });

  it("measurement non-dict value -> 422 dict_type", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: `Bearer ${GENERAL_TOKEN}` }, payload: { ...MEAS, value: 5 } });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail[0]).toMatchObject({ type: "dict_type", loc: ["body", "value"] });
  });

  it("FEM_KEY_RE matches migrated key format, rejects wrong lengths", () => {
    expect(FEM_KEY_RE.test("FEM-JNKL6O7MEDBNSEU2HD3RLM7F30KFZSBY")).toBe(true);
    expect(FEM_KEY_RE.test("FEM-short")).toBe(false);
    expect(FEM_KEY_RE.test("BM-JNKL6O7MEDBNSEU2HD3RLM7F30KFZSBY")).toBe(false);
  });
});
