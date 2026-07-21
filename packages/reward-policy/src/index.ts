/**
 * Fry 3.0 Reward Policy — pure, deterministic, integer/base-unit arithmetic.
 * No floats. No Fry 2.0 runtime. Storage capability = storj OR space_acres (counted once).
 */

export enum DeviceStatus {
  ONLINE = "ONLINE",
  DEGRADED = "DEGRADED",
  OFFLINE = "OFFLINE",
  DISABLED = "DISABLED",
  BANNED = "BANNED",
}

export enum IntegrationKind {
  STORJ = "STORJ",
  SPACE_ACRES = "SPACE_ACRES",
  BANDWIDTH = "BANDWIDTH",
  COMPUTE = "COMPUTE",
  SENSOR_WEATHER = "SENSOR_WEATHER",
  SENSOR_AIR = "SENSOR_AIR",
  SENSOR_WATER = "SENSOR_WATER",
  SENSOR_RADIATION = "SENSOR_RADIATION",
  SENSOR_ENERGY = "SENSOR_ENERGY",
  CAMERA = "CAMERA",
  OTHER = "OTHER",
}

export interface RewardPolicyConfig {
  version: number;
  /** per-integration weight in base units per qualifying interval */
  weights: Partial<Record<IntegrationKind, bigint>>;
  /** weight applied once when storage_capability is present (storj OR space_acres) */
  storageCapabilityWeight: bigint;
  /**
   * Freshness window (seconds) for the storage slot's SINGLE daily attestation
   * (1 slot/day, not 144). Optional; default 86400 is applied at the evidence
   * step (integration-health / reward-engine storage-slot wiring).
   */
  storageAttestationMaxAgeSeconds?: number;
  /** device must have a heartbeat within this many seconds to be online-eligible */
  onlineThresholdSeconds: number;
  intervalSeconds: number;
}

export interface DeviceRewardInput {
  deviceId: string;
  status: DeviceStatus;
  banned: boolean;
  /** seconds since last verified heartbeat (server time), or null if never */
  secondsSinceLastHeartbeat: number | null;
  /** verified-healthy integrations this interval (evidence-based, not config-toggle) */
  healthyIntegrations: ReadonlySet<IntegrationKind>;
}

export interface RewardComputation {
  eligible: boolean;
  amountBase: bigint;
  storageCapabilityCounted: boolean;
  integrationsCounted: IntegrationKind[];
  ineligibleReason?: string;
}

/** Storage capability: healthy storj OR healthy space_acres, counted ONCE. */
export function storageCapability(healthy: ReadonlySet<IntegrationKind>): boolean {
  return healthy.has(IntegrationKind.STORJ) || healthy.has(IntegrationKind.SPACE_ACRES);
}

/** Is the device online-eligible based on verified recent heartbeat? */
export function isOnlineEligible(
  secondsSinceLastHeartbeat: number | null,
  thresholdSeconds: number
): boolean {
  if (secondsSinceLastHeartbeat === null) return false;
  return secondsSinceLastHeartbeat <= thresholdSeconds;
}

/**
 * Canonical Fry 3.0 reward computation for one device for one interval.
 * Deterministic. Pure. No I/O.
 */
export function computeReward(
  input: DeviceRewardInput,
  policy: RewardPolicyConfig
): RewardComputation {
  // 1. Banned / disabled => zero
  if (input.banned || input.status === DeviceStatus.BANNED) {
    return zero(input, "device_banned");
  }
  if (input.status === DeviceStatus.DISABLED) {
    return zero(input, "device_disabled");
  }
  // 2. Offline / ghost => zero (no reward for offline devices)
  if (!isOnlineEligible(input.secondsSinceLastHeartbeat, policy.onlineThresholdSeconds)) {
    return zero(input, "offline_or_stale_heartbeat");
  }
  // 3. Compute storage capability (counted once even if both present)
  const hasStorage = storageCapability(input.healthyIntegrations);
  // 4. Sum weights for healthy integrations; storage providers counted via capability, not individually
  let amount = 0n;
  const counted: IntegrationKind[] = [];
  for (const kind of input.healthyIntegrations) {
    if (kind === IntegrationKind.STORJ || kind === IntegrationKind.SPACE_ACRES) {
      continue; // handled via storageCapabilityWeight (once)
    }
    const w = policy.weights[kind];
    if (w !== undefined && w > 0n) {
      amount += w;
      counted.push(kind);
    }
  }
  if (hasStorage && policy.storageCapabilityWeight > 0n) {
    amount += policy.storageCapabilityWeight;
    // record which storage provider(s) were healthy for telemetry, but count once
    if (input.healthyIntegrations.has(IntegrationKind.STORJ)) counted.push(IntegrationKind.STORJ);
    if (input.healthyIntegrations.has(IntegrationKind.SPACE_ACRES)) counted.push(IntegrationKind.SPACE_ACRES);
  }
  if (amount === 0n) {
    return zero(input, "no_qualifying_integration");
  }
  return {
    eligible: true,
    amountBase: amount,
    storageCapabilityCounted: hasStorage,
    integrationsCounted: counted,
  };
}

function zero(input: DeviceRewardInput, reason: string): RewardComputation {
  return {
    eligible: false,
    amountBase: 0n,
    storageCapabilityCounted: false,
    integrationsCounted: [],
    ineligibleReason: reason,
  };
}

/** Idempotency key for an accrual: deterministic per device+interval+policy. */
export function accrualIdempotencyKey(
  deviceId: string,
  intervalStart: Date,
  policyVersion: number
): string {
  return `${deviceId}:${intervalStart.toISOString()}:v${policyVersion}`;
}
