/**
 * Legacy hardwareapi telemetry compat (frozen FEM/PoC clients).
 * Contract source (P7.1 conformance replay, 2026-07-21): verbatim frozen source read of
 * ZEUS00 /home/fry/subdomains/hardware_exe_api/app.py + models.py, plus a read-only live
 * 401 probe. Conformance-critical facts proven there (correcting P4b4b's guessed shapes):
 *   - heartbeat AND measurement success status = 202 (FastAPI HTTP_202_ACCEPTED), not 200
 *   - heartbeat success body serializes device_token even when null (FastAPI response_model
 *     without exclude_none): non-FEM -> {"status":"ok","device_token":null}
 *   - FEM keys (^FEM-[a-zA-Z0-9]{32}$) register OPEN — heartbeat IS registration, never 404 —
 *     and receive a fresh device_token = "fem_" + 64 hex on EVERY heartbeat (sha256 persisted)
 *   - body/path identity mismatch -> 400 {"detail":"Body miner identity mismatch"}
 *   - non-FEM heartbeat requires the shared bearer -> else 401
 *     {"detail":"Invalid authentication token"} + WWW-Authenticate: Bearer
 *   - measurement auth (verify_bearer_token_general): env unset -> 500
 *     {"detail":"API_BEARER_TOKEN not configured on server"}; missing token -> 401
 *     {"detail":"Missing authentication token"}; wrong -> 401 {"detail":"Invalid authentication token"}
 *   - measurement success body = {"ok":true} (GenericOk), not {}
 *   - invalid/missing body fields -> FastAPI-style 422 {"detail":[{type,loc,msg,input}]}
 *   - old backend never 404s a measurement (hex-keyed store): unresolvable install_id is
 *     still 202 {"ok":true} (persisted only when resolvable to a device — divergence logged)
 * Legacy requests carry no nonce/signature — persisted heartbeats are tagged LEGACY_UNSIGNED;
 * the canonical /api/v1/heartbeat replay defense is unchanged.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiStore } from "./server.js";

const KIND_MAP: Record<string, string> = {
  storj: "STORJ",
  space_acres: "SPACE_ACRES",
  spaceacres: "SPACE_ACRES",
  "space-acres": "SPACE_ACRES",
  bandwidth: "BANDWIDTH",
  compute: "COMPUTE",
  weather: "SENSOR_WEATHER",
  air: "SENSOR_AIR",
  water: "SENSOR_WATER",
  radiation: "SENSOR_RADIATION",
  energy: "SENSOR_ENERGY",
  camera: "CAMERA",
};

export function measurementTypeToKind(t: string | null | undefined): string {
  if (!t) return "OTHER";
  return KIND_MAP[String(t).toLowerCase()] ?? "OTHER";
}

/** Frozen heartbeat FEM regex (app.py upsert_installation). */
export const FEM_KEY_RE = /^FEM-[a-zA-Z0-9]{32}$/;

/** Miner families that may self-register without the shared bearer.
 *  Mirrors _OPEN_REG_PREFIXES in the FastAPI implementation on ZEUS00. */
export const OPEN_REG_PREFIXES = ["FEM-"] as const;

/** Frozen MinerCode enum (models.py). */
export const MINER_CODES = ["BM", "IDM", "ODM", "ISM", "OSM", "RDN", "SDN", "SVN", "IRM", "FEM", "IOTVPN"] as const;
const MINER_CODE_SET = new Set<string>(MINER_CODES);

/** fem_ + 64 hex — matches generate_device_token (secrets.token_hex(32)). */
export function generateDeviceToken(): string {
  return `fem_${randomBytes(32).toString("hex")}`;
}

