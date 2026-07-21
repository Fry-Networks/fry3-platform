/**
 * Storage-slot wiring — Fry 3.0 forward accrual path.
 * storj ⇄ space_acres = ONE storage slot: either satisfies it; absence of the
 * other is never a penalty; the slot is satisfied by a SINGLE daily
 * attestation (24h evidence window — 1 slot/day, not 144); binary 100%/0% —
 * failure = slot ineligibility, never a fractional reduction. Offline/ghost
 * devices always pay zero (engine ghost gate composes in front).
 */
import { IntegrationKind, RewardPolicyConfig } from "@fry3/reward-policy";
import {
  HealthEvidence,
  STORAGE_ATTESTATION_MAX_AGE_SECONDS,
  verifiedHealthySetWithStorageSlot,
} from "@fry3/integration-health";
import { accrueDevice, AccrualRecord, DeviceState } from "./engine";

/** Build the interval healthy set with storage daily-attestation semantics. */
export function buildHealthySetForAccrual(
  evidenceList: HealthEvidence[],
  now: Date,
  policy: RewardPolicyConfig,
  defaultMaxAgeSeconds = 600
): Set<IntegrationKind> {
  return verifiedHealthySetWithStorageSlot(
    evidenceList,
    now,
    defaultMaxAgeSeconds,
    policy.storageAttestationMaxAgeSeconds ?? STORAGE_ATTESTATION_MAX_AGE_SECONDS
  );
}

/** Forward-path accrual straight from raw evidence (canonical storage-slot wiring). */
export function accrueDeviceFromEvidence(
  base: Omit<DeviceState, "healthyIntegrations">,
  evidenceList: HealthEvidence[],
  intervalStart: Date,
  policy: RewardPolicyConfig,
  now: Date,
  defaultMaxAgeSeconds = 600
): AccrualRecord {
  const healthyIntegrations = buildHealthySetForAccrual(evidenceList, now, policy, defaultMaxAgeSeconds);
  return accrueDevice({ ...base, healthyIntegrations }, intervalStart, policy, now);
}
