import { describe, it, expect } from "vitest";
import { serializeRecord, parseLine, foldLedger } from "../src/ledger.js";
import type { LedgerRecord } from "../src/types.js";

const rec = (over: Partial<LedgerRecord>): LedgerRecord => ({
  intentId: "id1",
  deviceId: "d1",
  address: "A".repeat(58),
  asaId: 3612979527,
  amountBase: "100",
  armEpoch: 1784733595,
  phase: "intent",
  ts: "2026-07-22T15:00:00Z",
  ...over,
});

describe("append-only send-ledger (R14.5.4)", () => {
  it("serialize → parse round-trips", () => {
    const r = rec({ phase: "confirm", txid: "TX1" });
    expect(parseLine(serializeRecord(r))).toEqual(r);
  });

  it("fold: intent then confirm → txid resolved", () => {
    const f = foldLedger([rec({}), rec({ phase: "confirm", txid: "TX1" })]);
    expect(f.get("id1")).toEqual({ intentWritten: true, txid: "TX1" });
  });

  it("fold: intent only → intentWritten true, txid null (crash-before-confirm)", () => {
    const f = foldLedger([rec({})]);
    expect(f.get("id1")).toEqual({ intentWritten: true, txid: null });
  });

  it("fold: last confirm wins across duplicate confirms", () => {
    const f = foldLedger([
      rec({}),
      rec({ phase: "confirm", txid: "TX1" }),
      rec({ phase: "confirm", txid: "TX2" }),
    ]);
    expect(f.get("id1")!.txid).toBe("TX2");
  });

  it("fold: independent intents tracked separately", () => {
    const f = foldLedger([
      rec({ intentId: "a" }),
      rec({ intentId: "b", phase: "confirm", txid: "TXB" }),
    ]);
    expect(f.get("a")!.txid).toBe(null);
    expect(f.get("b")!.txid).toBe("TXB");
  });
});
