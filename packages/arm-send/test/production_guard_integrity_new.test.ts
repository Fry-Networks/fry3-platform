import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeFileSettlementProductionGuard,
  type SettlementProcessOwner,
  type SettlementProductionGuardOptions,
} from "../src/production-guard.js";

const AUTHENTICATION_KEY = new Uint8Array(32).fill(7);
const CLAIM_A = "6812b9ab-3b50-4866-8e0c-f5f625e72765";
const CLAIM_B = "8d502632-9c8b-4b23-9a74-7996b4fdd922";
const LOCK_FILE = ".settlement-production.lock";
const REGISTRY_FILE = "settlement-claim-reservations.jsonl";

const reservation = {
  batchId: "p9final_1784868963",
  manifestSha256: "a".repeat(64),
  claimIds: [CLAIM_A],
};

function tempRoots() {
  return {
    approvedRoot: mkdtempSync(join(tmpdir(), "fry3-ledger-root-")),
    guardRoot: mkdtempSync(join(tmpdir(), "fry3-guard-root-")),
  };
}

function options(
  roots: ReturnType<typeof tempRoots>,
  overrides: Partial<SettlementProductionGuardOptions> = {}
): SettlementProductionGuardOptions {
  return {
    ...roots,
    authenticationKey: AUTHENTICATION_KEY,
    leaseMs: 1_000,
    ...overrides,
  };
}

const staleOwner: SettlementProcessOwner = {
  pid: 900_001,
  hostname: "guard-test-host",
  startIdentity: "old-process-start",
};

const currentOwner: SettlementProcessOwner = {
  pid: 900_002,
  hostname: "guard-test-host",
  startIdentity: "current-process-start",
};

describe("settlement production guard recovery and integrity", () => {
  it("recovers an exact batch when the lock owner is dead and its bounded lease expired", async () => {
    const roots = tempRoots();
    let nowMs = 1_000;
    let staleLock = "";
    const first = makeFileSettlementProductionGuard(
      options(roots, { nowMs: () => nowMs, owner: staleOwner })
    );

    await first.runExclusive(reservation, async () => {
      staleLock = readFileSync(join(roots.guardRoot, LOCK_FILE), "utf8");
      return "captured";
    });
    writeFileSync(join(roots.guardRoot, LOCK_FILE), staleLock, { mode: 0o600 });
    nowMs = 2_001;

    const recovered = makeFileSettlementProductionGuard(
      options(roots, {
        nowMs: () => nowMs,
        owner: currentOwner,
        inspectProcess: () => ({ state: "dead" }),
      })
    );

    await expect(
      recovered.runExclusive(reservation, async () => "resumed")
    ).resolves.toBe("resumed");
  });

  it("fails closed when an expired lock still belongs to a live process", async () => {
    const roots = tempRoots();
    let nowMs = 1_000;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = makeFileSettlementProductionGuard(
      options(roots, { nowMs: () => nowMs, owner: staleOwner })
    );
    const active = first.runExclusive(reservation, async () => {
      enter();
      await held;
      return "first";
    });
    await entered;
    nowMs = 2_001;

    const contender = makeFileSettlementProductionGuard(
      options(roots, {
        nowMs: () => nowMs,
        owner: currentOwner,
        inspectProcess: () => ({
          state: "alive",
          startIdentity: staleOwner.startIdentity,
        }),
      })
    );

    await expect(
      contender.runExclusive(reservation, async () => "duplicate")
    ).rejects.toThrow(/lock|live|already running/i);
    release();
    await expect(active).resolves.toBe("first");
  });

  it("rejects malformed expired lock metadata without deleting it", async () => {
    const roots = tempRoots();
    const lockPath = join(roots.guardRoot, LOCK_FILE);
    writeFileSync(lockPath, "not-json\n", { mode: 0o600 });
    const guard = makeFileSettlementProductionGuard(
      options(roots, {
        nowMs: () => 5_000,
        owner: currentOwner,
        inspectProcess: () => ({ state: "dead" }),
      })
    );

    await expect(
      guard.runExclusive(reservation, async () => "unsafe")
    ).rejects.toThrow(/lock.*metadata|invalid.*lock/i);
    expect(readFileSync(lockPath, "utf8")).toBe("not-json\n");
  });

  it("fails closed when the durable reservation registry disappears", async () => {
    const roots = tempRoots();
    const guard = makeFileSettlementProductionGuard(options(roots));
    await guard.runExclusive(reservation, async () => "first");
    unlinkSync(join(roots.approvedRoot, REGISTRY_FILE));

    await expect(
      guard.runExclusive(
        {
          ...reservation,
          batchId: "different-batch",
          manifestSha256: "b".repeat(64),
        },
        async () => "duplicate"
      )
    ).rejects.toThrow(/registry|anchor|integrity|missing/i);
  });

  it("fails closed when the registry is replaced with valid but incomplete records", async () => {
    const roots = tempRoots();
    const guard = makeFileSettlementProductionGuard(options(roots));
    await guard.runExclusive(
      { ...reservation, claimIds: [CLAIM_A, CLAIM_B] },
      async () => "first"
    );
    const registryPath = join(roots.approvedRoot, REGISTRY_FILE);
    const [firstRecord] = readFileSync(registryPath, "utf8")
      .trim()
      .split("\n");
    writeFileSync(registryPath, `${firstRecord}\n`, { mode: 0o600 });

    await expect(
      guard.runExclusive(
        {
          ...reservation,
          batchId: "different-batch",
          manifestSha256: "b".repeat(64),
          claimIds: [CLAIM_B],
        },
        async () => "duplicate"
      )
    ).rejects.toThrow(/registry|anchor|integrity|truncat/i);
  });

  it("rejects a registry record whose authenticated fields were modified", async () => {
    const roots = tempRoots();
    const guard = makeFileSettlementProductionGuard(options(roots));
    await guard.runExclusive(reservation, async () => "first");
    const registryPath = join(roots.approvedRoot, REGISTRY_FILE);
    const record = JSON.parse(readFileSync(registryPath, "utf8").trim()) as Record<
      string,
      unknown
    >;
    writeFileSync(
      registryPath,
      `${JSON.stringify({ ...record, batchId: "tampered-batch" })}\n`,
      { mode: 0o600 }
    );

    await expect(
      guard.runExclusive(reservation, async () => "unsafe-resume")
    ).rejects.toThrow(/registry|authentication|integrity|tamper/i);
  });
});
