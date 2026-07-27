/**
 * Tooth B (R3) — pure field-checksum comparator.
 *
 * The drift monitor (monitor.ts + drift.ts) is real, but pre-flip the live
 * adapter (runtime.ts) fed it a HARD-CODED `checksumMismatches: 0` and
 * `newestSyncedEpochMs: null` — so a mapping's "clean" verdict was vacuous
 * (iter29 FINDING 1). This module is the missing comparison LOGIC, kept pure
 * (no store / clock / driver deps) so the on-host gate exercises it with seeded
 * match/mismatch fixtures (teeth): a genuine field divergence MUST surface as a
 * nonzero mismatch count, and identical stores MUST report zero.
 *
 * Per contracts/toothB-bridge-design.md the comparator samples the N newest
 * keys on the TARGET store (by freshness marker) and checksums the mapping's
 * owned fields against the OWNER store for those same keys. runtime.ts supplies
 * the real projections read READ-ONLY from Mongo + fry3 PG; this file decides
 * match/mismatch deterministically.
 */

/** One row projected from a store: join-key, freshness marker, owned field values. */
export interface KeyedProjection {
  /** mapping join-key value (e.g. miner_key, install_id, "miner_key|day", claim id) */
  key: string;
  /** freshness marker for this row in epoch ms, or null if the row has no marker */
  markerEpochMs: number | null;
  /** owned logical field name -> value (only the mapping's declared fields) */
  values: Record<string, unknown>;
}

export interface CompareInput {
  /** logical fields owned by the mapping (the ONLY fields compared) */
  fields: string[];
  /** authoritative-side rows (owner store of the sync direction) */
  owner: KeyedProjection[];
  /** bridged/read-side rows (target store — freshness marker lives here) */
  target: KeyedProjection[];
  /** how many of the newest target keys to compare (design N=100) */
  sampleN: number;
}

export interface CompareResult {
  /** how many keys were actually compared (<= sampleN) */
  sampleSize: number;
  /** how many compared keys diverge on any owned field (incl. owner-missing) */
  mismatches: number;
  /** newest target marker across ALL target rows (epoch ms), or null if none */
  newestSyncedEpochMs: number | null;
  /** the mismatching keys (sorted, bounded to the sample) — evidence for alerts */
  mismatchKeys: string[];
}

/**
 * Canonicalize a field value for cross-store equality. PG stores base-unit
 * amounts as strings; Mongo may hold the same number as a double/int. Booleans
 * may arrive as 0/1 or "true". This normalizes numbers to a canonical decimal
 * string and coerces null/undefined to a single empty sentinel, so an honest
 * value match is not reported as drift and a real difference still is.
 */
