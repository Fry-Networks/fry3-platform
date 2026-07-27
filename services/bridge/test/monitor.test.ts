import { describe, it, expect, vi } from "vitest";
import { runCycle, runBounded, initStates, type MonitorDeps } from "../src/monitor.js";
import { MAPPINGS, mappingByKey, type FieldMapping } from "../src/mappings.js";
import type { MappingSample } from "../src/drift.js";
import type { UpsertOp } from "../src/writer.js";

const NOW = 1_784_700_000_000;

/** Build deps over a single mapping so counts are predictable. */
function deps(over: Partial<MonitorDeps> = {}) {
  const one = mappingByKey("device_liveness")!;
  const sink = vi.fn(async (_op: UpsertOp) => {});
  const send = vi.fn(
    async (_url: string, _body: string, _headers: Record<string, string>) => ({ status: 204 }),
  );
  const cleanSample = (m: FieldMapping): Promise<MappingSample> =>
    Promise.resolve({
      key: m.key,
      pgCount: 10,
      mongoCount: 10,
      newestSyncedEpochMs: NOW,
      checksumSampleSize: 100,
      checksumMismatches: 0,
    });
  const d: MonitorDeps = {
    mappings: [one],
    sample: cleanSample,
    readSource: async () => [{ keyValue: "MINER_A", values: { last_heartbeat_at: NOW, online_status: "ONLINE" } }],
    sink,
    send,
    alert: { webhookUrl: "https://d/webhook", userAgent: "ua" },
    now: () => NOW,
    dryRun: true,
    ...over,
  };
  return { d, sink, send };
}

describe("monitor: dry-run safety", () => {
  it("dry-run cycle never writes the sink or sends, even when an alarm fires", async () => {
    // process down => alarm fires this very cycle
    const { d, sink, send } = deps({ processDown: () => true });
    const states = initStates(d.mappings);
    const r = await runCycle(d, states, 1);
    expect(r.firing).toBe(1);
    expect(r.alerted).toBe(false); // suppressed in dry-run
    expect(send).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(r.writes).toEqual({ planned: 1, applied: 0, skippedDryRun: 1 });
  });
});

describe("monitor: persistence across cycles", () => {
  it("a data mismatch alarms only after 3 consecutive cycles", async () => {
    const drift = (m: FieldMapping): Promise<MappingSample> =>
      Promise.resolve({
        key: m.key,
        pgCount: 10,
        mongoCount: 0,
        newestSyncedEpochMs: NOW,
        checksumSampleSize: 100,
        checksumMismatches: 0,
      });
    const { d } = deps({ sample: drift });
    const states = initStates(d.mappings);
    expect((await runCycle(d, states, 1)).firing).toBe(0);
    expect((await runCycle(d, states, 2)).firing).toBe(0);
    expect((await runCycle(d, states, 3)).firing).toBe(1);
  });
});

describe("monitor: live path", () => {
  it("non-dry-run alarm posts exactly one alert and writes the sink", async () => {
    const { d, sink, send } = deps({ dryRun: false, processDown: () => true });
    const states = initStates(d.mappings);
    const r = await runCycle(d, states, 5);
    expect(r.alerted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1); // one source row -> one op
    expect(r.writes.applied).toBe(1);
  });
});

describe("monitor: runBounded", () => {
  it("runs N cycles and sleeps N-1 times", async () => {
    const { d } = deps();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const reports = await runBounded(d, 3, 12345, sleep);
    expect(reports).toHaveLength(3);
    expect(reports.map((r) => r.cycle)).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([12345, 12345]);
  });

  it("covers all 7 real mappings in a cycle without error", async () => {
    const { d } = deps({
      mappings: MAPPINGS,
      sample: async (m) => ({
        key: m.key,
        pgCount: 1,
        mongoCount: 1,
        newestSyncedEpochMs: NOW,
        checksumSampleSize: 100,
        checksumMismatches: 0,
      }),
      readSource: async () => [],
    });
    const states = initStates(MAPPINGS);
    const r = await runCycle(d, states, 1);
    expect(r.evals).toHaveLength(7);
    expect(r.firing).toBe(0);
  });
});
