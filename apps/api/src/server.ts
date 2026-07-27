/**
 * Fry 3.0 canonical API — Fastify + Prisma (canonical PG).
 * Integrates reward-policy, heartbeat-ingest, claim-dispatcher, integration-health.
 * Server-side authorization. Integer/base-unit. Idempotent. Transactional claims.
 */
import Fastify from "fastify";
import { computeReward, DeviceStatus, RewardPolicyConfig } from "@fry3/reward-policy";
import { classifyOnlineState, validateHeartbeatEnvelope } from "@fry3/heartbeat-ingest";
import { evaluateClaim, ClaimStatus } from "@fry3/claim-dispatcher";
import { verifiedHealthySetWithStorageSlot } from "@fry3/integration-health";
import { registerLegacyTelemetry } from "./legacy-telemetry.js";
import { registerByod } from "./byod.js";
// gap-(b) FEM device-token compat-shim (P9c). Type-only import => erased at build, no runtime
// mongodb load; the mirror itself is dynamically imported in the isMain block only when enabled.
import type { ApiTokenMirror } from "./fem-token-mongo-sink.js";

/** Minimal store interface — implemented by Prisma store; injectable for tests. */
export interface ApiStore {
  getDeviceState(deviceId: string): Promise<{ lastHeartbeatAt: Date | null; banned: boolean; disabled: boolean } | null>;
  heartbeatNonceExists(nonce: string): Promise<boolean>;
  persistHeartbeat(hb: { deviceId: string; receivedAt: Date; reportedAt: Date | null; nonce: string; signature: string; integrationSnapshot: unknown }): Promise<void>;
  getReservableBalanceBase(userId: string): Promise<bigint>;
  claimByIdempotencyKey(key: string): Promise<{ id: string; status: string } | null>;
  createClaimTransactional(input: { userId: string; amountBase: bigint; destination: string; idempotencyKey: string }): Promise<{ id: string }>;
  legacyInstallationHeartbeat?(input: { minerKey: string; installId: string; version: string | null; body: unknown; now: Date; deviceTokenHash?: string | null }): Promise<{ ok: true } | { ok: false; reason: string }>;
  legacyMeasurement?(input: { hexId: string; minerCode: string | null; installId: string | null; measurementType: string | null; integration: string; timestamp: Date | null; value: unknown; now: Date }): Promise<{ ok: true } | { ok: false; reason: string }>;
  byodLicenseLookup?(licenseKey: string): Promise<null | { status: string; activatedAt: Date | null; expiresAt: Date | null; createdAt: Date; device: null | { id: string; label: string | null; lastHeartbeatAt: Date | null; banned: boolean; disabled: boolean } }>;
  byodActivate?(input: { licenseKey: string; deviceRef: string; now: Date }): Promise<{ ok: true; deviceId: string; activatedAt: Date; idempotent?: boolean } | { ok: false; code: number; reason: string }>;
}

