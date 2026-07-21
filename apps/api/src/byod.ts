/**
 * BYOD licensing surface (byod.frynetworks.com — the one rebuildable frontend).
 * License key is the bearer credential: routes never return owner identity, and
 * activation is refused unless the target device belongs to the license owner
 * (cross-account access is prevented by construction).
 */
import type { FastifyInstance } from "fastify";
import type { ApiStore } from "./server.js";
import { classifyOnlineState } from "@fry3/heartbeat-ingest";
import type { RewardPolicyConfig } from "@fry3/reward-policy";

const MIN_KEY_LENGTH = 8;

export function registerByod(app: FastifyInstance, store: ApiStore | undefined, policy: RewardPolicyConfig) {
  // POST /api/v1/byod/lookup {licenseKey} -> license status + bound-device state.
  // Key travels in the body, never the URL (keeps it out of access logs).
  app.post("/api/v1/byod/lookup", async (req, reply) => {
    if (!store?.byodLicenseLookup) return reply.code(503).send({ reason: "store_unavailable" });
    const body = (req.body ?? {}) as any;
    const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
    if (licenseKey.length < MIN_KEY_LENGTH) return reply.code(400).send({ reason: "license_key_required" });
    const lic = await store.byodLicenseLookup(licenseKey);
    if (!lic) return reply.code(404).send({ reason: "license_not_found" });
    const now = new Date();
    return {
      found: true,
      license: {
        status: lic.status,
        activatedAt: lic.activatedAt,
        expiresAt: lic.expiresAt,
        createdAt: lic.createdAt,
        device: lic.device
          ? {
              id: lic.device.id,
              label: lic.device.label,
              lastHeartbeatAt: lic.device.lastHeartbeatAt,
              status: classifyOnlineState({
                lastHeartbeatAt: lic.device.lastHeartbeatAt,
                banned: lic.device.banned,
                disabled: lic.device.disabled,
                now,
                onlineThresholdSeconds: policy.onlineThresholdSeconds,
              }),
            }
          : null,
      },
    };
  });

  // POST /api/v1/byod/activate {licenseKey, device} -> bind license to an owned device.
  // device = Device.id | canonicalId | minerKey. Idempotent on the same device.
  app.post("/api/v1/byod/activate", async (req, reply) => {
    if (!store?.byodActivate) return reply.code(503).send({ reason: "store_unavailable" });
    const body = (req.body ?? {}) as any;
    const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
    const deviceRef = typeof body.device === "string" ? body.device.trim() : "";
    if (licenseKey.length < MIN_KEY_LENGTH) return reply.code(400).send({ success: false, reason: "license_key_required" });
    if (!deviceRef) return reply.code(400).send({ success: false, reason: "device_required" });
    const r = await store.byodActivate({ licenseKey, deviceRef, now: new Date() });
    if (!r.ok) return reply.code(r.code).send({ success: false, reason: r.reason });
    return { success: true, deviceId: r.deviceId, activatedAt: r.activatedAt, idempotent: r.idempotent ?? false };
  });
}
