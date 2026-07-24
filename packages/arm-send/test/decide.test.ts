import { describe, it, expect } from "vitest";
import { decideSend } from "../src/decide.js";
import type { FoldedIntent, ReconcileResult } from "../src/types.js";

const none: ReconcileResult = { committed: false, pending: false, txid: null };
const committed = (txid: string): ReconcileResult => ({ committed: true, pending: false, txid });
const pending: ReconcileResult = { committed: false, pending: true, txid: null };

describe("ambiguous-JSONL resume decision tree (R14.5.4)", () => {
  it("(1) txid in ledger → SKIP_TXID_PRESENT, no indexer needed", () => {
    const f: FoldedIntent = { intentWritten: true, txid: "TXOLD" };
    expect(decideSend(f, null)).toEqual({ kind: "SKIP_TXID_PRESENT", txid: "TXOLD" });
  });

  it("(2) intent written, indexer committed → SKIP_COMMITTED_BACKFILL", () => {
    const f: FoldedIntent = { intentWritten: true, txid: null };
    expect(decideSend(f, committed("TXCHAIN"))).toEqual({ kind: "SKIP_COMMITTED_BACKFILL", txid: "TXCHAIN" });
  });

  it("(2) intent written, indexer pending → SKIP_PENDING (never resubmit)", () => {
    const f: FoldedIntent = { intentWritten: true, txid: null };
    expect(decideSend(f, pending)).toEqual({ kind: "SKIP_PENDING" });
  });

  it("(2) intent written, not committed, not pending → RESEND_SAME", () => {
    const f: FoldedIntent = { intentWritten: true, txid: null };
    expect(decideSend(f, none)).toEqual({ kind: "RESEND_SAME" });
  });

  it("(3) no ledger entry, indexer committed → SKIP_COMMITTED_BACKFILL", () => {
    expect(decideSend(undefined, committed("TXC"))).toEqual({ kind: "SKIP_COMMITTED_BACKFILL", txid: "TXC" });
  });

  it("(3) no ledger entry, none → SEND_FRESH", () => {
    expect(decideSend(undefined, none)).toEqual({ kind: "SEND_FRESH" });
  });

  it("refuses to decide 'unpaid' from JSONL alone when indexer missing", () => {
    const f: FoldedIntent = { intentWritten: true, txid: null };
    expect(() => decideSend(f, null)).toThrow(/refusing to decide/);
    expect(() => decideSend(undefined, null)).toThrow(/refusing to decide/);
  });
});
