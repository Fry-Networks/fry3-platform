import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  roundToTwo,
  clampNumber,
  getDevicePrefix,
  getDeviceType,
  getPocRewardCategory,
  isDeviceCurrentlyEligible,
  calculateCurrentRewardAmount,
  computePocSlotSummary,
  computeLegacyDailyReward,
  getYesterdayUtcDateString,
  LegacyDailyDevice,
  LegacyDailyProduct,
  StakeTiers,
} from "../src/legacy-daily";

const NOW = new Date("2026-07-17T15:00:00.000Z");
const TIERS: StakeTiers = { FEM: { unregistered: 0, none: 1, "24h": 1.5, "6mo": 3 } };
const FEM_PRODUCT: LegacyDailyProduct = {
  key: "FEM",
  rewardVerified: 22.89,
  tokensReward: "2485202024",
  tokensRegister: "none",
  tokensNode: null,
};

function dev(over: Partial<LegacyDailyDevice> = {}): LegacyDailyDevice {
  return {
    minerKey: "FEM-TESTKEY000000000000000000000000",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    rewardWallet: "W",
    ...over,
  };
}

/** All-gates-green INSTALLER slot with a given multiplier. */
function slot(multiplier: number, gateOverrides: Record<string, boolean> = {}) {
  return {
    multiplier,
    gates: { data: true, online: true, mac_match: true, pol: true, poi: true, poa: true, ...gateOverrides },
  };
}

describe("classification", () => {
  it("device type + PoC category", () => {
    expect(getDeviceType("FEM-X")).toBe("regular");
    expect(getDeviceType("RDN-X")).toBe("node");
    expect(getDeviceType("AEM-X")).toBe("aem");
    expect(getDeviceType("VRDN-X")).toBe("virtual");
    expect(getPocRewardCategory("FEM-X")).toBe("INSTALLER");
    expect(getPocRewardCategory("IHAQM-X")).toBe("NON_INSTALLER");
    expect(getDevicePrefix("fem-x")).toBe("FEM");
  });
  it("yesterday-UTC dating", () => {
    expect(getYesterdayUtcDateString(new Date("2026-07-17T00:30:00.000Z"))).toBe("2026-07-16");
    expect(getYesterdayUtcDateString(new Date("2026-07-17T23:30:00.000Z"))).toBe("2026-07-16");
  });
});

describe("eligibility (backpay-consistent)", () => {
  it("regular: created_at gate + staked.time multiplier", () => {
    expect(isDeviceCurrentlyEligible(dev(), NOW).eligible).toBe(true);
    expect(isDeviceCurrentlyEligible(dev({ createdAt: new Date("2027-01-01") }), NOW).eligible).toBe(false);
    expect(isDeviceCurrentlyEligible(dev({ createdAt: null }), NOW).eligible).toBe(false);
    const staked = dev({ staked: { type: "one", time: new Date("2026-07-01") } });
    expect(isDeviceCurrentlyEligible(staked, NOW).hasVerificationMultiplier).toBe(true);
    const future = dev({ staked: { type: "one", time: new Date("2026-08-01") } });
    expect(isDeviceCurrentlyEligible(future, NOW).hasVerificationMultiplier).toBe(false);
  });
  it("node: requires registration AND node staking; virtual type ineligible", () => {
    const nod = dev({
      minerKey: "RDN-X",
      registration: { time: new Date("2026-01-01"), amount: 1 },
      node: { time: new Date("2026-01-01"), amount: 1 },
    });
    expect(isDeviceCurrentlyEligible(nod, NOW).eligible).toBe(true);
    expect(isDeviceCurrentlyEligible(dev({ minerKey: "RDN-X" }), NOW).eligible).toBe(false);
    expect(isDeviceCurrentlyEligible(dev({ minerKey: "VRDN-X" }), NOW).eligible).toBe(false);
  });
});

