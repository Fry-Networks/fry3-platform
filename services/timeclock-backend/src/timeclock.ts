/**
 * Fry timeclock backend — clock in/out, idempotent entries, no lost records.
 * Server time authoritative. Pure logic (persistence injected).
 */

export interface TimeclockEntry {
  id: string;
  workerId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  source?: string;
}

export interface ClockEvent {
  workerId: string;
  at: Date; // server time
  source?: string;
  idempotencyKey: string;
}

/** Can a worker clock in? (must not have an open entry) */
export function canClockIn(openEntry: TimeclockEntry | null): { ok: boolean; reason?: string } {
  if (openEntry && !openEntry.clockOutAt) return { ok: false, reason: "already_clocked_in" };
  return { ok: true };
}

/** Can a worker clock out? (must have an open entry) */
export function canClockOut(openEntry: TimeclockEntry | null): { ok: boolean; reason?: string } {
  if (!openEntry || openEntry.clockOutAt) return { ok: false, reason: "not_clocked_in" };
  return { ok: true };
}

/** Validate clock-out is after clock-in (no negative duration). */
export function validClockOut(entry: TimeclockEntry, outAt: Date): boolean {
  return outAt.getTime() > entry.clockInAt.getTime();
}

/** Duration in whole seconds (integer; never float). */
export function durationSeconds(entry: TimeclockEntry): number {
  if (!entry.clockOutAt) return 0;
  return Math.floor((entry.clockOutAt.getTime() - entry.clockInAt.getTime()) / 1000);
}

/** Idempotency: dedupe clock events by idempotency key (no lost, no duplicate). */
export function dedupeClockEvents(events: ClockEvent[]): ClockEvent[] {
  const seen = new Set<string>();
  const out: ClockEvent[] = [];
  for (const e of events) {
    if (seen.has(e.idempotencyKey)) continue;
    seen.add(e.idempotencyKey);
    out.push(e);
  }
  return out;
}

/** Reconcile two entry sets (source vs target) — detect missing/duplicate by id. */
export function reconcileEntries(
  source: TimeclockEntry[],
  target: TimeclockEntry[]
): { missingInTarget: string[]; duplicatesInTarget: string[] } {
  const targetIds = new Map<string, number>();
  for (const t of target) targetIds.set(t.id, (targetIds.get(t.id) ?? 0) + 1);
  const missingInTarget = source.filter((s) => !targetIds.has(s.id)).map((s) => s.id);
  const duplicatesInTarget = Array.from(targetIds.entries()).filter(([, n]) => n > 1).map(([id]) => id);
  return { missingInTarget, duplicatesInTarget };
}
