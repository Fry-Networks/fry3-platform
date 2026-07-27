import { describe, it, expect } from "vitest";
import {
  evalCycle,
  updateState,
  decideAlarm,
  initState,
  type MappingSample,
} from "../src/drift.js";

const NOW = 1_784_700_000_000;

/** A fem_installs-shaped sample carrying an OPTION-1 setDrift verdict. */
function femSample(over: Partial<MappingSample> = {}): MappingSample {
  return {
    key: "fem_installs",
    pgCount: 466,
    mongoCount: 468, // raw delta 2 (junk dupes) — must NOT trigger on its own
    newestSyncedEpochMs: NOW,
    checksumSampleSize: 466,
    checksumMismatches: 0,
    setDrift: { drift: false, reasons: [] },
    ...over,
  };
}

describe("drift: setDrift verdict overrides raw count-delta (OPTION 1)", () => {
  it("setDrift.drift=false makes a nonzero raw count-delta (466 vs 468) NOT a mismatch", () => {
    const ev = evalCycle(femSample(), NOW);
    expect(ev.countDelta).toBe(2); // raw delta still reported for log fidelity
    expect(ev.mismatch).toBe(false); // ...but does NOT trigger drift
    expect(ev.reasons).toEqual([]); // no set reasons, no lag
  });

  it("setDrift.drift=true flags mismatch and carries the set reasons", () => {
    const ev = evalCycle(
      femSample({ setDrift: { drift: true, reasons: ["set_churn=9>5(owner_only=1,target_only=8)"] } }),
      NOW,
    );
    expect(ev.mismatch).toBe(true);
    expect(ev.reasons).toContain("set_churn=9>5(owner_only=1,target_only=8)");
  });

  it("intersection-checksum drift surfaces via setDrift reasons (not the legacy checksum path)", () => {
    const ev = evalCycle(
      femSample({
        checksumMismatches: 1,
        setDrift: { drift: true, reasons: ["intersection_checksum=1/465"] },
      }),
      NOW,
    );
    expect(ev.mismatch).toBe(true);
    expect(ev.reasons).toEqual(["intersection_checksum=1/465"]);
    // legacy per-checksum reason string is NOT emitted for a set-keyed sample
    expect(ev.reasons.some((r) => r.startsWith("checksum_mismatch="))).toBe(false);
  });

  it("set-keyed sample still honors the lag breach (appended after set reasons)", () => {
    const ev = evalCycle(
      femSample({
        newestSyncedEpochMs: NOW - 1_000_000, // > 15 min
        setDrift: { drift: true, reasons: ["owner_regression=3(baseline=10,now=7)"] },
      }),
      NOW,
    );
    expect(ev.lagBreach).toBe(true);
    expect(ev.reasons[0]).toBe("owner_regression=3(baseline=10,now=7)");
    expect(ev.reasons.some((r) => r.startsWith("lag="))).toBe(true);
  });
});

describe("drift: setDrift integrates with the persist-3 alarm state machine", () => {
  it("set-keyed drift persisting 3 consecutive cycles alarms (not before)", () => {
    let st = initState();
    const drift = () => evalCycle(femSample({ setDrift: { drift: true, reasons: ["set_churn=9>5"] } }), NOW);
    st = updateState(st, drift());
    expect(decideAlarm(drift(), st, false).alarm).toBe(false); // 1
    st = updateState(st, drift());
    expect(decideAlarm(drift(), st, false).alarm).toBe(false); // 2
    st = updateState(st, drift());
    const d = decideAlarm(drift(), st, false); // 3
    expect(d.alarm).toBe(true);
    expect(d.reasons.some((r) => r.startsWith("mismatch_persisted="))).toBe(true);
  });

  it("clean set-keyed samples never accumulate toward an alarm", () => {
    let st = initState();
    for (let i = 0; i < 5; i += 1) {
      const ev = evalCycle(femSample(), NOW); // setDrift.drift=false
      st = updateState(st, ev);
      expect(decideAlarm(ev, st, false).alarm).toBe(false);
    }
    expect(st.consecutiveMismatch).toBe(0);
  });
});
