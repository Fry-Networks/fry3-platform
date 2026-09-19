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
import { buildInstallationFieldSet, INSTALLATION_MIRROR_FIELDS } from "../src/fem-token-mongo-sink";
import { RewardPolicyConfig } from "@fry3/reward-policy";

const policy: RewardPolicyConfig = {
  version: 1,
  weights: { BANDWIDTH: 100n } as any,
  storageCapabilityWeight: 50n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const FEM_KEY = "FEM-A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6"; // matches ^FEM-[a-zA-Z0-9]{32}$
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

  // IOTVPN was missing from MINER_CODES while IOT- devices were already registering through the
  // sibling /installations route, so a measurement from one would have been rejected 422 on a
  // code the fleet actually ships. The "ZZ" case above pins that unknown codes still fail; this
  // pins that IOTVPN specifically does not.
  it("measurement miner_code IOTVPN -> accepted, not 422", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: `Bearer ${GENERAL_TOKEN}` }, payload: { ...MEAS, miner_code: "IOTVPN" } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
  });

  it("measurement non-dict value -> 422 dict_type", async () => {
    const r = await app.inject({ method: "POST", url: "/measurements/abc123", headers: { authorization: `Bearer ${GENERAL_TOKEN}` }, payload: { ...MEAS, value: 5 } });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail[0]).toMatchObject({ type: "dict_type", loc: ["body", "value"] });
  });

  it("IOT- is NO LONGER open registration after the 2026-09-18 prefix migration", async () => {
    // Inverted deliberately. This used to assert that an IOT- key self-registered without
    // a bearer and got a null device_token. The migration removed IOT- from
    // OPEN_REG_PREFIXES, so the same request must now be refused — this test is the guard
    // that the prefix cannot quietly come back.
    delete process.env.API_BEARER_TOKEN;
    const r = await app.inject({
      method: "POST",
      url: "/installations/IOT-66BC2519A564361ED6AC53443D0F28A7/installations/inst-iot",
      payload: { miner_key: "IOT-66BC2519A564361ED6AC53443D0F28A7", install_id: "inst-iot" },
    });
    expect(r.statusCode).toBe(401);
    expect(store.installs).toHaveLength(0);
  });

  it("FEM_KEY_RE matches migrated key format, rejects wrong lengths", () => {
    expect(FEM_KEY_RE.test("FEM-JNKL6O7MEDBNSEU2HD3RLM7F30KFZSBY")).toBe(true);
    expect(FEM_KEY_RE.test("FEM-short")).toBe(false);
    expect(FEM_KEY_RE.test("BM-JNKL6O7MEDBNSEU2HD3RLM7F30KFZSBY")).toBe(false);
  });
});

/**
 * The installation FIELD mirror.
 *
 * PoC.installations is what the dashboard and fleet tooling read. Before this, the
 * only write to it from this service was the token mirror, whose contract is to set
 * device_token_hash + device_token_rotated_at and nothing else — so os, hostname,
 * device_name, is_installed and both versions had no path into that collection at
 * all, fleet-wide, for every device registering through the public endpoint.
 */
