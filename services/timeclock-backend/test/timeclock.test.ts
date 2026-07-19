import { describe, it, expect } from "vitest";
import {
  canClockIn,
  canClockOut,
  validClockOut,
  durationSeconds,
  dedupeClockEvents,
  reconcileEntries,
  TimeclockEntry,
} from "../src/timeclock";

const t0 = new Date("2026-07-19T09:00:00.000Z");
const t1 = new Date("2026-07-19T17:00:00.000Z");

const open: TimeclockEntry = { id: "e1", workerId: "w1", clockInAt: t0, clockOutAt: null };
const closed: TimeclockEntry = { id: "e1", workerId: "w1", clockInAt: t0, clockOutAt: t1 };

describe("clock in/out guards", () => {
  it("can clock in when no open entry", () => {
    expect(canClockIn(null).ok).toBe(true);
    expect(canClockIn(closed).ok).toBe(true);
  });
  it("cannot clock in when already open", () => {
    expect(canClockIn(open).reason).toBe("already_clocked_in");
  });
  it("can clock out when open", () => {
    expect(canClockOut(open).ok).toBe(true);
  });
  it("cannot clock out when not clocked in", () => {
    expect(canClockOut(null).reason).toBe("not_clocked_in");
    expect(canClockOut(closed).reason).toBe("not_clocked_in");
  });
});

describe("validClockOut + duration", () => {
  it("clock-out after clock-in valid", () => {
    expect(validClockOut(open, t1)).toBe(true);
  });
  it("clock-out before clock-in invalid", () => {
    expect(validClockOut(open, new Date(t0.getTime() - 1000))).toBe(false);
  });
  it("duration integer seconds", () => {
    expect(durationSeconds(closed)).toBe(8 * 3600);
    expect(durationSeconds(open)).toBe(0);
  });
});

describe("dedupeClockEvents (no lost/dup)", () => {
  it("dedupes by idempotency key", () => {
    const ev = (k: string) => ({ workerId: "w1", at: t0, idempotencyKey: k });
    const out = dedupeClockEvents([ev("a"), ev("a"), ev("b")]);
    expect(out).toHaveLength(2);
  });
});

describe("reconcileEntries", () => {
  it("detects missing + duplicates", () => {
    const source = [{ id: "a" }, { id: "b" }] as TimeclockEntry[];
    const target = [{ id: "a" }, { id: "a" }] as TimeclockEntry[];
    const r = reconcileEntries(source, target);
    expect(r.missingInTarget).toEqual(["b"]);
    expect(r.duplicatesInTarget).toEqual(["a"]);
  });
});
