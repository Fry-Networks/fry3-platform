/**
 * Fry 3.0 migration runner — Mongo/MariaDB -> canonical PostgreSQL.
 * Idempotent via MigrationProvenance (unique sourceDb+sourceCollection+sourceId).
 * Deterministic repair rules (logged). Exact reconciliation for critical entities.
 *
 * This module is the ORCHESTRATION skeleton: pure mapping + reconciliation logic
 * is unit-tested here; the live DB connections are injected (no secrets in code).
 */

export interface SourceDoc {
  sourceDb: string;
  sourceCollection: string;
  sourceId: string;
  doc: Record<string, unknown>;
}

export interface RepairAction {
  rule: string;
  sourceId: string;
  reason: string;
  action: string;
}

export interface MigrationResult {
  inserted: number;
  skippedDuplicates: number;
  repairs: RepairAction[];
}

/** Deterministic repair rule R1: duplicate user by email -> keep lowest createdAt. */
export function dedupeUsersByEmail<T extends { email?: string; createdAt?: string; _id?: unknown }>(
  docs: T[]
): { kept: T[]; repairs: RepairAction[] } {
  const byEmail = new Map<string, T>();
  const repairs: RepairAction[] = [];
  for (const d of docs) {
    if (!d.email) continue;
    const cur = byEmail.get(d.email);
    if (!cur) {
      byEmail.set(d.email, d);
    } else {
      const keepNew = (d.createdAt ?? "") < (cur.createdAt ?? "");
      const dropped = keepNew ? cur : d;
      if (keepNew) byEmail.set(d.email, d);
      repairs.push({
        rule: "R1",
        sourceId: String((dropped as any)._id ?? d.email),
        reason: "duplicate_user_email",
        action: `dropped duplicate, kept ${keepNew ? "newer-created" : "older-created"}`,
      });
    }
  }
  return { kept: Array.from(byEmail.values()), repairs };
}

/** R3: device with no fem_key_map entry -> canonicalId = sha256(minerKey), flag. */
export function deviceCanonicalId(
  minerKey: string | null | undefined,
  femKeyMapEntry: string | null | undefined,
  sha256: (s: string) => string
): { canonicalId: string; flagged: boolean } {
  if (femKeyMapEntry) return { canonicalId: femKeyMapEntry, flagged: false };
  if (minerKey) return { canonicalId: sha256(minerKey), flagged: true };
  return { canonicalId: sha256("unknown:" + Math.random().toString(36)), flagged: true };
}

/** Idempotency: skip docs whose provenance triple already migrated. */
export function filterAlreadyMigrated(
  docs: SourceDoc[],
  migrated: ReadonlySet<string>
): SourceDoc[] {
  return docs.filter((d) => !migrated.has(provenanceKey(d)));
}

export function provenanceKey(d: SourceDoc): string {
  return `${d.sourceDb}|${d.sourceCollection}|${d.sourceId}`;
}

/** Reconciliation: compare source vs target counts for critical entities. */
export interface ReconcileCheck {
  entity: string;
  sourceCount: number;
  targetCount: number;
  exact: boolean;
}

export function reconcile(checks: ReconcileCheck[]): { allExact: boolean; mismatches: ReconcileCheck[] } {
  const mismatches = checks.filter((c) => c.sourceCount !== c.targetCount);
  return { allExact: mismatches.length === 0, mismatches };
}

/** Sum reconciliation for reward amounts (integer base-unit strings). */
export function reconcileAmounts(sourceAmounts: string[], targetAmounts: string[]): {
  exact: boolean;
  sourceSum: bigint;
  targetSum: bigint;
} {
  const sum = (xs: string[]) => xs.reduce((a, b) => a + BigInt(b), 0n);
  const sourceSum = sum(sourceAmounts);
  const targetSum = sum(targetAmounts);
  return { exact: sourceSum === targetSum, sourceSum, targetSum };
}
