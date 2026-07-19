/**
 * Heartbeat ingestion + online-state classification.
 * Server time is authoritative. Replay defense via nonce uniqueness.
 * Offline devices are NEVER reward-eligible.
 */
import { DeviceStatus } from "@fry3/reward-policy";

export interface HeartbeatRecord {
  deviceId: string;
  receivedAt: Date; // server time
  reportedAt?: Date | null;
  nonce: string;
  signature: string;
  integrationSnapshot?: Record<string, boolean> | null;
}

export interface OnlineStateInput {
  lastHeartbeatAt: Date | null;
  banned: boolean;
  disabled: boolean;
  now?: Date; // server time; injectable for tests
  onlineThresholdSeconds: number;
}

/** Classify device online-state from verified heartbeat recency (server time). */
export function classifyOnlineState(input: OnlineStateInput): DeviceStatus {
  if (input.banned) return DeviceStatus.BANNED;
  if (input.disabled) return DeviceStatus.DISABLED;
  const now = input.now ?? new Date();
  if (!input.lastHeartbeatAt) return DeviceStatus.OFFLINE;
  const ageSeconds = (now.getTime() - input.lastHeartbeatAt.getTime()) / 1000;
  if (ageSeconds <= input.onlineThresholdSeconds) return DeviceStatus.ONLINE;
  if (ageSeconds <= input.onlineThresholdSeconds * 2) return DeviceStatus.DEGRADED;
  return DeviceStatus.OFFLINE;
}

/** Clock-skew guard: reject heartbeats reported too far in the future. */
export function isClockSkewAcceptable(
  reportedAt: Date | null | undefined,
  serverNow: Date,
  maxFutureSkewSeconds = 120
): boolean {
  if (!reportedAt) return true; // no client claim to validate
  const skew = (reportedAt.getTime() - serverNow.getTime()) / 1000;
  return skew <= maxFutureSkewSeconds;
}

/**
 * Validate an incoming heartbeat envelope (shape + freshness).
 * Signature verification is performed by the caller against the device key.
 */
export function validateHeartbeatEnvelope(
  hb: HeartbeatRecord,
  serverNow: Date,
  maxFutureSkewSeconds = 120
): { ok: boolean; reason?: string } {
  if (!hb.deviceId) return { ok: false, reason: "missing_device_id" };
  if (!hb.nonce || hb.nonce.length < 8) return { ok: false, reason: "invalid_nonce" };
  if (!hb.signature) return { ok: false, reason: "missing_signature" };
  if (!isClockSkewAcceptable(hb.reportedAt, serverNow, maxFutureSkewSeconds)) {
    return { ok: false, reason: "clock_skew_exceeded" };
  }
  return { ok: true };
}