export function buildServer(opts: { policy: RewardPolicyConfig; store?: ApiStore; tokenMirror?: ApiTokenMirror }) {
  const app = Fastify({ logger: false, genReqId: () => crypto.randomUUID() });
  const policy = opts.policy;
  const store = opts.store;

  // superset shape: {status,ts} for new-stack probes + {ok,pid,port,time} for frozen
  // hardwareapi /health consumers (frozen shape proven at P7.1)
  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString(), ok: true, pid: process.pid, port: Number(process.env.PORT ?? 3000), time: new Date().toISOString() }));
  app.get("/ready", async () => {
    // readiness: store reachable if configured
    if (!store) return { ready: true, store: "none" };
    try {
      await store.getDeviceState("__ready_probe__");
      return { ready: true, store: "up" };
    } catch {
      return { ready: false, store: "down" };
    }
  });

  // heartbeat ingestion — signature-verified, replay-protected, persisted
  app.post("/api/v1/heartbeat", async (req, reply) => {
    const body = req.body as any;
    const now = new Date();
    const v = validateHeartbeatEnvelope(
      {
        deviceId: body?.deviceId,
        receivedAt: now,
        reportedAt: body?.reportedAt ? new Date(body.reportedAt) : null,
        nonce: body?.nonce,
        signature: body?.signature,
        integrationSnapshot: body?.integrations ?? null,
      },
      now
    );
    if (!v.ok) return reply.code(400).send({ success: false, reason: v.reason });
    if (!store) return reply.code(503).send({ success: false, reason: "store_unavailable" });
    // replay defense: nonce must be unique
    if (await store.heartbeatNonceExists(body.nonce)) {
      return reply.code(409).send({ success: false, reason: "nonce_replay" });
    }
    // persist (signature verification against device key happens at the device-key layer;
    // envelope shape + skew + nonce already validated here)
    await store.persistHeartbeat({
      deviceId: body.deviceId,
      receivedAt: now,
      reportedAt: body.reportedAt ? new Date(body.reportedAt) : null,
      nonce: body.nonce,
      signature: body.signature,
      integrationSnapshot: body.integrations ?? null,
    });
    return { success: true, receivedAt: now.toISOString() };
  });

  // device online-state (DB-backed)
  app.get("/api/v1/devices/:id/status", async (req, reply) => {
    const { id } = req.params as any;
    if (!store) return reply.code(503).send({ reason: "store_unavailable" });
    const s = await store.getDeviceState(id);
    if (!s) return reply.code(404).send({ reason: "device_not_found" });
    const state = classifyOnlineState({
      lastHeartbeatAt: s.lastHeartbeatAt,
      banned: s.banned,
      disabled: s.disabled,
      now: new Date(),
      onlineThresholdSeconds: policy.onlineThresholdSeconds,
    });
    return { deviceId: id, status: state };
  });

  // reward preview (read-only, deterministic)
  app.post("/api/v1/rewards/preview", async (req) => {
    const body = req.body as any;
    const now = new Date();
    const evidence = (body?.evidence ?? []).map((e: any) => ({
      integration: e.integration,
      healthy: !!e.healthy,
      evidenceAt: e.evidenceAt ? new Date(e.evidenceAt) : now,
      evidenceType: e.evidenceType ?? "telemetry",
    }));
    const healthy = verifiedHealthySetWithStorageSlot(evidence, now, 600, policy.storageAttestationMaxAgeSeconds);
    const result = computeReward(
      {
        deviceId: body?.deviceId ?? "unknown",
        status: (body?.status as DeviceStatus) ?? DeviceStatus.ONLINE,
        banned: !!body?.banned,
        secondsSinceLastHeartbeat: body?.secondsSinceLastHeartbeat ?? null,
        healthyIntegrations: healthy,
      },
      policy
    );
    return {
      eligible: result.eligible,
      amountBase: result.amountBase.toString(),
      storageCapabilityCounted: result.storageCapabilityCounted,
      integrationsCounted: result.integrationsCounted,
      ineligibleReason: result.ineligibleReason,
    };
  });

  // manual claim — server-calculated, idempotent, transactional reservation
  app.post("/api/v1/claims", async (req, reply) => {
    const body = req.body as any;
    if (!store) return reply.code(503).send({ success: false, reason: "store_unavailable" });
    const idempotencyKey = body?.idempotencyKey;
    if (!idempotencyKey) return reply.code(400).send({ success: false, reason: "idempotency_key_required" });
    // idempotency: same key returns the existing claim, never a duplicate
    const existing = await store.claimByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { success: true, claimId: existing.id, status: existing.status, idempotent: true };
    }
    // server computes reservable balance — NEVER trust client amount
    const reservable = await store.getReservableBalanceBase(body?.requestingUserId ?? "");
    const decision = evaluateClaim(
      reservable,
      BigInt(body?.hotWalletBalanceBase ?? "0"),
      body?.destination ?? "",
      body?.destinationOwnerUserId ?? "",
      body?.requestingUserId ?? "",
      BigInt(body?.estimatedFeeBase ?? "1000")
    );
    if (!decision.allowed) return reply.code(400).send({ success: false, reason: decision.reason });
    // transactional reservation (ledger entry + claim row, atomic)
    const claim = await store.createClaimTransactional({
      userId: body.requestingUserId,
      amountBase: decision.amountBase!,
      destination: body.destination,
      idempotencyKey,
    });
    return { success: true, claimId: claim.id, amountBase: decision.amountBase!.toString(), status: ClaimStatus.RESERVED };
  });

  // ---- admin / observability (operator-auth gated) ----
  const requireOperator = (req: any, reply: any) => {
    const tok = req.headers["x-fry3-operator"];
    const expected = process.env.FRY3_OPERATOR_TOKEN;
    if (!expected || tok !== expected) {
      reply.code(401).send({ reason: "operator_auth_required" });
      return false;
    }
    return true;
  };

  app.get("/api/v1/admin/health-detail", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!store) return reply.code(503).send({ reason: "store_unavailable" });
    const probe = await store.getDeviceState("__probe__").catch(() => null);
    return { store: "up", policyVersion: policy.version, onlineThresholdSeconds: policy.onlineThresholdSeconds, ts: new Date().toISOString(), probe };
  });

  app.get("/api/v1/admin/devices/:id/reward-explanation", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!store) return reply.code(503).send({ reason: "store_unavailable" });
    const { id } = req.params as any;
    const s = await store.getDeviceState(id);
    if (!s) return reply.code(404).send({ reason: "device_not_found" });
    const state = classifyOnlineState({ lastHeartbeatAt: s.lastHeartbeatAt, banned: s.banned, disabled: s.disabled, now: new Date(), onlineThresholdSeconds: policy.onlineThresholdSeconds });
    return { deviceId: id, status: state, lastHeartbeatAt: s.lastHeartbeatAt, banned: s.banned, disabled: s.disabled, policyVersion: policy.version };
  });

  app.get("/api/v1/admin/claims/:key", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!store) return reply.code(503).send({ reason: "store_unavailable" });
    const { key } = req.params as any;
    const c = await store.claimByIdempotencyKey(key);
    if (!c) return reply.code(404).send({ reason: "claim_not_found" });
    return c;
  });

  registerLegacyTelemetry(app, store, opts.tokenMirror);
  registerByod(app, store, policy);

  return app;
}

export const DEFAULT_POLICY: RewardPolicyConfig = {
  version: 1,
  weights: {},
  storageCapabilityWeight: 0n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // production: use Prisma store against canonical PG + load active RewardPolicy from DB
  const { PrismaStore } = await import("./store-prisma.js");
  const store = new PrismaStore(process.env.FRY3_DATABASE_URL);
  const dbPolicy = await store.getActivePolicy().catch(() => null);
  const policy = dbPolicy ?? DEFAULT_POLICY;
  // gap-(b) FEM device-token compat-shim: build the Mongo mirror ONLY when explicitly enabled.
  // Dynamic import keeps the `mongodb` driver out of the default (shim-off) runtime path.
  let tokenMirror: ApiTokenMirror | undefined;
  if (process.env.FRY3_FEM_TOKEN_SHIM === "1" || process.env.FRY3_FEM_TOKEN_SHIM === "true") {
    const { makeApiTokenMirror } = await import("./fem-token-mongo-sink.js");
    tokenMirror = await makeApiTokenMirror(process.env);
  }
  const app = buildServer({ policy, store, tokenMirror });
  app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" }).then(() => {
    console.log(`fry3 api listening (policy v${policy.version}, storageWeight=${policy.storageCapabilityWeight})`);
  });
}