/** sha256 hex — matches hash_device_token. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

type FieldError = { type: string; loc: (string | number)[]; msg: string; input: unknown };

function unprocessable(reply: FastifyReply, errors: FieldError[]) {
  return reply.code(422).send({ detail: errors });
}

function missingField(name: string): FieldError {
  return { type: "missing", loc: ["body", name], msg: "Field required", input: null };
}

export function registerLegacyTelemetry(
  app: FastifyInstance,
  store: ApiStore | undefined,
  // gap-(b) FEM device-token compat-shim (P9c): optional Mongo mirror, injected only when
  // FRY3_FEM_TOKEN_SHIM=1 (see server.ts). Undefined => behaviour identical to pre-shim.
  tokenMirror?: (minerKey: string, installId: string, deviceTokenHash: string) => Promise<{ ok: boolean; error?: string }>,
  // Mirror for the heartbeat's OWN fields (os/hostname/device_name/is_installed/
  // versions). Separate from tokenMirror because that one's contract is to write the
  // token pair and nothing else; see fem-token-mongo-sink.ts.
  fieldMirror?: (minerKey: string, installId: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>,
  // Mirror for the dashboard-visible main.devices doc. Separate again from fieldMirror:
  // that one keys on {miner_key, install_id} in PoC.installations, this one keys on
  // {miner_key} alone in main.devices. See fem-token-mongo-sink.ts.
  deviceDocMirror?: (minerKey: string) => Promise<{ ok: boolean; error?: string }>,
) {
  // POST /installations/{miner_key}/installations/{install_id}
  // 202 RegistrationResponse {status:"ok", device_token: string|null}
  app.post("/installations/:minerKey/installations/:installId", async (req, reply) => {
    if (!store?.legacyInstallationHeartbeat) return reply.code(503).send({ detail: "store_unavailable" });
    const { minerKey, installId } = req.params as { minerKey: string; installId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    // FastAPI validates the InstallationHeartbeat body before the handler runs.
    const errors: FieldError[] = [];
    if (typeof body.miner_key !== "string") errors.push(missingField("miner_key"));
    if (typeof body.install_id !== "string") errors.push(missingField("install_id"));
    if (errors.length) return unprocessable(reply, errors);

    if (body.miner_key !== minerKey || body.install_id !== installId)
      return reply.code(400).send({ detail: "Body miner identity mismatch" });

    const isFem = FEM_KEY_RE.test(minerKey);
    // Since the 2026-09-18 prefix migration there is no IOT- family: every device key is
    // FEM-, so open registration and isFem now describe the same set and IOTVPN boards
    // take the normal device-token path. FEM_KEY_RE stays [a-zA-Z0-9]{32} on purpose --
    // live FEM keys are base36, not hex, and tightening it to hex would have excluded
    // 19,993 of 20,047 devices.
    const isOpenRegistration = isFem || OPEN_REG_PREFIXES.some((prefix) => minerKey.startsWith(prefix));
    if (!isOpenRegistration) {
      // Keys outside the open-registration families require the shared bearer (checked
      // inside the frozen handler, after the identity check; missing and wrong token
      // share one message there).
      const expected = process.env.API_BEARER_TOKEN ?? "";
      const token = bearerOf(req);
      if (!token || expected === "" || token !== expected) {
        reply.header("www-authenticate", "Bearer");
        return reply.code(401).send({ detail: "Invalid authentication token" });
      }
    }

    const now = new Date();
    const version =
      (typeof body.software_version_installed === "string" && body.software_version_installed) ||
      (typeof body.poc_version_installed === "string" && body.poc_version_installed) ||
      null;
    const deviceToken = isFem ? generateDeviceToken() : null;
    const deviceTokenHash = deviceToken ? hashDeviceToken(deviceToken) : null;
    const r = await store.legacyInstallationHeartbeat({
      minerKey,
      installId,
      version,
      body,
      now,
      deviceTokenHash,
    });
    // Open registration: the store only refuses on pathological state (owner row missing).
    if (!r.ok) return reply.code(500).send({ detail: r.reason });
    // gap-(b) compat-shim: mirror the rotated hash into Mongo PoC.installations BEFORE returning
    // the token, so the still-OLD token-verified endpoints accept the fresh token (no race).
    if (isFem && deviceToken && deviceTokenHash && tokenMirror) {
      const m = await tokenMirror(minerKey, installId, deviceTokenHash);
      if (!m.ok) req.log?.warn?.({ minerKey, installId, err: m.error }, "fem_token_mongo_mirror_failed");
    }
    // Mirror the heartbeat's own fields into PoC.installations. Runs for EVERY family,
    // not just FEM: the frozen handler persists these for all of them, and IOT- devices
    // self-register through this same route. Best-effort — a mirror failure must never
    // change the 202 the device is waiting on.
    if (fieldMirror) {
      const f = await fieldMirror(minerKey, installId, body);
      if (!f.ok) req.log?.warn?.({ minerKey, installId, err: f.error }, "installation_field_mirror_failed");
    }
    // Ensure the dashboard-visible main.devices doc exists. Runs for every family the
    // mirror recognises; hardwareapi does the same on its own registration path, and
    // the upsert is $setOnInsert so the two writers cannot fight. Wrapped in its own
    // try/catch rather than relying on the mirror's: a throw here must not turn the
    // device's 202 into a 500, which is the whole point of a best-effort mirror.
    if (deviceDocMirror) {
      try {
        const dd = await deviceDocMirror(minerKey);
        if (!dd.ok) req.log?.warn?.({ minerKey, err: dd.error }, "device_doc_mirror_failed");
      } catch (e) {
        req.log?.warn?.({ minerKey, err: e instanceof Error ? e.message : String(e) }, "device_doc_mirror_threw");
      }
    }
    return reply.code(202).send({ status: "ok", device_token: deviceToken });
  });

  // POST /measurements/{hex_id} — 202 GenericOk {"ok":true}
  app.post("/measurements/:hexId", async (req, reply) => {
    if (!store?.legacyMeasurement) return reply.code(503).send({ detail: "store_unavailable" });

    // verify_bearer_token_general (frozen): env unset -> 500, missing -> 401, wrong -> 401.
    const expected = process.env.API_BEARER_TOKEN;
    if (!expected) return reply.code(500).send({ detail: "API_BEARER_TOKEN not configured on server" });
    const token = bearerOf(req);
    if (token == null) {
      reply.header("www-authenticate", "Bearer");
      return reply.code(401).send({ detail: "Missing authentication token" });
    }
    if (token !== expected) {
      reply.header("www-authenticate", "Bearer");
      return reply.code(401).send({ detail: "Invalid authentication token" });
    }

    const { hexId } = req.params as { hexId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    // MeasurementUpload: miner_code(enum) install_id timestamp measurement_type value(dict) required.
    const errors: FieldError[] = [];
    for (const f of ["miner_code", "install_id", "timestamp", "measurement_type", "value"]) {
      if (body[f] === undefined || body[f] === null) errors.push(missingField(f));
    }
    if (errors.length) return unprocessable(reply, errors);
    if (typeof body.miner_code !== "string" || !MINER_CODE_SET.has(body.miner_code)) {
      return unprocessable(reply, [
        {
          type: "enum",
          loc: ["body", "miner_code"],
          msg: `Input should be ${MINER_CODES.map((c) => `'${c}'`).join(", ")}`,
          input: body.miner_code ?? null,
        },
      ]);
    }
    if (typeof body.value !== "object" || Array.isArray(body.value)) {
      return unprocessable(reply, [
        { type: "dict_type", loc: ["body", "value"], msg: "Input should be a valid dictionary", input: body.value ?? null },
      ]);
    }

    const now = new Date();
    let reported: Date | null = null;
    if (typeof body.timestamp === "string") {
      const d = new Date(body.timestamp);
      if (!Number.isNaN(d.getTime())) reported = d;
    }
    const r = await store.legacyMeasurement({
      hexId,
      minerCode: typeof body.miner_code === "string" ? body.miner_code : null,
      installId: typeof body.install_id === "string" ? body.install_id : null,
      measurementType: typeof body.measurement_type === "string" ? body.measurement_type : null,
      integration: measurementTypeToKind(body.measurement_type as string),
      timestamp: reported,
      value: body.value ?? null,
      now,
    });
    // Frozen backend stores hex-keyed and never rejects: unresolvable installs are still
    // accepted (persisted only when resolvable — raw hex-keyed history is a logged P9 gap).
    if (!r.ok) req.log?.warn?.({ hexId, reason: r.reason }, "legacy measurement accepted but not persisted");
    return reply.code(202).send({ ok: true });
  });
}
