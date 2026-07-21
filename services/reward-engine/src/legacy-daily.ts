/**
 * Legacy daily accrual — exact port of the deployed old-stack daily payer
 * (dbRewards commit 9e13a28e src/reward.ts, sha b81a0b25…), the pipeline that
 * writes main.device-rewards daily_rewards[] entries which the weekly publisher
 * (see legacy-payout.ts) later pays on-chain.
 *
 * Verbatim-semantics port for FORWARD accrual on the new stack. Every quirk is
 * deliberate and load-bearing for parity — do NOT "clean up":
 *  - Rounding is IEEE-754 double `Math.round(x * 100) / 100` at THREE separate
 *    stages (staked base, PoC slot factor, FEM proportion), in that order —
 *    NOT one final rounding.
 *  - `byod` halves the reward when `byod !== undefined && byod.length > 0` —
 *    live data has BOTH array and STRING byod values; a non-empty string also
 *    halves (String.length semantics preserved via the `length` check).
 *  - PoC slot factor = clamp(Σ clamp(slot.multiplier,0,1) over gate-passing
 *    slots / 144, 0, 1); INSTALLER = 6 gates (data,online,mac_match,pol,poi,poa),
 *    NON_INSTALLER = 4 gates (data,online,pol,poi). Fail-closed: no PoC doc or
 *    no day subtree → factor 0.
 *  - PoC entries are dated YESTERDAY-UTC of the run moment; the write path
 *    dedupes on `${asset_id}::${date}` per device.
 *  - Stake tier multipliers come from PoC.versions stake_tiers (per miner_code)
 *    with hardcoded fallbacks 24h→1.5, 6mo→3.0; staked.type "one"→"24h",
 *    "two"→"6mo", any other → base (no multiplier).
 *  - Eligibility (deployed "CONSISTENT WITH BACKPAY" logic): regular devices
 *    need created_at ≤ now; nodes (RDN/SDN/SVN/CN) need registration AND node
 *    staking; AEM needs registration staking; virtual types (VRDN/VSDN/VSVN)
 *    are ineligible here. Verification multiplier active iff staked.time ≤ now.
 */

export interface LegacyStakeInfo {
  type?: string | null; // "one" | "two" | other
  time?: Date | null;
  amount?: number | null;
  asset_id?: string | null;
}

export interface LegacyDailyDevice {
  minerKey: string;
  createdAt?: Date | null;
  staked?: LegacyStakeInfo | null;
  registration?: LegacyStakeInfo | null;
  node?: LegacyStakeInfo | null;
  /** Array OR string in live data; only `.length > 0` matters. */
  byod?: { length: number } | null;
  rewardWallet?: string | null;
  virtual?: boolean;
  activated?: boolean;
  rewardsException?: { enabled?: boolean; expiresAt?: Date | null } | null;
}

export interface LegacyDailyProduct {
  key: string;
  rewardVerified: number; // product.reward.verified — ALWAYS the base (unverified unused)
  tokensReward?: string | null; // product.reward.tokens.reward (asset id, "none" = not rewardable)
  tokensRegister?: string | null;
  tokensNode?: string | null;
}

/** PoC.hardware doc slice for one device+day. */
export interface LegacyPocDoc {
  rewardEligible?: boolean;
  /** FEM proportion multiplier, clamped to [0,1]; default 1. */
  proportion?: number | null;
  /** rewards[dateString] subtree: hour -> slot[] (or legacy {slots: []}). */
  dayRewards?: Record<string, unknown> | null;
}

export type StakeTiers = Record<string, Record<string, number>>;

