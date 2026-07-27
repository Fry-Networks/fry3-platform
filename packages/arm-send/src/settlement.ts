import { createHash } from "node:crypto";
import algosdk from "algosdk";
import {
  PAYMENT_ASSETS,
  type PaymentAsset,
  type SendUnit,
} from "./types.js";
import { assertNoDuplicatePaymentTuples } from "./entitlement-guard.js";

export interface SettlementRow {
  readonly claimId: string;
  readonly address: string;
  readonly asaId: PaymentAsset;
  readonly amountBase: bigint;
  /**
   * Stable identifier of the underlying obligation (e.g. `${minerKey}|${rewardNumbers}|${asaId}`).
   * Only required when two rows would otherwise be indistinguishable on chain — same receiver,
   * same asset, same amount. See entitlement-guard.ts.
   */
  readonly entitlementKey?: string;
  /**
   * ISO timestamp at which the source pre-signed envelope expires. Envelopes in
   * `main.reward_pending_claims` live 5 minutes (`claim.js` writes `Date.now() + 3e5`). Nothing on
   * the settlement path used to consult this, which is how two envelopes that expired on
   * 2026-07-17 were paid on 2026-07-24. Optional for backwards compatibility; when present it is
   * enforced against `generatedAt`.
   */
  readonly envelopeExpiresAt?: string;
}

export interface SettlementExclusion {
  readonly claimId: string;
  readonly resolution: "already-paid-exact" | "duplicate-exact-payment";
  readonly requestedBase: bigint;
  readonly canonicalTxid: string;
  readonly evidenceTxids: readonly string[];
}

export interface SettlementManifest {
  readonly version: 1;
  readonly batchId: string;
  readonly network: "mainnet" | "testnet";
  readonly payer: string;
  readonly generatedAt: string;
  readonly rows: readonly SettlementRow[];
  readonly exclusions: readonly SettlementExclusion[];
  readonly aggregateBase: bigint;
}

const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const TXID = /^[A-Z2-7]{52}$/;
const allowedAssets = new Set<number>(PAYMENT_ASSETS);