describe("base amount — staged Math.round semantics", () => {
  const elig = { eligible: true, hasVerificationMultiplier: true };
  it("staked one/two use tier multipliers (round at *100 scale)", () => {
    expect(
      calculateCurrentRewardAmount(dev({ staked: { type: "one" } }), FEM_PRODUCT, elig, TIERS)
    ).toBe(Math.round(22.89 * 100 * 1.5) / 100);
    expect(
      calculateCurrentRewardAmount(dev({ staked: { type: "two" } }), FEM_PRODUCT, elig, TIERS)
    ).toBe(Math.round(22.89 * 100 * 3) / 100);
  });
  it("invalid staking type or no multiplier -> base verified", () => {
    expect(calculateCurrentRewardAmount(dev({ staked: { type: "weird" } }), FEM_PRODUCT, elig, TIERS)).toBe(22.89);
    expect(
      calculateCurrentRewardAmount(dev(), FEM_PRODUCT, { eligible: true, hasVerificationMultiplier: false }, TIERS)
    ).toBe(22.89);
  });
  it("ineligible -> 0", () => {
    expect(
      calculateCurrentRewardAmount(dev(), FEM_PRODUCT, { eligible: false, hasVerificationMultiplier: false }, TIERS)
    ).toBe(0);
  });
  it("byod halving applies to arrays AND non-empty strings (live data has string byod)", () => {
    const eligBase = { eligible: true, hasVerificationMultiplier: false };
    expect(calculateCurrentRewardAmount(dev({ byod: [1] as any }), FEM_PRODUCT, eligBase, TIERS)).toBe(
      Math.round((22.89 / 2) * 100) / 100
    );
    expect(calculateCurrentRewardAmount(dev({ byod: "some-byod-ref" as any }), FEM_PRODUCT, eligBase, TIERS)).toBe(11.45);
    expect(calculateCurrentRewardAmount(dev({ byod: "" as any }), FEM_PRODUCT, eligBase, TIERS)).toBe(22.89);
    expect(calculateCurrentRewardAmount(dev(), FEM_PRODUCT, eligBase, TIERS)).toBe(22.89);
  });
  it("tier fallbacks 1.5/3.0 when PoC.versions has no entry", () => {
    expect(calculateCurrentRewardAmount(dev({ staked: { type: "one" } }), FEM_PRODUCT, elig, {})).toBe(34.34);
    expect(calculateCurrentRewardAmount(dev({ staked: { type: "two" } }), FEM_PRODUCT, elig, {})).toBe(68.67);
  });
});

describe("PoC 144-slot factor", () => {
  it("fail-closed: no day subtree -> factor 0", () => {
    expect(computePocSlotSummary(null, "INSTALLER").rewardFactor).toBe(0);
    expect(computePocSlotSummary(undefined, "INSTALLER").rewardFactor).toBe(0);
  });
  it("INSTALLER needs all 6 gates; NON_INSTALLER needs 4", () => {
    const day = { "0": [slot(1), slot(1, { poa: false })] };
    const inst = computePocSlotSummary(day, "INSTALLER");
    expect(inst.slotsValid).toBe(1);
    const noni = computePocSlotSummary(day, "NON_INSTALLER");
    expect(noni.slotsValid).toBe(2); // poa not required
  });
  it("multiplier clamped to [0,1], factor = sum/144 clamped", () => {
    const day = { "0": [slot(2.5), slot(0.5), slot(-1)] };
    const s = computePocSlotSummary(day, "INSTALLER");
    expect(s.multiplierSum).toBe(1.5); // 1 + 0.5 + 0
    expect(s.rewardFactor).toBe(1.5 / 144);
  });
  it("accepts legacy {slots:[...]} hour shape", () => {
    const s = computePocSlotSummary({ "0": { slots: [slot(1)] } } as any, "INSTALLER");
    expect(s.slotsValid).toBe(1);
  });
});

