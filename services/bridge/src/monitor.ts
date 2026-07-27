/**
 * Tooth B (R3) — comparator/monitor core (pure orchestration, deps injected).
 *
 * One `runCycle` = sample every mapping, evaluate drift, advance per-mapping
 * state, decide alarms, and (on any alarm) emit ONE Discord alert. Sync writes
 * are planned + applied through the writer in the configured dry-run mode.
 *
 * Every side-effecting collaborator (sampler, sync-source reader, op sink,
 * webhook sender, clock, sleeper) is injected, so the gate exercises the full
 * loop with zero live-store / network / timer dependency.
 */

import {
  MAPPINGS,
  type FieldMapping,
} from "./mappings.js";
import {
  evalCycle,
  updateState,
  decideAlarm,
  initState,
  type MappingSample,
  type MappingState,
  type CycleEval,
  type AlarmDecision,
  type DriftThresholds,
  DEFAULT_THRESHOLDS,
} from "./drift.js";
import {
  formatAlert,
  sendAlert,
  type AlertConfig,
  type WebhookSender,
} from "./alert.js";
import {
  planOps,
  applyOps,
  type SourceRow,
  type OpSink,
} from "./writer.js";

export interface MonitorDeps {
  mappings: FieldMapping[];
  /** read a comparator sample (counts + freshness + checksum) for a mapping */
  sample: (m: FieldMapping) => Promise<MappingSample>;
  /** read the source rows to sync for a mapping (owner store) */
  readSource: (m: FieldMapping) => Promise<SourceRow[]>;
  /** target-store upsert sink (only called when dryRun=false) */
  sink: OpSink;
  /** discord webhook sender (only called when dryRun=false and an alarm fires) */
  send: WebhookSender;
  alert: AlertConfig;
  now: () => number;
  dryRun: boolean;
  thresholds?: DriftThresholds;
  /** liveness flags per mapping key — a down source counts as process_down */
  processDown?: (m: FieldMapping) => boolean;
}

export interface CycleReport {
  cycle: number;
  evals: CycleEval[];
  alarms: AlarmDecision[];
  firing: number;
  alerted: boolean;
  dryRun: boolean;
  writes: { planned: number; applied: number; skippedDryRun: number };
}

/** Fresh per-mapping state keyed by mapping.key. */
export function initStates(mappings: FieldMapping[] = MAPPINGS): Map<string, MappingState> {
  return new Map(mappings.map((m) => [m.key, initState()]));
}

/** Run a single comparator cycle. Mutates `states` in place. */
export async function runCycle(
  deps: MonitorDeps,
  states: Map<string, MappingState>,
  cycle: number,
): Promise<CycleReport> {
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const now = deps.now();
  const evals: CycleEval[] = [];
  const alarms: AlarmDecision[] = [];
  let planned = 0;
  let applied = 0;
  let skippedDryRun = 0;

  for (const m of deps.mappings) {
    const s = await deps.sample(m);
    const ev = evalCycle(s, now, t);
    evals.push(ev);

    const prev = states.get(m.key) ?? initState();
    const next = updateState(prev, ev);
    states.set(m.key, next);

    const down = deps.processDown ? deps.processDown(m) : false;
    alarms.push(decideAlarm(ev, next, down, t));

    // Plan + apply the sync (dry-run unless flipped).
    const rows = await deps.readSource(m);
    const ops = planOps(m, rows);
    const res = await applyOps(ops, deps.sink, deps.dryRun);
    planned += res.planned;
    applied += res.applied;
    skippedDryRun += res.skippedDryRun;
  }

  const firing = alarms.filter((a) => a.alarm).length;
  let alerted = false;
  if (firing > 0) {
    const msg = formatAlert(alarms, { cycle });
    const r = await sendAlert(deps.alert, msg, deps.send, deps.dryRun);
    alerted = r.sent;
  }

  return {
    cycle,
    evals,
    alarms,
    firing,
    alerted,
    dryRun: deps.dryRun,
    writes: { planned, applied, skippedDryRun },
  };
}

/**
 * Bounded loop (foreground-managed): run `cycles` comparator cycles, sleeping
 * `intervalMs` between them via the injected sleeper. The container entrypoint
 * calls this with a large cap; the gate calls it with a tiny one.
 */
export async function runBounded(
  deps: MonitorDeps,
  cycles: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<CycleReport[]> {
  const states = initStates(deps.mappings);
  const reports: CycleReport[] = [];
  for (let i = 1; i <= cycles; i += 1) {
    reports.push(await runCycle(deps, states, i));
    if (i < cycles) await sleep(intervalMs);
  }
  return reports;
}