export function canon(v: unknown): string {
  if (v === null || v === undefined) return " null";
  // Booleans unify with 0/1 so a `banned`/flag field stored boolean in one store
  // and 0/1 in the other is not reported as false drift.
  if (typeof v === "boolean") return v ? "n:1" : "n:0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return `n:${String(v)}`;
    // Normalize -0 and integral doubles; keep full precision otherwise.
    return Number.isInteger(v) ? `n:${v.toFixed(0)}` : `n:${String(v)}`;
  }
  if (typeof v === "bigint") return `n:${v.toString()}`;
  if (typeof v === "string") {
    // A numeric string compares equal to the same number (PG "250" == Mongo 250).
    const t = v.trim();
    if (t !== "" && /^-?\d+$/.test(t)) return `n:${BigInt(t).toString()}`;
    if (t !== "" && /^-?\d+\.\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return Number.isInteger(n) ? `n:${n.toFixed(0)}` : `n:${String(n)}`;
    }
    return `s:${v}`;
  }
  // Objects/arrays: stable stringify (sorted keys) so ordering never fabricates drift.
  return `j:${stableStringify(v)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** True if two projections agree on EVERY owned field (after canonicalization). */
export function rowsMatch(fields: string[], a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const f of fields) {
    if (canon(a[f]) !== canon(b[f])) return false;
  }
  return true;
}

/** Newest marker across a set of rows (nulls ignored), or null if none present. */
export function newestMarker(rows: KeyedProjection[]): number | null {
  let max: number | null = null;
  for (const r of rows) {
    if (r.markerEpochMs !== null && (max === null || r.markerEpochMs > max)) max = r.markerEpochMs;
  }
  return max;
}

/**
 * Compare owner vs target over the N newest TARGET keys for a mapping's owned
 * fields. A key counts as a mismatch when the owner is missing it or any owned
 * field diverges. Deterministic: newest-first by marker, ties broken by key.
 */
export function compareFields(input: CompareInput): CompareResult {
  const { fields, owner, target, sampleN } = input;
  const ownerByKey = new Map<string, KeyedProjection>();
  for (const r of owner) ownerByKey.set(r.key, r);

  // Newest-first: marker desc (nulls last), then key asc for a stable order.
  const ordered = [...target].sort((a, b) => {
    const am = a.markerEpochMs;
    const bm = b.markerEpochMs;
    if (am !== bm) {
      if (am === null) return 1;
      if (bm === null) return -1;
      return bm - am;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const sample = ordered.slice(0, Math.max(0, sampleN));
  const mismatchKeys: string[] = [];
  for (const tRow of sample) {
    const oRow = ownerByKey.get(tRow.key);
    if (oRow === undefined || !rowsMatch(fields, oRow.values, tRow.values)) {
      mismatchKeys.push(tRow.key);
    }
  }
  mismatchKeys.sort();

  return {
    sampleSize: sample.length,
    mismatches: mismatchKeys.length,
    newestSyncedEpochMs: newestMarker(target),
    mismatchKeys,
  };
}

/* ==========================================================================
 * OPTION 1 (P9f) — dedup + baseline-aware SET comparison for set-keyed mappings.
 * Operator-ratified 2026-07-22 (plans/fry3-p9f-option1-ratification.md).
 *
 * WHY a second comparator exists (do NOT replace compareFields): the
 * `fem_installs` mapping's target store (live Mongo `PoC.installations`) is a
 * continuously-growing collection that also holds JUNK DUPLICATE docs — a
 * test/placeholder install_id (×2) and a 2026-06-01 collision (×2). Compared
 * against a FROZEN PG snapshot it therefore ALWAYS shows a nonzero raw doc-count
 * delta (468 vs 466) that is NOT real drift. compareFields()/raw count-delta
 * would false-alarm forever, making tooth-B "clean" architecturally unreachable
 * (iter32 HOLD).
 *
 * OPTION 1's "clean" verdict is dedup + baseline-aware AND STILL MEANINGFUL. It
 * alarms on any of:
 *   (a) the deduped symmetric set-difference exceeding a churn tolerance,
 *   (b) a field-checksum mismatch on an install present in BOTH stores
 *       (the real cross-store drift signal — preserved from compareFields), or
 *   (c) the OWNER (PG) distinct-key count regressing below a pinned baseline.
 * It only stops false-alarming on live-Mongo dupes + benign additive
 * new-install churn. It NEVER hard-codes clean (that would be a gate-loosening,
 * which the ratification explicitly forbids).
 * ======================================================================== */

export interface DedupSetInput {
  /** owned logical fields checksummed on the INTERSECTION (dedup'd shared keys) */
  fields: string[];
  /** owner-store rows (PG); duplicate keys collapse to one canonical row */
  owner: KeyedProjection[];
  /** target-store rows (Mongo); duplicate keys (live junk dupes) collapse */
  target: KeyedProjection[];
  /** symmetric set-difference at or below this many keys is benign churn */
  tolerance: number;
  /**
   * Pinned prior high-water of the OWNER's DISTINCT-key count (regression
   * baseline). null on first observation / pre-flip → no regression check.
   */
  priorOwnerBaseline: number | null;
}

export interface DedupSetResult {
  /** distinct owner keys (dupes collapsed) */
  distinctOwner: number;
  /** distinct target keys (dupes collapsed) */
  distinctTarget: number;
  /** distinct owner keys absent from target */
  ownerOnly: number;
  /** distinct target keys absent from owner (new-install churn lives here) */
  targetOnly: number;
  /** ownerOnly + targetOnly */
  symmetricDiff: number;
  /** symmetricDiff <= tolerance */
  withinTolerance: boolean;
  /** keys present in BOTH stores (deduped) — the checksum sample */
  intersectionSize: number;
  /** intersection keys whose owned fields diverge (the real drift signal) */
  intersectionMismatches: number;
  intersectionMismatchKeys: string[];
  /** owner distinct rows lost vs the pinned baseline (0 when baseline null/grown) */
  ownerRegression: number;
  /** newest target marker across ALL target rows, or null */
  newestSyncedEpochMs: number | null;
  /** final verdict: true = drift this cycle */
  drift: boolean;
  reasons: string[];
}

/**
 * Collapse duplicate keys to ONE canonical projection per key, deterministically:
 * keep the row with the newest marker (a real marker beats null); ties broken by
 * the lexicographically-smallest canonicalized value string so the choice never
 * depends on input order.
 */
export function dedupByKey(rows: KeyedProjection[]): Map<string, KeyedProjection> {
  const best = new Map<string, KeyedProjection>();
  for (const r of rows) {
    const cur = best.get(r.key);
    if (cur === undefined) {
      best.set(r.key, r);
      continue;
    }
    const rm = r.markerEpochMs;
    const cm = cur.markerEpochMs;
    let take: boolean;
    if (rm !== cm) {
      // real marker beats null; otherwise the larger (newer) marker wins
      take = cm === null ? rm !== null : rm !== null && rm > cm;
    } else {
      take = stableStringify(r.values) < stableStringify(cur.values);
    }
    if (take) best.set(r.key, r);
  }
  return best;
}

/**
 * Dedup + baseline-aware set comparison for fem_installs (OPTION 1). Distinct
 * install_id sets are compared (junk dupes collapse); the symmetric difference
 * is measured against a churn tolerance; the field checksum runs on the
 * INTERSECTION only (owner-missing target keys are churn, not checksum drift);
 * and a pinned owner baseline catches PG regression. Pure + deterministic.
 */
export function compareDedupSets(input: DedupSetInput): DedupSetResult {
  const { fields, owner, target, tolerance, priorOwnerBaseline } = input;
  const ownerByKey = dedupByKey(owner);
  const targetByKey = dedupByKey(target);

  let ownerOnly = 0;
  for (const k of ownerByKey.keys()) if (!targetByKey.has(k)) ownerOnly += 1;

  let targetOnly = 0;
  let intersectionSize = 0;
  const intersectionMismatchKeys: string[] = [];
  for (const [k, tRow] of targetByKey) {
    const oRow = ownerByKey.get(k);
    if (oRow === undefined) {
      targetOnly += 1;
      continue;
    }
    intersectionSize += 1;
    if (!rowsMatch(fields, oRow.values, tRow.values)) intersectionMismatchKeys.push(k);
  }
  intersectionMismatchKeys.sort();

  const distinctOwner = ownerByKey.size;
  const distinctTarget = targetByKey.size;
  const symmetricDiff = ownerOnly + targetOnly;
  const tol = Math.max(0, tolerance);
  const withinTolerance = symmetricDiff <= tol;
  const ownerRegression =
    priorOwnerBaseline === null ? 0 : Math.max(0, priorOwnerBaseline - distinctOwner);
  const intersectionMismatches = intersectionMismatchKeys.length;

  const reasons: string[] = [];
  if (!withinTolerance) {
    reasons.push(
      `set_churn=${symmetricDiff}>${tol}(owner_only=${ownerOnly},target_only=${targetOnly})`,
    );
  }
  if (intersectionMismatches > 0) {
    reasons.push(`intersection_checksum=${intersectionMismatches}/${intersectionSize}`);
  }
  if (ownerRegression > 0) {
    reasons.push(`owner_regression=${ownerRegression}(baseline=${priorOwnerBaseline},now=${distinctOwner})`);
  }

  return {
    distinctOwner,
    distinctTarget,
    ownerOnly,
    targetOnly,
    symmetricDiff,
    withinTolerance,
    intersectionSize,
    intersectionMismatches,
    intersectionMismatchKeys,
    ownerRegression,
    newestSyncedEpochMs: newestMarker(target),
    drift: !withinTolerance || intersectionMismatches > 0 || ownerRegression > 0,
    reasons,
  };
}
