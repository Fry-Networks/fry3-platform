import { describe, expect, it } from "vitest";
import { parseLine } from "../src/ledger.js";

const base = {
  intentId: "f".repeat(64),
  deviceId: "claim-id",
  address: "A".repeat(58),
  asaId: 2681521901,
  amountBase: "100",
  armEpoch: 0,
  batchId: "p9final_1784868963",
  intentDomain: "settlement",
  phase: "intent",
  ts: "2026-07-24T04:30:00.000Z",
};

describe("ledger record validation", () => {
  it.each([
    {},
    { ...base, amountBase: "1.5" },
    { ...base, asaId: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, phase: "confirm" },
    { ...base, phase: "unknown" },
    { ...base, batchId: undefined, intentDomain: "settlement" },
    { ...base, armEpoch: -1 },
  ])("rejects malformed record %#", (record) => {
    expect(() => parseLine(JSON.stringify(record))).toThrow(/ledger/i);
  });

  it("accepts a complete settlement confirmation", () => {
    const record = { ...base, phase: "confirm", txid: "A".repeat(52) };

    expect(parseLine(JSON.stringify(record))).toEqual(record);
  });
});
