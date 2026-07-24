import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileSettlementProductionGuard } from "../src/production-guard.js";

function makeGuard() {
  return makeFileSettlementProductionGuard({
    approvedRoot: mkdtempSync(join(tmpdir(), "fry3-production-ledger-")),
    guardRoot: mkdtempSync(join(tmpdir(), "fry3-production-guard-")),
    authenticationKey: new Uint8Array(32).fill(3),
  });
}

const reservation = {
  batchId: "p9final_1784868963",
  manifestSha256: "a".repeat(64),
  claimIds: ["6812b9ab-3b50-4866-8e0c-f5f625e72765"],
};

describe("durable settlement production guard", () => {
  it("allows exact-batch resume but permanently rejects another batch for a reserved claim", async () => {
    const guard = makeGuard();

    await guard.runExclusive(reservation, async () => "first");
    await expect(
      guard.runExclusive(reservation, async () => "resume")
    ).resolves.toBe("resume");
    await expect(
      guard.runExclusive(
        {
          ...reservation,
          batchId: "another-batch",
          manifestSha256: "b".repeat(64),
        },
        async () => "duplicate"
      )
    ).rejects.toThrow(/already reserved|different batch/i);
  });

  it("rejects a concurrent production driver while the exclusive lock is held", async () => {
    const guard = makeGuard();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = guard.runExclusive(reservation, async () => {
      enter();
      await held;
      return "first";
    });
    await entered;

    await expect(
      guard.runExclusive(reservation, async () => "second")
    ).rejects.toThrow(/lock|already running/i);

    release();
    await expect(first).resolves.toBe("first");
  });
});
