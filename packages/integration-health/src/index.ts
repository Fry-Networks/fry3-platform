/**
 * Integration health — evidence-based, NOT config-toggle.
 * An integration counts only if there is verified evidence it is active/healthy.
 * Storj and Space Acres are tracked separately (telemetry) but count once (reward-policy).
 */
import { IntegrationKind } from "@fry3/reward-policy";

export type EvidenceType = "telemetry" | "heartbeat-claim" | "probe";

export interface HealthEvidence {
  integration: IntegrationKind;
  healthy: boolean;
  evidenceAt: Date; // server time of observation
  evidenceType: EvidenceType;
}

/**
 * Decide effective health for an integration from available evidence.
 * A config toggle alone (no telemetry/probe) is NOT sufficient.
 * Evidence must be fresh (within maxAgeSeconds).
 */
export function effectiveHealth(
  evidence: HealthEvidence | null,
  now: Date,
  maxAgeSeconds = 600
): { healthy: boolean; reason: string } {
  if (!evidence) return { healthy: false, reason: "no_evidence" };
  const ageSeconds = (now.getTime() - evidence.evidenceAt.getTime()) / 1000;
  if (ageSeconds > maxAgeSeconds) return { healthy: false, reason: "stale_evidence" };
  if (!evidence.healthy) return { healthy: false, reason: "reported_unhealthy" };
  return { healthy: true, reason: "healthy_" + evidence.evidenceType };
}

/**
 * Build the verified-healthy integration set for a device for reward computation.
 * Only integrations with fresh positive evidence are included.
 */
export function verifiedHealthySet(
  evidenceList: HealthEvidence[],
  now: Date,
  maxAgeSeconds = 600
): Set<IntegrationKind> {
  const set = new Set<IntegrationKind>();
  // keep the most recent evidence per integration
  const latest = new Map<IntegrationKind, HealthEvidence>();
  for (const e of evidenceList) {
    const cur = latest.get(e.integration);
    if (!cur || e.evidenceAt > cur.evidenceAt) latest.set(e.integration, e);
  }
  for (const [kind, e] of latest) {
    if (effectiveHealth(e, now, maxAgeSeconds).healthy) set.add(kind);
  }
  return set;
}
