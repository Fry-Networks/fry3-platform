import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { makeFileLedgerStore } from "../src/adapters.js";

describe("file ledger path confinement", () => {
  it("rejects a ledger path outside its approved root", () => {
    const approvedRoot = resolve("approved-ledgers");
    const outside = resolve(approvedRoot, "..", "outside.jsonl");

    expect(() => makeFileLedgerStore(outside, approvedRoot)).toThrow(
      /approved ledger root/
    );
  });
});