describe("full chain ordering (roundToTwo at slot stage AND proportion stage)", () => {
  it("full-day perfect slots + proportion", () => {
    const day: Record<string, unknown> = {};
    for (let h = 0; h < 24; h++) day[String(h)] = [slot(1), slot(1), slot(1), slot(1), slot(1), slot(1)];
    const r = computeLegacyDailyReward(
      dev(),
      FEM_PRODUCT,
      { proportion: 0.6503, dayRewards: day },
      TIERS,
      NOW
    );
    // base 22.89 -> factor 1 -> r2(22.89) -> proportion r2(22.89*0.6503)
    expect(r.amount).toBe(roundToTwo(22.89 * 0.6503));
    expect(r.effectiveDate).toBe("2026-07-16");
    expect(r.assetId).toBe("2485202024");
  });
  it("proportion clamped to [0,1]; missing poc doc skips proportion (amount already 0)", () => {
    const r = computeLegacyDailyReward(dev(), FEM_PRODUCT, { proportion: 7, dayRewards: null }, TIERS, NOW);
    expect(r.amount).toBe(0);
    const r2c = computeLegacyDailyReward(dev(), FEM_PRODUCT, null, TIERS, NOW);
    expect(r2c.amount).toBe(0);
  });
  it("reward_eligible=false short-circuits INSTALLER", () => {
    const r = computeLegacyDailyReward(dev(), FEM_PRODUCT, { rewardEligible: false }, TIERS, NOW);
    expect(r.amount).toBeNull();
    expect(r.reason).toBe("PoC liveness ineligible");
  });
  it("no wallet / not rewardable / staking mismatch reject", () => {
    expect(computeLegacyDailyReward(dev({ rewardWallet: null }), FEM_PRODUCT, null, TIERS, NOW).amount).toBeNull();
    expect(
      computeLegacyDailyReward(dev(), { ...FEM_PRODUCT, tokensReward: "none" }, null, TIERS, NOW).amount
    ).toBeNull();
    const regMismatch = dev({ registration: { amount: 5, asset_id: "1234" } });
    expect(computeLegacyDailyReward(regMismatch, FEM_PRODUCT, null, TIERS, NOW).reason).toBe(
      "Invalid registration staking"
    );
  });
  it("clampNumber basics", () => {
    expect(clampNumber(5, 0, 1)).toBe(1);
    expect(clampNumber(-5, 0, 1)).toBe(0);
  });
});

// ---------- live parity fixture ----------
// 65 real devices from the 2026-07-16 accrual day (inputs read from live Mongo,
// expected = the amount the deployed dbRewards pipeline actually recorded).
// Full-population verification (P5.7): 11548/11554 recorded entries recomputed
// Object.is-exact; remaining 6 = post-run state drift on zero-amount rows.
describe("parity vs recorded live accrual (2026-07-16)", () => {
  const fx = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/legacy-daily-fixture.json", import.meta.url)), "utf8")
  );
  const product: LegacyDailyProduct = {
    key: "FEM",
    rewardVerified: fx.product.verified,
    tokensReward: fx.product.tokensReward,
    tokensRegister: fx.product.tokensRegister,
    tokensNode: fx.product.tokensNode,
  };
  it(`all ${fx.devices.length} fixture devices reproduce recorded amounts exactly`, () => {
    for (const d of fx.devices) {
      const device: LegacyDailyDevice = {
        minerKey: d.minerKey,
        createdAt: d.device.createdAtMs !== null ? new Date(d.device.createdAtMs) : null,
        staked: d.device.staked
          ? {
              type: d.device.staked.type,
              time: d.device.staked.timeMs !== null ? new Date(d.device.staked.timeMs) : null,
              amount: d.device.staked.amount,
              asset_id: d.device.staked.asset_id,
            }
          : null,
        registration: d.device.registration
          ? {
              time: d.device.registration.timeMs !== null ? new Date(d.device.registration.timeMs) : null,
              amount: d.device.registration.amount,
              asset_id: d.device.registration.asset_id,
            }
          : null,
        node: d.device.node
          ? {
              time: d.device.node.timeMs !== null ? new Date(d.device.node.timeMs) : null,
              amount: d.device.node.amount,
              asset_id: d.device.node.asset_id,
            }
          : null,
        byod:
          d.device.byodLen !== null && d.device.byodLen > 0
            ? { length: d.device.byodLen }
            : d.device.byodLen === 0
              ? { length: 0 }
              : undefined,
        rewardWallet: d.device.rewardWallet,
        virtual: d.device.virtual,
        activated: d.device.activated,
      };
      const poc = d.poc
        ? {
            rewardEligible: d.poc.rewardEligible === null ? undefined : d.poc.rewardEligible,
            proportion: d.poc.proportion,
            dayRewards: d.poc.day,
          }
        : null;
      const now = d.createdAtMs !== null ? new Date(d.createdAtMs) : new Date(`${fx.verifyDate}T12:00:00Z`);
      const r = computeLegacyDailyReward(device, product, poc, fx.tiers, now);
      expect(r.amount, `${d.minerKey} expected ${d.recordedAmount}`).not.toBeNull();
      expect(Object.is(r.amount, d.recordedAmount), `${d.minerKey} got ${r.amount} want ${d.recordedAmount}`).toBe(
        true
      );
    }
  });
});