export const LEGACY_POC_SLOTS_PER_DAY = 144;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundToTwo(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function getDevicePrefix(minerKey: string): string {
  return minerKey.split("-")[0]?.toUpperCase() || "";
}

const NON_INSTALLER_PREFIXES = new Set<string>([
  "IHAQM", "ILAQM", "OMAQM", "IMAQM", "OHAQM",
  "OLWQM", "OHWQM",
  "AOWSCM", "AOWCM", "AIWCM",
  "AOSCM", "AISCM",
  "AOTCM", "AITCM",
  "AIWSCM",
]);

export type LegacyPocCategory = "INSTALLER" | "NON_INSTALLER";

export function getPocRewardCategory(minerKey: string): LegacyPocCategory {
  if (NON_INSTALLER_PREFIXES.has(getDevicePrefix(minerKey))) return "NON_INSTALLER";
  return "INSTALLER";
}

export type LegacyDeviceType = "regular" | "node" | "aem" | "virtual";

export function getDeviceType(minerKey: string): LegacyDeviceType {
  const prefix = minerKey.split("-")[0];
  if (prefix === "AEM") return "aem";
  if (["RDN", "SDN", "SVN", "CN"].includes(prefix)) return "node";
  if (["VRDN", "VSDN", "VSVN"].includes(prefix)) return "virtual";
  return "regular";
}

export interface LegacyEligibility {
  eligible: boolean;
  hasVerificationMultiplier: boolean;
  reason?: string;
}

export function isDeviceCurrentlyEligible(
  device: LegacyDailyDevice,
  currentDate: Date
): LegacyEligibility {
  const deviceType = getDeviceType(device.minerKey);
  switch (deviceType) {
    case "regular": {
      if (!device.createdAt || currentDate < device.createdAt) {
        return { eligible: false, hasVerificationMultiplier: false, reason: "created after current date" };
      }
      const hasVerificationMultiplier = !!(device.staked?.time && currentDate >= device.staked.time);
      return { eligible: true, hasVerificationMultiplier };
    }
    case "node": {
      if (
        !device.registration?.time ||
        currentDate < device.registration.time ||
        !device.registration?.amount ||
        device.registration.amount <= 0
      ) {
        return { eligible: false, hasVerificationMultiplier: false, reason: "registration staking not completed" };
      }
      if (
        !device.node?.time ||
        currentDate < device.node.time ||
        !device.node?.amount ||
        device.node.amount <= 0
      ) {
        return { eligible: false, hasVerificationMultiplier: false, reason: "node staking not completed" };
      }
      const hasVerificationMultiplier = !!(device.staked?.time && currentDate >= device.staked.time);
      return { eligible: true, hasVerificationMultiplier };
    }
    case "aem": {
      if (
        !device.registration?.time ||
        currentDate < device.registration.time ||
        !device.registration?.amount ||
        device.registration.amount <= 0
      ) {
        return { eligible: false, hasVerificationMultiplier: false, reason: "AEM registration staking not completed" };
      }
      const hasVerificationMultiplier = !!(device.staked?.time && currentDate >= device.staked.time);
      return { eligible: true, hasVerificationMultiplier };
    }
    default:
      return { eligible: false, hasVerificationMultiplier: false, reason: `Unknown device type: ${deviceType}` };
  }
}

export function getStakeMult(
  tiers: StakeTiers,
  minerCode: string,
  tierKey: string,
  fallback: number
): number {
  const t = tiers[minerCode];
  if (t && typeof t[tierKey] === "number") return t[tierKey];
  return fallback;
}

/** Staked-multiplier base + BYOD halving — verbatim calculateCurrentRewardAmount. */
export function calculateCurrentRewardAmount(
  device: LegacyDailyDevice,
  product: LegacyDailyProduct,
  eligibility: LegacyEligibility,
  stakeTiers: StakeTiers
): number {
  if (!eligibility.eligible) return 0;
  let rewardAmount = 0;
  if (eligibility.hasVerificationMultiplier) {
    switch (device.staked?.type) {
      case "one":
        rewardAmount =
          Math.round(product.rewardVerified * 100 * getStakeMult(stakeTiers, getDevicePrefix(device.minerKey), "24h", 1.5)) / 100;
        break;
      case "two":
        rewardAmount =
          Math.round(product.rewardVerified * 100 * getStakeMult(stakeTiers, getDevicePrefix(device.minerKey), "6mo", 3.0)) / 100;
        break;
      default:
        rewardAmount = product.rewardVerified;
        break;
    }
  } else {
    rewardAmount = product.rewardVerified;
  }
  if (device.byod !== undefined && device.byod !== null && device.byod.length > 0) {
    rewardAmount = Math.round((rewardAmount / 2) * 100) / 100;
  }
  return rewardAmount;
}

export interface LegacyPocSlotSummary {
  slotsTotal: number;
  slotsValid: number;
  multiplierSum: number;
  rewardFactor: number;
}

/** 144-slot pro-rating — verbatim computePocSlotSummary (fail-closed). */
export function computePocSlotSummary(
  dayRewards: Record<string, unknown> | null | undefined,
  category: LegacyPocCategory
): LegacyPocSlotSummary {
  if (!dayRewards || typeof dayRewards !== "object") {
    return { slotsTotal: LEGACY_POC_SLOTS_PER_DAY, slotsValid: 0, multiplierSum: 0, rewardFactor: 0 };
  }
  let slotsValid = 0;
  let multiplierSum = 0;
  const hourKeys = Object.keys(dayRewards).sort((a, b) => Number(a) - Number(b));
  for (const hourKey of hourKeys) {
    const hourEntry = dayRewards[hourKey] as any;
    // hardwareapi writes rewards[date][hour] as a bare slot ARRAY; legacy shape
    // nested the array under .slots — accept both.
    const slots: any[] = Array.isArray(hourEntry)
      ? hourEntry
      : Array.isArray(hourEntry?.slots)
        ? hourEntry.slots
        : [];
    for (const slot of slots) {
      if (!slot || typeof slot !== "object") continue;
      const gates = slot.gates || {};
      let gateOk: boolean;
      if (category === "INSTALLER") {
        gateOk =
          gates.data === true &&
          gates.online === true &&
          gates.mac_match === true &&
          gates.pol === true &&
          gates.poi === true &&
          gates.poa === true;
      } else {
        gateOk =
          gates.data === true && gates.online === true && gates.pol === true && gates.poi === true;
      }
      if (!gateOk) continue;
      slotsValid += 1;
      const rawMultiplier = typeof slot.multiplier === "number" ? slot.multiplier : 0;
      multiplierSum += clampNumber(rawMultiplier, 0, 1);
    }
  }
  const rewardFactor = clampNumber(multiplierSum / LEGACY_POC_SLOTS_PER_DAY, 0, 1);
  return { slotsTotal: LEGACY_POC_SLOTS_PER_DAY, slotsValid, multiplierSum, rewardFactor };
}

export function getYesterdayUtcDateString(baseDate: Date): string {
  const utc = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().split("T")[0];
}

export interface LegacyDailyResult {
  /** null = device rejected before amount computation (no daily row written). */
  amount: number | null;
  /** daily_rewards.date the write path would use (yesterday-UTC for PoC-gated). */
  effectiveDate: string;
  assetId: string;
  reason?: string;
}

/**
 * Full deterministic per-device daily chain — verbatim doRewards() ordering:
 * virtual-activation gate → INSTALLER reward_eligible short-circuit →
 * product-rewardable → eligibility → wallet → staking-asset mismatch →
 * staked base + BYOD → PoC slot factor (roundToTwo) → FEM proportion
 * (clamped, roundToTwo) → non-finite/negative reject → max(0, amount).
 * Hardware-MAC legacy validation is skipped when PoC slot gating is enabled
 * for the category (deployed default: both categories enabled).
 */
export function computeLegacyDailyReward(
  device: LegacyDailyDevice,
  product: LegacyDailyProduct,
  poc: LegacyPocDoc | null,
  stakeTiers: StakeTiers,
  now: Date,
  opts: { pocGatingEnabled?: boolean } = {}
): LegacyDailyResult {
  const pocGatingEnabled = opts.pocGatingEnabled ?? true;
  const pocDateString = getYesterdayUtcDateString(now);
  const todayString = now.toISOString().split("T")[0];
  const category = getPocRewardCategory(device.minerKey);
  const gated = pocGatingEnabled && !device.virtual;
  const effectiveDate = gated ? pocDateString : todayString;
  const assetId = product.tokensReward || "";

  if (device.virtual && !device.activated) {
    return { amount: null, effectiveDate, assetId, reason: "Virtual not activated" };
  }
  if (gated && category === "INSTALLER" && poc?.rewardEligible === false) {
    return { amount: null, effectiveDate, assetId, reason: "PoC liveness ineligible" };
  }
  if (!product.tokensReward || product.tokensReward === "none") {
    return { amount: null, effectiveDate, assetId, reason: "Product not rewardable" };
  }
  const eligibility = isDeviceCurrentlyEligible(device, now);
  if (!eligibility.eligible) {
    return { amount: null, effectiveDate, assetId, reason: "Device not eligible" };
  }
  if (!device.rewardWallet) {
    return { amount: null, effectiveDate, assetId, reason: "No reward wallet" };
  }
  if (
    device.registration && (device.registration.amount ?? 0) > 0 &&
    device.registration.asset_id !== product.tokensRegister
  ) {
    return { amount: null, effectiveDate, assetId, reason: "Invalid registration staking" };
  }
  if (device.node && (device.node.amount ?? 0) > 0 && device.node.asset_id !== product.tokensNode) {
    return { amount: null, effectiveDate, assetId, reason: "Invalid node staking" };
  }

  let rewardAmount = calculateCurrentRewardAmount(device, product, eligibility, stakeTiers);

  if (gated) {
    const slotSummary = computePocSlotSummary(poc?.dayRewards ?? null, category);
    rewardAmount = roundToTwo(rewardAmount * slotSummary.rewardFactor);
  }

  if (getDevicePrefix(device.minerKey) === "FEM" && poc) {
    const rawProportion = poc.proportion ?? 1.0;
    const proportion = Math.max(0, Math.min(1, typeof rawProportion === "number" ? rawProportion : 1.0));
    rewardAmount = roundToTwo(rewardAmount * proportion);
  }

  if (!Number.isFinite(rewardAmount) || rewardAmount < 0) {
    return { amount: null, effectiveDate, assetId, reason: "Invalid reward amount" };
  }
  return { amount: Math.max(0, rewardAmount), effectiveDate, assetId };
}
