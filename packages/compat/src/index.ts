/**
 * @fry3/compat — backward-compatible API contracts for SOURCE-FROZEN frontends
 * (fry.farm, fry.market, FEM). Translate legacy <-> canonical Fry 3.0 shapes.
 * Integer base-units as string. No floats. Pure functions.
 */

// ---- amount helpers (integer base-units as string; reject float) ----
export function toBaseUnitsString(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("float_amount_not_allowed");
    return BigInt(v).toString();
  }
  if (typeof v === "string") {
    if (!/^[0-9]+$/.test(v)) throw new Error("invalid_base_units_string");
    return v;
  }
  throw new Error("invalid_amount_type");
}

export function fromBaseUnitsString(v: string): bigint {
  if (!/^[0-9]+$/.test(v)) throw new Error("invalid_base_units_string");
  return BigInt(v);
}

// ---- legacy contract shapes ----
export interface LegacyDevice {
  device_id: string;
  owner: string;
  online: boolean;
  last_seen?: string;
}

export interface LegacyRewardBalance {
  pending: string; // base-units string
  currency: string;
}

export interface LegacyClaimResponse {
  ok: boolean;
  tx_id?: string;
  status: string;
}

// ---- canonical shapes ----
export interface CanonicalDevice {
  deviceId: string;
  ownerUserId: string;
  status: "ONLINE" | "DEGRADED" | "OFFLINE" | "DISABLED" | "BANNED";
  lastSeenAt?: string;
}

// ---- adapters ----
export function legacyDeviceToCanonical(d: LegacyDevice): CanonicalDevice {
  return {
    deviceId: d.device_id,
    ownerUserId: d.owner,
    status: d.online ? "ONLINE" : "OFFLINE",
    lastSeenAt: d.last_seen,
  };
}

export function canonicalDeviceToLegacy(d: CanonicalDevice): LegacyDevice {
  return {
    device_id: d.deviceId,
    owner: d.ownerUserId,
    online: d.status === "ONLINE",
    last_seen: d.lastSeenAt,
  };
}

export function canonicalRewardBalanceToLegacy(amountBase: string, currency = "FRY"): LegacyRewardBalance {
  return { pending: toBaseUnitsString(amountBase), currency };
}

// ---- runtime validators (contract tests) ----
export interface ValidationResult { ok: boolean; errors: string[] }

export function validateLegacyDevice(obj: unknown): ValidationResult {
  const errors: string[] = [];
  const o = obj as Partial<LegacyDevice>;
  if (!o || typeof o !== "object") return { ok: false, errors: ["not_an_object"] };
  if (typeof o.device_id !== "string" || !o.device_id) errors.push("device_id_required");
  if (typeof o.owner !== "string" || !o.owner) errors.push("owner_required");
  if (typeof o.online !== "boolean") errors.push("online_must_be_boolean");
  return { ok: errors.length === 0, errors };
}

export function validateLegacyRewardBalance(obj: unknown): ValidationResult {
  const errors: string[] = [];
  const o = obj as Partial<LegacyRewardBalance>;
  if (!o || typeof o !== "object") return { ok: false, errors: ["not_an_object"] };
  if (typeof o.pending !== "string" || !/^[0-9]+$/.test(o.pending)) errors.push("pending_must_be_integer_string");
  if (typeof o.currency !== "string" || !o.currency) errors.push("currency_required");
  return { ok: errors.length === 0, errors };
}
