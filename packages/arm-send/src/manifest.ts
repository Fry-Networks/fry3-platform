/**
 * R14.2 — payout manifest parse + sanity gate + send-unit derivation.
 *
 * The manifest (arm-manifest-<epoch>.json) is FROZEN: minted once, reused verbatim on
 * every resume. This module parses it with base-units as bigint (never float), asserts
 * the R14.2 sanity/base-unit gates, and derives the per-(device,ASA) send units with
 * frozen intent-ids. A breach throws the named BLOCKER — never arm past it.
 */
import { FRY3_ASA, FNODE_ASA, type ArmManifest, type ManifestRow, type SendUnit } from "./types.js";
import { computeIntentId } from "./intent.js";

export class ArmSanityFailed extends Error {
  constructor(msg: string) {
    super(`arm-sanity-failed: ${msg}`);
    this.name = "ArmSanityFailed";
  }
}
export class ArmAmountUnitsFailed extends Error {
  constructor(msg: string) {
    super(`arm-amount-units-failed: ${msg}`);
    this.name = "ArmAmountUnitsFailed";
  }
}

/** A per-device entitlement ceiling (from the reconciled ledger) for the derived-sanity band. */
export interface Entitlement {
  fry3Base: bigint;
  fnodeBase: bigint;
}

/** Parse a JSON string amount as base-unit bigint; reject float / non-integer / negative. */
export function parseBaseUnit(v: unknown, ctx: string): bigint {
  if (typeof v === "bigint") {
    if (v < 0n) throw new ArmAmountUnitsFailed(`${ctx}: negative ${v}`);
    return v;
  }
  if (typeof v === "number") {
    // A number amount is a base-unit assertion breach: JSON numbers cannot safely carry
    // large integer base units and may hide a 10^decimals scaling error.
    throw new ArmAmountUnitsFailed(`${ctx}: amount is a JSON number (${v}); require integer string base units`);
  }
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw new ArmAmountUnitsFailed(`${ctx}: not an integer base-unit string: ${JSON.stringify(v)}`);
  }
  return BigInt(v);
}

/** Parse the frozen manifest JSON. */
export function parseManifest(raw: string): ArmManifest {
  const j = JSON.parse(raw);
  if (!Number.isInteger(j.epoch) || j.epoch <= 0) throw new ArmSanityFailed(`bad epoch ${j.epoch}`);
  if (!Array.isArray(j.rows)) throw new ArmSanityFailed("rows not an array");
  const seen = new Set<string>();
  const rows: ManifestRow[] = j.rows.map((r: any, i: number) => {
    if (typeof r.address !== "string" || r.address.length !== 58)
      throw new ArmSanityFailed(`row ${i}: bad address`);
    if (typeof r.deviceId !== "string" || !r.deviceId)
      throw new ArmSanityFailed(`row ${i}: bad deviceId`);
    const key = `${r.deviceId}`;
    if (seen.has(key)) throw new ArmSanityFailed(`row ${i}: duplicate deviceId ${key}`);
    seen.add(key);
    return {
      deviceId: r.deviceId,
      address: r.address,
      fry3Base: parseBaseUnit(r.fry3Base, `row ${i} fry3Base`),
      fnodeBase: parseBaseUnit(r.fnodeBase, `row ${i} fnodeBase`),
    };
  });
  const agg = j.aggregates ?? {};
  const owed = j.owed ?? {};
  return {
    epoch: j.epoch,
    generatedAt: String(j.generatedAt ?? ""),
    rows,
    aggregates: {
      fry3Total: parseBaseUnit(agg.fry3Total, "aggregates.fry3Total"),
      fnodeTotal: parseBaseUnit(agg.fnodeTotal, "aggregates.fnodeTotal"),
      deviceCount: Number(agg.deviceCount),
    },
    owed: {
      fry3Total: parseBaseUnit(owed.fry3Total, "owed.fry3Total"),
      fnodeTotal: parseBaseUnit(owed.fnodeTotal, "owed.fnodeTotal"),
    },
  };
}

/**
 * R14.2 sanity gate. Throws ArmSanityFailed / ArmAmountUnitsFailed on any breach.
 * `entitlements` maps deviceId → its accrued+recovered entitlement (the derived-sanity band).
 * `absurdCeiling` guards against absurd magnitudes (per-ASA, base units).
 */
