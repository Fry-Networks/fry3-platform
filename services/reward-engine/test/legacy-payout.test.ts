import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ddNew,
  ddAdd,
  ddValue,
  isValidAlgorandAddress,
  computeWindowPayouts,
  LegacyWeeklyRow,
  LEGACY_ASSET_TFRY,
  LEGACY_ASSET_FNODE,
} from "../src/legacy-payout";

// ---------- mongod $sum probe vectors ----------
// Expected values are VERBATIM live-mongod 8.0.18 outputs, captured read-only via
// {$documents}/{$group,$sum} aggregations on ARES00 (P5.6 probe, re-verified P5.6c).
// AMYZ / IUCH / D5RY differ from naive left-to-right summation — they pin the
// DoubleDoubleSummation algorithm, not just "a sum".
const MONGOD_PROBES: Array<[string, number[], number]> = [
  ["seq3", [208.32, 624.96, 1249.92], 2083.2],
  ["rev3", [1249.92, 624.96, 208.32], 2083.2000000000003],
  ["AMYZ", [1022.68, 2045.36, 4090.72, 2045.36, 2045.36, 1571.28], 12820.759999999998],
  ["IUCH", [120.19, 624.96, 120.19, 160.23], 1025.57],
  ["D5RY", [2499.84, 833.28, 20790, 20790, 20790, 2499.84], 68202.96],
  ["zeroMix", [583.2959999999999, 0, 0, 22522.5, 0, 2079, 0, 0], 25184.796],
];

describe("DoubleDoubleSummation (verbatim mongod $sum)", () => {
  for (const [name, values, expected] of MONGOD_PROBES) {
    it(`matches live mongod bit-exact: ${name}`, () => {
      const acc = ddNew();
      for (const v of values) ddAdd(acc, v);
      expect(Object.is(ddValue(acc), expected)).toBe(true);
    });
  }
  it("diverges from naive summation where mongod does (algorithm is load-bearing)", () => {
    for (const name of ["AMYZ", "IUCH", "D5RY"]) {
      const [, values, expected] = MONGOD_PROBES.find((p) => p[0] === name)!;
      const naive = values.reduce((s, v) => s + v, 0);
      expect(Object.is(naive, expected)).toBe(false);
    }
  });
});

// ---------- wallet gate ----------
// Real mainnet address drawn from the public on-chain payout fixture below.
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/legacy-parity-fixture.json", import.meta.url)), "utf8")
);
const someValidAddr: string = Object.keys(FIXTURE.windows["2026-07-17"].expected.wallets)[0];

describe("isValidAlgorandAddress (algosdk decode_address semantics)", () => {
  it("accepts a real payout address", () => {
    expect(isValidAlgorandAddress(someValidAddr)).toBe(true);
  });
  it("rejects corrupted checksum", () => {
    const flip = someValidAddr[0] === "A" ? "B" : "A";
    expect(isValidAlgorandAddress(flip + someValidAddr.slice(1))).toBe(false);
  });
  it("rejects wrong length / non-base32 / non-string", () => {
    expect(isValidAlgorandAddress(someValidAddr.slice(0, 57))).toBe(false);
    expect(isValidAlgorandAddress(someValidAddr.slice(0, 57) + "1")).toBe(false);
    expect(isValidAlgorandAddress(null)).toBe(false);
    expect(isValidAlgorandAddress(42)).toBe(false);
    expect(isValidAlgorandAddress("")).toBe(false);
  });
});

// ---------- window semantics ----------
describe("computeWindowPayouts semantics", () => {
  const base: LegacyWeeklyRow = {
    seq: 1,
    unlockAtMs: Date.UTC(2026, 6, 17, 12, 0, 0),
    resolvedWallet: someValidAddr,
    assetId: LEGACY_ASSET_FNODE,
    amount: 10,
  };
  it("string-typed unlock rows (unlockAtMs=null) never pay — BSON type bracketing", () => {
    const out = computeWindowPayouts([{ ...base, unlockAtMs: null }], "2026-07-17");
    expect(out.wallets.size).toBe(0);
    expect(out.devicesWithoutWallet).toBe(0);
  });
  it("out-of-window rows excluded; boundary 23:59:59 inclusive", () => {
    const lastSec = { ...base, unlockAtMs: Date.UTC(2026, 6, 17, 23, 59, 59, 0) };
    const nextDay = { ...base, seq: 2, unlockAtMs: Date.UTC(2026, 6, 18, 0, 0, 0, 0) };
    const out = computeWindowPayouts([lastSec, nextDay], "2026-07-17");
    expect(out.wallets.get(someValidAddr)?.fnodeMicro).toBe(10_000_000);
    expect(out.wallets.get(someValidAddr)?.deviceCount).toBe(1);
  });
  it("missing/invalid wallet rows accumulate into devicesWithoutWallet", () => {
    const rows: LegacyWeeklyRow[] = [
      { ...base, resolvedWallet: null },
      { ...base, seq: 2, resolvedWallet: "not-a-wallet" },
    ];
    const out = computeWindowPayouts(rows, "2026-07-17");
    expect(out.wallets.size).toBe(0);
    expect(out.devicesWithoutWallet).toBe(2);
  });
  it("zero-total wallets are dropped (floor(sum*1e6) must be > 0)", () => {
    const out = computeWindowPayouts([{ ...base, assetId: LEGACY_ASSET_TFRY, amount: 0 }], "2026-07-17");
    expect(out.wallets.size).toBe(0);
  });
});

// ---------- parity fixture (real migrated data vs verbatim deployed GT) ----------
// Rows are the fry3 PG legacy_weekly_rewards extract (migration-parity-proven);
// expected outputs are the VERBATIM deployed weekly_publish.py aggregation results
// (P5.5 ground truth). The full 45-window history matched 0-diff; these three
// windows keep that proof executable in CI: the current fNODE-only fleet
// (2026-07-17), an earlier heavier window (2026-06-26), and a window with 24
// invalid/missing-wallet carry rows (2026-02-27).
describe("payout parity vs deployed old-stack ground truth", () => {
  for (const windowDate of Object.keys(FIXTURE.windows)) {
    it(`window ${windowDate} is base-unit exact`, () => {
      const { rows, expected } = FIXTURE.windows[windowDate];
      const input: LegacyWeeklyRow[] = rows.map((r: any) => ({
        seq: r.seq,
        unlockAtMs: r.ms,
        resolvedWallet: r.wallet,
        assetId: r.assetId,
        amount: r.amount,
      }));
      const out = computeWindowPayouts(input, windowDate);
      expect(out.devicesWithoutWallet).toBe(expected.devices_without_wallet);
      expect(out.wallets.size).toBe(Object.keys(expected.wallets).length);
      for (const [addr, exp] of Object.entries<any>(expected.wallets)) {
        const got = out.wallets.get(addr);
        expect(got, `wallet ${addr} missing`).toBeDefined();
        expect(got!.tfryMicro).toBe(exp.tfry);
        expect(got!.fnodeMicro).toBe(exp.fnode);
        expect(got!.deviceCount).toBe(exp.device_count);
      }
    });
  }
});
