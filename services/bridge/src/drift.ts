/**
 * Tooth B (R3) — drift calculation (pure).
 *
 * Per contracts/toothB-bridge-design.md the comparator loop computes, per
 * mapping, every cycle: (a) row/doc count delta, (b) max lag = now − newest
 * synced marker, (c) checksum sample over the N newest keys. It ALARMS when:
 *   - lag > 15 min, OR
 *   - a mismatch persists 3 consecutive cycles, OR
 *   - the bridge process is down.
 *
 * All timing is passed in (nowMs) so this is deterministic and unit-testable
 * with no clock dependency.
 */

export interface DriftThresholds {
  /** lag ceiling in ms (design: 15 min) */
  maxLagMs: number;
  /** consecutive cycles a data mismatch must persist before it alarms (design: 3) */
  persistCycles: number;
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  maxLagMs: 15 * 60 * 1000,
  persistCycles: 3,
};

/**
 * OPTION 1 (P9f, operator-ratified 2026-07-22 — plans/fry3-p9f-option1-ratification.md).
 * Pre-decided dedup/baseline-aware drift verdict for SET-KEYED mappings
 * (fem_installs), computed by compare.ts#compareDedupSets from the DISTINCT
 * install_id sets. When a sample carries this, evalCycle uses `drift` as the
 * mismatch trigger INSTEAD of the raw |pgCount-mongoCount| count-delta — a live
 * collection with benign live-Mongo dupes + additive new-install churn always
 * shows a nonzero raw delta that is NOT real drift. The verdict is still
 * meaningful: `drift` is true iff the deduped symmetric set-difference exceeds
 * tolerance, the intersection field-checksum diverges, or the PG owner regressed
 * below its pinned baseline (never hard-coded clean).
 */
export interface SetDriftVerdict {
  drift: boolean;
  reasons: string[];
}

/** One comparator observation for a single mapping. */
export interface MappingSample {
  key: string;
  pgCount: number;
  mongoCount: number;
  /** newest bridged record's marker on the TARGET store (epoch ms), or null if none yet */
  newestSyncedEpochMs: number | null;
  /** how many of the newest keys were checksum-compared (design N=100) */
  checksumSampleSize: number;
  /** how many of those mismatched */
  checksumMismatches: number;
  /**
   * OPTION 1 (P9f): dedup/baseline-aware verdict for a set-keyed mapping. When
   * present it REPLACES the raw count-delta as the mismatch trigger (dupes +
   * benign churn tolerated); pgCount/mongoCount are still carried verbatim for
   * operator log fidelity. Absent → legacy raw count-delta drift (unchanged).
   */
  setDrift?: SetDriftVerdict;
}

export interface CycleEval {
  key: string;
  countDelta: number;
  lagMs: number | null;
  checksumMismatch: boolean;
  lagBreach: boolean;
  /** data drift this cycle: count delta > 0 OR any checksum mismatch (or set verdict) */
  mismatch: boolean;
  reasons: string[];
}

/** Running per-mapping state carried across cycles (for the persist-N rule). */
export interface MappingState {
  consecutiveMismatch: number;
}

export function initState(): MappingState {
  return { consecutiveMismatch: 0 };
}

export function evalCycle(
  s: MappingSample,
  nowMs: number,
  t: DriftThresholds = DEFAULT_THRESHOLDS,
): CycleEval {
  const countDelta = Math.abs(s.pgCount - s.mongoCount);
  const lagMs =
    s.newestSyncedEpochMs === null ? null : Math.max(0, nowMs - s.newestSyncedEpochMs);
  const checksumMismatch = s.checksumMismatches > 0;
  const lagBreach = lagMs !== null && lagMs > t.maxLagMs;

  const reasons: string[] = [];
  let mismatch: boolean;
  if (s.setDrift) {
    // Set-keyed mapping (OPTION 1): the dedup/baseline-aware verdict decides
    // drift; the raw count-delta is informational only (dupes + additive
    // new-install churn are benign and must not false-alarm).
    mismatch = s.setDrift.drift;
    reasons.push(...s.setDrift.reasons);
  } else {
    mismatch = countDelta > 0 || checksumMismatch;
    if (countDelta > 0) reasons.push(`count_delta=${countDelta}`);
    if (checksumMismatch)
      reasons.push(`checksum_mismatch=${s.checksumMismatches}/${s.checksumSampleSize}`);
  }
  if (lagBreach) reasons.push(`lag=${lagMs}ms>${t.maxLagMs}ms`);

  return { key: s.key, countDelta, lagMs, checksumMismatch, lagBreach, mismatch, reasons };
}

/** Advance the running state given this cycle's eval. */
export function updateState(prev: MappingState, ev: CycleEval): MappingState {
  return {
    consecutiveMismatch: ev.mismatch ? prev.consecutiveMismatch + 1 : 0,
  };
}

export interface AlarmDecision {
  key: string;
  alarm: boolean;
  reasons: string[];
}

/**
 * Alarm rule (design): lag breach (single cycle) OR mismatch persisted
 * `persistCycles` consecutive cycles OR the bridge process is down.
 * `state` must already reflect THIS cycle (call updateState first).
 */
export function decideAlarm(
  ev: CycleEval,
  state: MappingState,
  processDown: boolean,
  t: DriftThresholds = DEFAULT_THRESHOLDS,
): AlarmDecision {
  const reasons: string[] = [];
  if (processDown) reasons.push("process_down");
  if (ev.lagBreach) reasons.push(...ev.reasons.filter((r) => r.startsWith("lag=")));
  if (state.consecutiveMismatch >= t.persistCycles) {
    reasons.push(`mismatch_persisted=${state.consecutiveMismatch}>=${t.persistCycles}`);
  }
  return { key: ev.key, alarm: reasons.length > 0, reasons };
}
