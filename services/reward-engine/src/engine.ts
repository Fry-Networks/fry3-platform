/**
 * Reward engine — orchestrates idempotent accrual + maintenance-window backfill.
 * Uses reward-policy (pure), integration-health (evidence), heartbeat state.
 * Idempotent per device+interval+policy. Transactional. Offline=0. Storage counted once.
 */
import {
  computeReward,
  accrualIdempotencyKey,
  DeviceStatus,
  IntegrationKind,
  RewardPolicyConfig,
  RewardComputation,
} from "@fry3/reward-policy";

export interface DeviceState {
  deviceId: string;
  banned: boolean;
  disabled: boolean;
  lastHeartbeatAt: Date | null;
  healthyIntegrations: Set<IntegrationKind>;
}

export interface AccrualRecord {
  idempotencyKey: string;
  deviceId: string;
  intervalStart: Date;
  intervalEnd: Date;
  policyVersion: number;
  eligible: boolean;
  amountBase: bigint;
  storageCapabilityCounted: boolean;
  integrationsCounted: IntegrationKind[];
  ineligibleReason?: string;
}

/** Compute the accrual for one device for one interval (pure orchestration). */
export function accrueDevice(
  state: DeviceState,
  intervalStart: Date,
  policy: RewardPolicyConfig,
  now: Date
): AccrualRecord {
  const secondsSinceLastHeartbeat = state.lastHeartbeatAt
    ? (now.getTime() - state.lastHeartbeatAt.getTime()) / 1000
    : null;
  const status: DeviceStatus = state.banned
    ? DeviceStatus.BANNED
    : state.disabled
    ? DeviceStatus.DISABLED
    : secondsSinceLastHeartbeat !== null && secondsSinceLastHeartbeat <= policy.onlineThresholdSeconds
    ? DeviceStatus.ONLINE
    : DeviceStatus.OFFLINE;
  const result: RewardComputation = computeReward(
    {
      deviceId: state.deviceId,
      status,
      banned: state.banned,
      secondsSinceLastHeartbeat,
      healthyIntegrations: state.healthyIntegrations,
    },
    policy
  );
  return {
    idempotencyKey: accrualIdempotencyKey(state.deviceId, intervalStart, policy.version),
    deviceId: state.deviceId,
    intervalStart,
    intervalEnd: new Date(intervalStart.getTime() + policy.intervalSeconds * 1000),
    policyVersion: policy.version,
    eligible: result.eligible,
    amountBase: result.amountBase,
    storageCapabilityCounted: result.storageCapabilityCounted,
    integrationsCounted: result.integrationsCounted,
    ineligibleReason: result.ineligibleReason,
  };
}

/**
 * Maintenance-window backfill: compute accruals for a device across a window
 * using recorded heartbeat/integration evidence per interval. Deterministic.
 * Each interval's eligibility uses the evidence state AT THAT INTERVAL (not current).
 */
export interface IntervalEvidence {
  intervalStart: Date;
  secondsSinceLastHeartbeat: number | null;
  healthyIntegrations: Set<IntegrationKind>;
  banned: boolean;
  disabled: boolean;
}

export function backfillDevice(
  deviceId: string,
  intervals: IntervalEvidence[],
  policy: RewardPolicyConfig
): AccrualRecord[] {
  return intervals.map((iv) => {
    const result = computeReward(
      {
        deviceId,
        status: iv.banned
          ? DeviceStatus.BANNED
          : iv.disabled
          ? DeviceStatus.DISABLED
          : iv.secondsSinceLastHeartbeat !== null && iv.secondsSinceLastHeartbeat <= policy.onlineThresholdSeconds
          ? DeviceStatus.ONLINE
          : DeviceStatus.OFFLINE,
        banned: iv.banned,
        secondsSinceLastHeartbeat: iv.secondsSinceLastHeartbeat,
        healthyIntegrations: iv.healthyIntegrations,
      },
      policy
    );
    return {
      idempotencyKey: accrualIdempotencyKey(deviceId, iv.intervalStart, policy.version),
      deviceId,
      intervalStart: iv.intervalStart,
      intervalEnd: new Date(iv.intervalStart.getTime() + policy.intervalSeconds * 1000),
      policyVersion: policy.version,
      eligible: result.eligible,
      amountBase: result.amountBase,
      storageCapabilityCounted: result.storageCapabilityCounted,
      integrationsCounted: result.integrationsCounted,
      ineligibleReason: result.ineligibleReason,
    };
  });
}

/** Dedupe check: a set of idempotency keys already persisted (idempotent re-run). */
export function filterAlreadyPersisted(
  records: AccrualRecord[],
  persistedKeys: ReadonlySet<string>
): AccrualRecord[] {
  return records.filter((r) => !persistedKeys.has(r.idempotencyKey));
}
