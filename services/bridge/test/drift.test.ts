import { describe, it, expect } from "vitest";
import {
  evalCycle,
  updateState,
  decideAlarm,
  initState,
  DEFAULT_THRESHOLDS,
  type MappingSample,
} from "../src/drift.js";

const NOW = 1_784_700_000_000;

function sample(over: Partial<MappingSample> = {}): MappingSample {
  return {
    key: "device_liveness",
    pgCount: 100,
    mongoCount: 100,
    newestSyncedEpochMs: NOW,
    checksumSampleSize: 100,
    checksumMismatches: 0,
    ...over,
  };
}

describe("drift: thresholds", () => {
  it("defaults match the design (15 min lag, 3 persist cycles)", () => {
    expect(DEFAULT_THRESHOLDS.maxLagMs).toBe(900_000);
    expect(DEFAULT_THRESHOLDS.persistCycles).toBe(3);
  });
});

describe("drift: evalCycle", () => {
  it("clean sample = no drift, no breach", () => {
    const ev = evalCycle(sample(), NOW);
    expect(ev.countDelta).toBe(0);
    expect(ev.lagMs).toBe(0);
    expect(ev.mismatch).toBe(false);
    expect(ev.lagBreach).toBe(false);
    expect(ev.reasons).toEqual([]);
  });

  it("count delta is absolute and flags mismatch", () => {
    const ev = evalCycle(sample({ pgCount: 100, mongoCount: 97 }), NOW);
    expect(ev.countDelta).toBe(3);
    expect(ev.mismatch).toBe(true);
    expect(ev.reasons).toContain("count_delta=3");
  });

  it("checksum mismatch flags drift", () => {
    const ev = evalCycle(sample({ checksumMismatches: 2 }), NOW);
    expect(ev.checksumMismatch).toBe(true);
    expect(ev.mismatch).toBe(true);
  });

  it("null marker => null lag, no lag breach", () => {
    const ev = evalCycle(sample({ newestSyncedEpochMs: null }), NOW);
    expect(ev.lagMs).toBeNull();
    expect(ev.lagBreach).toBe(false);
  });

  it("negative lag clamps to 0 (marker in the future)", () => {
    const ev = evalCycle(sample({ newestSyncedEpochMs: NOW + 5000 }), NOW);
    expect(ev.lagMs).toBe(0);
  });

  it("lag beyond 15 min breaches", () => {
    const ev = evalCycle(sample({ newestSyncedEpochMs: NOW - 900_001 }), NOW);
    expect(ev.lagBreach).toBe(true);
    expect(ev.reasons.some((r) => r.startsWith("lag="))).toBe(true);
  });
});

describe("drift: state + alarm", () => {
  it("state resets on clean cycle, increments on mismatch", () => {
    let st = initState();
    st = updateState(st, evalCycle(sample({ pgCount: 1, mongoCount: 0 }), NOW));
    expect(st.consecutiveMismatch).toBe(1);
    st = updateState(st, evalCycle(sample({ pgCount: 1, mongoCount: 0 }), NOW));
    expect(st.consecutiveMismatch).toBe(2);
    st = updateState(st, evalCycle(sample(), NOW)); // clean
    expect(st.consecutiveMismatch).toBe(0);
  });

  it("mismatch persisting 3 consecutive cycles alarms (not before)", () => {
    let st = initState();
    const drift = () => evalCycle(sample({ pgCount: 5, mongoCount: 0 }), NOW);
    st = updateState(st, drift());
    expect(decideAlarm(drift(), st, false).alarm).toBe(false); // 1
    st = updateState(st, drift());
    expect(decideAlarm(drift(), st, false).alarm).toBe(false); // 2
    st = updateState(st, drift());
    const d = decideAlarm(drift(), st, false); // 3
    expect(d.alarm).toBe(true);
    expect(d.reasons.some((r) => r.startsWith("mismatch_persisted="))).toBe(true);
  });

  it("lag breach alarms on a single cycle", () => {
    const ev = evalCycle(sample({ newestSyncedEpochMs: NOW - 1_000_000 }), NOW);
    const st = updateState(initState(), ev);
    expect(decideAlarm(ev, st, false).alarm).toBe(true);
  });

  it("process down alarms regardless of data", () => {
    const ev = evalCycle(sample(), NOW);
    const st = updateState(initState(), ev);
    const d = decideAlarm(ev, st, true);
    expect(d.alarm).toBe(true);
    expect(d.reasons).toContain("process_down");
  });
});
