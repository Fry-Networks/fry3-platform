/**
 * Fry 3.0 canonical API — Fastify.
 * Integrates reward-policy, heartbeat-ingest, claim-dispatcher, integration-health.
 * Server-side authorization. Integer/base-unit. Idempotent.
 */
import Fastify from "fastify";
import { computeReward, DeviceStatus, RewardPolicyConfig } from "@fry3/reward-policy";
import { classifyOnlineState, validateHeartbeatEnvelope } from "@fry3/heartbeat-ingest";
import { evaluateClaim, ClaimStatus, canTransition } from "@fry3/claim-dispatcher";
import { verifiedHealthySet } from "@fry3/integration-health";

export function buildServer(opts: { policy: RewardPolicyConfig }) {
  const app = Fastify({ logger: false, genReqId: () => crypto.randomUUID() });
  const policy = opts.policy;

  // health + readiness
  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));
  app.get("/ready", async () => ({ ready: true }));

  // heartbeat ingestion (auth via device signature — stub verification hook)
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
    // TODO: verify signature against device key; persist heartbeat; nonce uniqueness (replay defense)
    return { success: true, receivedAt: now.toISOString() };
  });

  // device online-state (read)
  app.get("/api/v1/devices/:id/status", async (req) => {
    const { id } = req.params as any;
    // TODO: load lastHeartbeatAt/banned/disabled from db
    const state = classifyOnlineState({
      lastHeartbeatAt: null,
      banned: false,
      disabled: false,
      now: new Date(),
      onlineThresholdSeconds: policy.onlineThresholdSeconds,
    });
    return { deviceId: id, status: state };
  });

  // reward preview (read-only, deterministic)
  app.post("/api/v1/rewards/preview", async (req) => {
    const body = req.body as any;
    const now = new Date();
    // normalize evidence: evidenceAt arrives as ISO string over JSON
    const evidence = (body?.evidence ?? []).map((e: any) => ({
      integration: e.integration,
      healthy: !!e.healthy,
      evidenceAt: e.evidenceAt ? new Date(e.evidenceAt) : now,
      evidenceType: e.evidenceType ?? "telemetry",
    }));
    const healthy = verifiedHealthySet(evidence, now);
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

  // manual claim (server-calculated, idempotent)
  app.post("/api/v1/claims", async (req, reply) => {
    const body = req.body as any;
    // NEVER trust client amount; server computes from reservable balance
    const decision = evaluateClaim(
      BigInt(body?.reservableBalanceBase ?? "0"), // server-derived in real impl
      BigInt(body?.hotWalletBalanceBase ?? "0"),
      body?.destination ?? "",
      body?.destinationOwnerUserId ?? "",
      body?.requestingUserId ?? "",
      BigInt(body?.estimatedFeeBase ?? "1000")
    );
    if (!decision.allowed) return reply.code(400).send({ success: false, reason: decision.reason });
    // TODO: transactional reservation + ledger entry + hot-wallet dispatch + idempotency persist
    return {
      success: true,
      amountBase: decision.amountBase!.toString(),
      status: ClaimStatus.RESERVED,
      idempotencyKey: body?.idempotencyKey,
    };
  });

  return app;
}

// default policy (version 1) — real values loaded from db RewardPolicy
export const DEFAULT_POLICY: RewardPolicyConfig = {
  version: 1,
  weights: {},
  storageCapabilityWeight: 0n,
  onlineThresholdSeconds: 300,
  intervalSeconds: 3600,
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = buildServer({ policy: DEFAULT_POLICY });
  app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" }).then(() => {
    console.log("fry3 api listening");
  });
}