function parsePositiveBase(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    throw new Error(`${field}: base unit must be a decimal string`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${field}: base unit must be positive`);
  return parsed;
}

function parseClaimId(value: unknown, field: string): string {
  if (typeof value !== "string" || !CLAIM_ID.test(value))
    throw new Error(`${field}: invalid claimId`);
  return value.toLowerCase();
}

function parseAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !algosdk.isValidAddress(value))
    throw new Error(`${field}: invalid Algorand address`);
  return value;
}

function parseTxid(value: unknown, field: string): string {
  if (typeof value !== "string" || !TXID.test(value))
    throw new Error(`${field}: invalid Algorand txid`);
  return value;
}

function parseRow(value: any, index: number): SettlementRow {
  const asaId = Number(value?.asaId);
  if (!Number.isSafeInteger(asaId) || !allowedAssets.has(asaId))
    throw new Error(`rows[${index}].asaId: unsupported payment ASA`);
  const entitlementKey = value?.entitlementKey;
  if (entitlementKey !== undefined && typeof entitlementKey !== "string")
    throw new Error(`rows[${index}].entitlementKey: must be a string when present`);
  const envelopeExpiresAt = value?.envelopeExpiresAt;
  if (envelopeExpiresAt !== undefined) {
    if (typeof envelopeExpiresAt !== "string")
      throw new Error(`rows[${index}].envelopeExpiresAt: must be an ISO string when present`);
    if (Number.isNaN(Date.parse(envelopeExpiresAt)))
      throw new Error(`rows[${index}].envelopeExpiresAt: unparseable timestamp`);
  }
  return {
    claimId: parseClaimId(value?.claimId, `rows[${index}]`),
    address: parseAddress(value?.address, `rows[${index}]`),
    asaId: asaId as PaymentAsset,
    amountBase: parsePositiveBase(value?.amountBase, `rows[${index}].amountBase`),
    ...(entitlementKey === undefined ? {} : { entitlementKey }),
    ...(envelopeExpiresAt === undefined ? {} : { envelopeExpiresAt }),
  };
}

function parseExclusion(value: any, index: number): SettlementExclusion {
  const resolution = value?.resolution;
  if (
    resolution !== "already-paid-exact" &&
    resolution !== "duplicate-exact-payment"
  )
    throw new Error(`exclusions[${index}]: unsupported resolution`);
  if (!Array.isArray(value?.evidenceTxids))
    throw new Error(`exclusions[${index}]: evidenceTxids must be an array`);
  const evidenceTxids = value.evidenceTxids.map((txid: unknown, txIndex: number) =>
    parseTxid(txid, `exclusions[${index}].evidenceTxids[${txIndex}]`)
  );
  const canonicalTxid = parseTxid(
    value?.canonicalTxid,
    `exclusions[${index}].canonicalTxid`
  );
  if (!evidenceTxids.includes(canonicalTxid))
    throw new Error(`exclusions[${index}]: canonical txid missing from evidence`);
  if (new Set(evidenceTxids).size !== evidenceTxids.length)
    throw new Error(`exclusions[${index}]: duplicate evidence txid`);
  const requiredCount = resolution === "duplicate-exact-payment" ? 2 : 1;
  if (evidenceTxids.length < requiredCount)
    throw new Error(`exclusions[${index}]: insufficient exact payment evidence`);
  return {
    claimId: parseClaimId(value?.claimId, `exclusions[${index}]`),
    resolution,
    requestedBase: parsePositiveBase(
      value?.requestedBase,
      `exclusions[${index}].requestedBase`
    ),
    canonicalTxid,
    evidenceTxids: [...evidenceTxids].sort(),
  };
}

function assertUniqueClaims(
  rows: readonly SettlementRow[],
  exclusions: readonly SettlementExclusion[]
) {
  const payable = new Set<string>();
  for (const row of rows) {
    if (payable.has(row.claimId)) throw new Error(`duplicate payable claim ${row.claimId}`);
    payable.add(row.claimId);
  }
  const excluded = new Set<string>();
  for (const exclusion of exclusions) {
    if (excluded.has(exclusion.claimId))
      throw new Error(`duplicate excluded claim ${exclusion.claimId}`);
    if (payable.has(exclusion.claimId))
      throw new Error(`claim ${exclusion.claimId} listed as both payable and excluded`);
    excluded.add(exclusion.claimId);
  }
}

/**
 * Refuse any row whose source envelope had already expired when the manifest was generated.
 * Boundary fails closed: expiry exactly at `generatedAt` counts as expired.
 */
function assertNoExpiredEnvelopes(rows: readonly SettlementRow[], generatedAt: string) {
  const generated = Date.parse(generatedAt);
  if (Number.isNaN(generated)) return; // generatedAt is validated separately
  for (const row of rows) {
    if (!row.envelopeExpiresAt) continue;
    const expires = Date.parse(row.envelopeExpiresAt);
    if (expires <= generated)
      throw new Error(
        `expired envelope for claim ${row.claimId}: envelope expired at ` +
          `${row.envelopeExpiresAt} but the manifest was generated at ${generatedAt}`
      );
  }
}

export function parseSettlementManifest(raw: string): SettlementManifest {
  const value = JSON.parse(raw);
  if (value?.version !== 1) throw new Error("settlement manifest version must be 1");
  if (typeof value?.batchId !== "string" || !BATCH_ID.test(value.batchId))
    throw new Error("invalid settlement batchId");
  if (value?.network !== "mainnet" && value?.network !== "testnet")
    throw new Error("invalid settlement network");
  if (!Array.isArray(value?.rows) || !Array.isArray(value?.exclusions))
    throw new Error("settlement rows and exclusions must be arrays");
  if (
    typeof value?.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt))
  )
    throw new Error("invalid settlement generatedAt");

  const rows = value.rows.map(parseRow).sort((a: SettlementRow, b: SettlementRow) =>
    a.claimId.localeCompare(b.claimId)
  );
  const exclusions = value.exclusions
    .map(parseExclusion)
    .sort((a: SettlementExclusion, b: SettlementExclusion) =>
      a.claimId.localeCompare(b.claimId)
    );
  assertUniqueClaims(rows, exclusions);
  assertNoExpiredEnvelopes(rows, value.generatedAt);
  // Distinct claimIds are NOT sufficient authority to pay the same wallet the same amount twice
  // in one batch — that is exactly how 103,020,000 base units were paid twice on 2026-07-24.
  assertNoDuplicatePaymentTuples(rows);
  const aggregateBase =
    value.aggregateBase === "0"
      ? 0n
      : parsePositiveBase(value.aggregateBase, "aggregateBase");
  const computed = rows.reduce(
    (total: bigint, row: SettlementRow) => total + row.amountBase,
    0n
  );
  if (computed !== aggregateBase)
    throw new Error(`aggregateBase ${aggregateBase} != computed ${computed}`);

  return {
    version: 1,
    batchId: value.batchId,
    network: value.network,
    payer: parseAddress(value.payer, "payer"),
    generatedAt: value.generatedAt,
    rows,
    exclusions,
    aggregateBase,
  };
}

export function computeSettlementIntentId(
  manifest: Pick<SettlementManifest, "batchId" | "payer">,
  row: SettlementRow
): string {
  const preimage = [
    "fry3-settlement-intent:v1",
    manifest.batchId,
    row.claimId,
    manifest.payer,
    row.address,
    row.asaId.toString(),
    row.amountBase.toString(),
  ].join("\0");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

export function deriveSettlementUnits(manifest: SettlementManifest): SendUnit[] {
  return manifest.rows.map((row) => ({
    deviceId: row.claimId,
    address: row.address,
    asaId: row.asaId,
    amountBase: row.amountBase,
    intentId: computeSettlementIntentId(manifest, row),
    intentDomain: "settlement",
    ...(row.entitlementKey === undefined ? {} : { entitlementKey: row.entitlementKey }),
  }));
}

export function canonicalSettlementManifest(manifest: SettlementManifest): string {
  return JSON.stringify({
    version: manifest.version,
    batchId: manifest.batchId,
    network: manifest.network,
    payer: manifest.payer,
    generatedAt: manifest.generatedAt,
    rows: manifest.rows.map((row) => ({
      claimId: row.claimId,
      address: row.address,
      asaId: row.asaId,
      amountBase: row.amountBase.toString(),
    })),
    exclusions: manifest.exclusions.map((exclusion) => ({
      claimId: exclusion.claimId,
      resolution: exclusion.resolution,
      requestedBase: exclusion.requestedBase.toString(),
      canonicalTxid: exclusion.canonicalTxid,
      evidenceTxids: [...exclusion.evidenceTxids],
    })),
    aggregateBase: manifest.aggregateBase.toString(),
  });
}

export function settlementManifestSha256(raw: string): string {
  const canonical = canonicalSettlementManifest(parseSettlementManifest(raw));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
