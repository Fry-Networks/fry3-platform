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

/** Frozen MinerCode enum (models.py). */
export const MINER_CODES = ["BM", "IDM", "ODM", "ISM", "OSM", "RDN", "SDN", "SVN", "IRM", "FEM"] as const;
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

export function registerLegacyTelemetry(app: FastifyInstance, store: ApiStore | undefined) {
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
    if (!isFem) {
      // Non-FEM keys require the shared bearer (checked inside the frozen handler,
      // after the identity check; missing and wrong token share one message there).
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
    const r = await store.legacyInstallationHeartbeat({
      minerKey,
      installId,
      version,
      body,
      now,
      deviceTokenHash: deviceToken ? hashDeviceToken(deviceToken) : null,
    });
    // Open registration: the store only refuses on pathological state (owner row missing).
    if (!r.ok) return reply.code(500).send({ detail: r.reason });
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