describe("installation field mirror (PoC.installations heartbeat fields)", () => {
  describe("buildInstallationFieldSet (pure)", () => {
    it("mirrors every supplied field", () => {
      const set = buildInstallationFieldSet({
        miner_key: FEM_KEY,
        install_id: "inst-1",
        software_version_installed: "0.4.33",
        poc_version_installed: "1.0.0",
        os: "windows",
        hostname: "TEST-HOST",
        device_name: "rare-daring-bobcat",
        is_installed: true,
      });
      expect(set).toEqual({
        software_version_installed: "0.4.33",
        poc_version_installed: "1.0.0",
        os: "windows",
        hostname: "TEST-HOST",
        device_name: "rare-daring-bobcat",
        is_installed: true,
      });
    });

    it("never mirrors identity or any unlisted key", () => {
      const set = buildInstallationFieldSet({
        miner_key: FEM_KEY,
        install_id: "inst-1",
        minerCode: "FEM",
        device_token_hash: "should-never-be-touched",
        os: "windows",
      });
      // minerCode is a LISTED key as of 2026-09-18; miner_key, install_id and
      // device_token_hash remain unlisted and must still be dropped.
      expect(Object.keys(set)).toEqual(["os", "minerCode"]);
      expect(INSTALLATION_MIRROR_FIELDS).not.toContain("device_token_hash" as never);
    });

    /**
     * The must-not-clobber control. The frozen handler writes null for anything the
     * body omits; doing that here would erase good values — software_version_installed
     * in particular is kept current by a second, independent mirror on ZEUS00.
     */
    it("omits absent fields rather than nulling them", () => {
      const set = buildInstallationFieldSet({ miner_key: FEM_KEY, install_id: "i" });
      expect(set).toEqual({});
      expect("os" in set).toBe(false);
    });

    it("treats an explicit null as no-news, not as erase", () => {
      const set = buildInstallationFieldSet({
        software_version_installed: null,
        poc_version_installed: null,
        os: null,
        hostname: null,
        is_installed: null,
        device_name: "keep-me",
      });
      expect(set).toEqual({ device_name: "keep-me" });
    });

    it("skips an empty or whitespace device_name (frozen handler pops it)", () => {
      expect(buildInstallationFieldSet({ device_name: "" })).toEqual({});
      expect(buildInstallationFieldSet({ device_name: "   " })).toEqual({});
    });

    /** false is falsy but it is REAL news — a device reporting not-installed. */
    it("mirrors is_installed:false, which is meaningful and not absence", () => {
      expect(buildInstallationFieldSet({ is_installed: false })).toEqual({ is_installed: false });
    });
  });

  describe("route wiring", () => {
    let app: ReturnType<typeof buildServer>;
    let store: ReturnType<typeof makeStore>;
    let mirrored: Array<{ minerKey: string; installId: string; body: Record<string, unknown> }>;
    let mirrorResult: { ok: boolean; error?: string };
    const savedEnv = process.env.API_BEARER_TOKEN;

    beforeAll(async () => {
      store = makeStore();
      mirrored = [];
      app = buildServer({
        policy,
        store,
        fieldMirror: async (minerKey, installId, body) => {
          mirrored.push({ minerKey, installId, body });
          return mirrorResult;
        },
      });
      await app.ready();
    });
    afterAll(async () => { await app.close(); process.env.API_BEARER_TOKEN = savedEnv; });
    beforeEach(() => {
      store.installs.length = 0;
      mirrored.length = 0;
      mirrorResult = { ok: true };
      process.env.API_BEARER_TOKEN = GENERAL_TOKEN;
    });

    it("a FEM heartbeat mirrors its fields, keyed by {miner_key, install_id}", async () => {
      const body = {
        miner_key: FEM_KEY,
        install_id: "inst-1",
        software_version_installed: "0.4.33",
        poc_version_installed: "1.0.0",
        os: "windows",
        hostname: "TEST-HOST",
        device_name: "rare-daring-bobcat",
        is_installed: true,
      };
      const res = await app.inject({ method: "POST", url: `/installations/${FEM_KEY}/installations/inst-1`, payload: body });
      expect(res.statusCode).toBe(202);
      expect(mirrored).toHaveLength(1);
      expect(mirrored[0].minerKey).toBe(FEM_KEY);
      expect(mirrored[0].installId).toBe("inst-1");
      expect(buildInstallationFieldSet(mirrored[0].body)).toEqual({
        software_version_installed: "0.4.33",
        poc_version_installed: "1.0.0",
        os: "windows",
        hostname: "TEST-HOST",
        device_name: "rare-daring-bobcat",
        is_installed: true,
      });
    });

    /**
     * IOTVPN regression guard. IOT- devices self-register through this same route and
     * MINER_CODES has no "IOTVPN" entry — that enum lives on the /measurements route,
     * not this one, and persisting the body must never drag this route through it.
     * ESP firmware is shipped; a 422 here would break provisioning fleet-wide.
     */
    it("an IOTVPN body still gets 202 and is mirrored (no enum validation on this route)", async () => {
      // The subject of this test is the miner CODE "IOTVPN", not the key prefix. Since
      // the 2026-09-18 migration ESP boards carry FEM- keys, so the key literal moved
      // with them; minerCode stays IOTVPN, which is what the test actually guards. The
      // device_token expectation flips from null to a real token because a FEM- key now
      // takes the normal issuance path -- that is the migration working, not a regression.
      const ESP_KEY = "FEM-66BC2519A564361ED6AC53443D0F28A7";
      const res = await app.inject({
        method: "POST",
        url: `/installations/${ESP_KEY}/installations/inst-iot`,
        payload: {
          miner_key: ESP_KEY,
          install_id: "inst-iot",
          minerCode: "IOTVPN",
          os: "esp32",
          software_version_installed: "0.3.1",
          is_installed: true,
        },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().device_token).toMatch(/^fem_[0-9a-f]{64}$/);
      expect(mirrored).toHaveLength(1);
      expect(buildInstallationFieldSet(mirrored[0].body)).toEqual({
        os: "esp32",
        software_version_installed: "0.3.1",
        is_installed: true,
        minerCode: "IOTVPN",
      });
    });

    it("a mirror failure never changes the 202 or the device_token", async () => {
      mirrorResult = { ok: false, error: "mongo down" };
      const res = await app.inject({
        method: "POST",
        url: `/installations/${FEM_KEY}/installations/inst-1`,
        payload: { miner_key: FEM_KEY, install_id: "inst-1", os: "windows" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("ok");
      expect(res.json().device_token).toMatch(/^fem_[0-9a-f]{64}$/);
    });

    it("is not called when the heartbeat itself was rejected", async () => {
      const mismatch = await app.inject({
        method: "POST",
        url: "/installations/BM-abc/installations/inst-2",
        payload: { miner_key: "BM-other", install_id: "inst-2" },
      });
      expect(mismatch.statusCode).toBe(400);

      const invalid = await app.inject({
        method: "POST",
        url: `/installations/${FEM_KEY}/installations/inst-1`,
        payload: { miner_key: FEM_KEY },
      });
      expect(invalid.statusCode).toBe(422);

      // mk- is not an open-registration prefix, so it needs the shared bearer to
      // reach the store at all; without it this 401s before the store is consulted,
      // which would still prove "not mirrored" but for the wrong reason.
      const refused = await app.inject({
        method: "POST",
        url: "/installations/mk-owner-missing/installations/inst-9",
        headers: { authorization: `Bearer ${GENERAL_TOKEN}` },
        payload: { miner_key: "mk-owner-missing", install_id: "inst-9" },
      });
      expect(refused.statusCode).toBe(500);

      expect(mirrored).toHaveLength(0);
    });
  });
});
