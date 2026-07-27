import { describe, it, expect, vi } from "vitest";
import { planOps, applyOps, type SourceRow, type OpSink, type UpsertOp } from "../src/writer.js";
import { mappingByKey } from "../src/mappings.js";

const rows: SourceRow[] = [
  { keyValue: "MINER_A", values: { last_heartbeat_at: 111, online_status: "ONLINE", extra: "x" } },
  { keyValue: "MINER_B", values: { last_heartbeat_at: 222, online_status: "OFFLINE" } },
];

describe("writer: planOps", () => {
  it("PG-owned mapping writes the Mongo store, only declared fields", () => {
    const m = mappingByKey("device_liveness")!;
    const ops = planOps(m, rows);
    expect(ops).toHaveLength(2);
    expect(ops[0].store).toBe("MONGO");
    expect(ops[0].target).toBe("main.devices");
    expect(ops[0].keyBy).toBe("miner_key");
    expect(ops[0].keyValue).toBe("MINER_A");
    expect(ops[0].set).toEqual({ last_heartbeat_at: 111, online_status: "ONLINE" });
    expect(ops[0].set).not.toHaveProperty("extra"); // fields outside the contract dropped
  });

  it("Mongo-owned mapping writes the PG store", () => {
    const m = mappingByKey("blacklist_ban")!;
    const ops = planOps(m, [{ keyValue: "MINER_A", values: { banned: true } }]);
    expect(ops[0].store).toBe("PG");
    expect(ops[0].set).toEqual({ banned: true });
  });
});

describe("writer: applyOps", () => {
  it("dry-run NEVER calls the sink; reports all ops skipped", async () => {
    const m = mappingByKey("device_liveness")!;
    const ops = planOps(m, rows);
    const sink = vi.fn(async (_op: UpsertOp) => {});
    const res = await applyOps(ops, sink, true);
    expect(sink).not.toHaveBeenCalled();
    expect(res).toEqual({ planned: 2, applied: 0, skippedDryRun: 2 });
  });

  it("live apply calls the sink once per op", async () => {
    const m = mappingByKey("device_liveness")!;
    const ops = planOps(m, rows);
    const seen: string[] = [];
    const sink: OpSink = async (op) => {
      seen.push(op.keyValue);
    };
    const res = await applyOps(ops, sink, false);
    expect(seen).toEqual(["MINER_A", "MINER_B"]);
    expect(res).toEqual({ planned: 2, applied: 2, skippedDryRun: 0 });
  });
});