export function assertSanity(
  m: ArmManifest,
  entitlements: Map<string, Entitlement>,
  absurdCeiling: { fry3: bigint; fnode: bigint }
): void {
  // aggregates must equal the row sums (manifest self-consistency).
  let sf = 0n;
  let sn = 0n;
  for (const r of m.rows) {
    sf += r.fry3Base;
    sn += r.fnodeBase;
  }
  if (sf !== m.aggregates.fry3Total)
    throw new ArmSanityFailed(`fry3 agg ${m.aggregates.fry3Total} != row sum ${sf}`);
  if (sn !== m.aggregates.fnodeTotal)
    throw new ArmSanityFailed(`fnode agg ${m.aggregates.fnodeTotal} != row sum ${sn}`);
  if (m.aggregates.deviceCount !== m.rows.length)
    throw new ArmSanityFailed(`deviceCount ${m.aggregates.deviceCount} != rows ${m.rows.length}`);

  // R14.2.1 can't-exceed-owed.
  if (m.aggregates.fry3Total > m.owed.fry3Total)
    throw new ArmSanityFailed(`fry3 aggregate ${m.aggregates.fry3Total} exceeds owed ${m.owed.fry3Total}`);
  if (m.aggregates.fnodeTotal > m.owed.fnodeTotal)
    throw new ArmSanityFailed(`fnode aggregate ${m.aggregates.fnodeTotal} exceeds owed ${m.owed.fnodeTotal}`);

  // R14.2.2 per-device derived-sanity band + no negatives + no absurd magnitudes.
  for (const r of m.rows) {
    if (r.fry3Base < 0n || r.fnodeBase < 0n)
      throw new ArmSanityFailed(`row ${r.deviceId}: negative amount`);
    if (r.fry3Base > absurdCeiling.fry3)
      throw new ArmSanityFailed(`row ${r.deviceId}: fry3 ${r.fry3Base} exceeds absurd ceiling ${absurdCeiling.fry3}`);
    if (r.fnodeBase > absurdCeiling.fnode)
      throw new ArmSanityFailed(`row ${r.deviceId}: fnode ${r.fnodeBase} exceeds absurd ceiling ${absurdCeiling.fnode}`);
    const ent = entitlements.get(r.deviceId);
    if (!ent) throw new ArmSanityFailed(`row ${r.deviceId}: no entitlement (device not in reconciled ledger)`);
    if (r.fry3Base > ent.fry3Base)
      throw new ArmSanityFailed(`row ${r.deviceId}: fry3 ${r.fry3Base} exceeds entitlement ${ent.fry3Base}`);
    if (r.fnodeBase > ent.fnodeBase)
      throw new ArmSanityFailed(`row ${r.deviceId}: fnode ${r.fnodeBase} exceeds entitlement ${ent.fnodeBase}`);
  }
}

/**
 * Derive the per-(device,ASA) send units with FROZEN intent-ids. Zero-amount legs are
 * skipped (nothing to send). Each nonzero leg is one independent per-ASA txn (R14.5.6).
 */
export function deriveSendUnits(m: ArmManifest): SendUnit[] {
  const units: SendUnit[] = [];
  for (const r of m.rows) {
    if (r.fry3Base > 0n) {
      units.push({
        deviceId: r.deviceId,
        address: r.address,
        asaId: FRY3_ASA,
        amountBase: r.fry3Base,
        intentId: computeIntentId(r.deviceId, FRY3_ASA, r.fry3Base, m.epoch),
      });
    }
    if (r.fnodeBase > 0n) {
      units.push({
        deviceId: r.deviceId,
        address: r.address,
        asaId: FNODE_ASA,
        amountBase: r.fnodeBase,
        intentId: computeIntentId(r.deviceId, FNODE_ASA, r.fnodeBase, m.epoch),
      });
    }
  }
  return units;
}

/** Per-ASA send count (nonzero legs) → drives the ALGO fee-budget assertion (R14.2.3). */
export function perAsaSendCount(units: SendUnit[]): Map<number, number> {
  const c = new Map<number, number>();
  for (const u of units) c.set(u.asaId, (c.get(u.asaId) ?? 0) + 1);
  return c;
}
