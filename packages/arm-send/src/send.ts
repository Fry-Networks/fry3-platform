/**
 * R14.5 — crash-safe, ON-CHAIN-EXACT idempotent send batch orchestrator.
 *
 * Sequence per plans/fry3-p9-arm-hardening.md §E:
 *   establish tip/liveness (BLOCKER on stale)  → rekey-aware auth-addr check (BLOCKER on
 *   mismatch)  → re-assert live balance ≥ REMAINING manifest  → per (device,ASA) unit:
 *   fold-ledger + indexer reconcile → decide (SKIP / RESEND / SEND) → opt-in check →
 *   write intent BEFORE submit → submit (or dry-run: build+sign, NO submit) → backfill txid.
 *
 * A committed send is FINAL. Retries route ONLY through the idempotency check (never an
 * inline resubmit of an already-broadcast txn). dryRun=true builds+signs but NEVER submits
 * — this is the build-session validation mode (no mainnet value moves).
 */
import type {
  AlgodLike,
  IndexerLike,
  SendOutcome,
  SendUnit,
  Signer,
  SendFailureClass,
  BatchScope,
  LedgerRecord,
  NetworkIdentity,
} from "./types.js";
import { loadFold, type LedgerStore } from "./ledger.js";
import { establishTip, reconcileUnit, type TipState } from "./reconcile.js";
import { decideSend } from "./decide.js";
import { buildAssetTransfer } from "./build.js";
import { PAYMENT_ASSETS, VALIDITY_WINDOW_ROUNDS } from "./types.js";
import { ArmSanityFailed } from "./manifest.js";
import { assertNoDuplicatePaymentTuples } from "./entitlement-guard.js";

export class ArmSigningAuthaddrMismatch extends Error {
  constructor(msg: string) {
    super(`arm-signing-authaddr-mismatch: ${msg}`);
    this.name = "ArmSigningAuthaddrMismatch";
  }
}

export class ArmNetworkIdentityMismatch extends Error {
  constructor(msg: string) {
    super(`arm-network-identity-mismatch: ${msg}`);
    this.name = "ArmNetworkIdentityMismatch";
  }
}

function assertSuggestedNetwork(
  params: Awaited<ReturnType<AlgodLike["suggestedParams"]>>,
  expectedNetwork: NetworkIdentity
): void {
  if (
    params.genesisID !== expectedNetwork.genesisID ||
    params.genesisHash !== expectedNetwork.genesisHash
  )
    throw new ArmNetworkIdentityMismatch(
      `algod genesis ${params.genesisID}/${params.genesisHash} != expected ${expectedNetwork.genesisID}/${expectedNetwork.genesisHash}`
    );
}

function assertScopedParams(
  params: Awaited<ReturnType<AlgodLike["suggestedParams"]>>,
  expectedNetwork: NetworkIdentity
): void {
  assertSuggestedNetwork(params, expectedNetwork);
  if (
    !Number.isSafeInteger(params.firstRound) ||
    !Number.isSafeInteger(params.lastRound) ||
    params.firstRound <= 0 ||
    params.lastRound - params.firstRound < VALIDITY_WINDOW_ROUNDS
  )
    throw new ArmSanityFailed(
      `suggested validity window ${params.firstRound}-${params.lastRound} is shorter than ${VALIDITY_WINDOW_ROUNDS} rounds`
    );
}

function actualFlatFee(
  params: Awaited<ReturnType<AlgodLike["suggestedParams"]>>
): bigint {
  // Live algod often returns fee=0 with min-fee as the network floor.
  const minFee = params.minFee ?? 0;
  if (
    !Number.isSafeInteger(params.fee) ||
    params.fee < 0 ||
    !Number.isSafeInteger(minFee) ||
    minFee < 0
  )
    throw new ArmSanityFailed("suggested transaction fee is not a safe non-negative integer");
  const flat = Math.max(params.fee, minFee);
  if (!Number.isSafeInteger(flat) || flat <= 0)
    throw new ArmSanityFailed("suggested transaction fee is not a safe positive integer");
  return BigInt(flat);
}

export interface SendBatchOpts {
  units: SendUnit[];
  hotWallet: string;
  store: LedgerStore;
  algod: AlgodLike;
  indexer: IndexerLike;
  signer: Signer;
  /** true = build+sign only, NO submit (build-session / dry-run validation). */
  dryRun: boolean;
  /** ISO timestamp for ledger records (callers stamp; keeps this deterministic). */
  now: string;
  /** ALGO fee headroom (microAlgos) above minFee×sendCount. */
  algoHeadroomMicro?: bigint;
  /** Explicit scope preserves the real canonical epoch or remediation batch identity. */
  scope?: BatchScope;
  /** Exact chain identity required and revalidated for every scoped send. */
  expectedNetwork?: NetworkIdentity;
}

export interface SendBatchResult {
  tip: TipState;
  outcomes: Array<{ unit: SendUnit; outcome: SendOutcome }>;
  failedSet: Array<{ deviceId: string; address: string; asaId: number; reason: SendFailureClass; detail: string }>;
  remainingAsserted: { asaId: number; remaining: bigint; balance: bigint }[];
}

function classify(err: unknown): { reason: SendFailureClass; detail: string } {
  const m = String((err as any)?.message ?? err);
  const lo = m.toLowerCase();
  if (lo.includes("overspend") || lo.includes("underflow") || lo.includes("insufficient"))
    return { reason: "insufficient-funds", detail: m.slice(0, 300) };
  if (lo.includes("econnrefused") || lo.includes("timeout") || lo.includes("network") || lo.includes("fetch"))
    return { reason: "network", detail: m.slice(0, 300) };
  return { reason: "other", detail: m.slice(0, 300) };
}

export async function runSendBatch(opts: SendBatchOpts): Promise<SendBatchResult> {
  const {
    units,
    hotWallet,
    store,
    algod,
    indexer,
    signer,
    dryRun,
    now,
    scope,
    expectedNetwork,
  } = opts;
  const allowedAssets = new Set<number>(PAYMENT_ASSETS);
  const seenIntents = new Set<string>();
  for (const unit of units) {
    if (!allowedAssets.has(unit.asaId))
      throw new ArmSanityFailed(`unsupported payment ASA ${unit.asaId}`);
    if (seenIntents.has(unit.intentId))
      throw new ArmSanityFailed(`duplicate intent ${unit.intentId}`);
    seenIntents.add(unit.intentId);
  }
  // Defence in depth for any caller, not just manifest-derived batches: intentId uniqueness does
  // NOT imply obligation uniqueness, because intentId embeds the claim id.
  try {
    assertNoDuplicatePaymentTuples(units);
  } catch (error) {
    throw new ArmSanityFailed((error as Error).message);
  }

  let recordScope: Pick<LedgerRecord, "armEpoch" | "batchId" | "intentDomain"> = {
    armEpoch: 0,
  };
  if (scope?.kind === "arm") {
    if (!Number.isInteger(scope.epoch) || scope.epoch <= 0)
      throw new ArmSanityFailed(`bad arm epoch ${scope.epoch}`);
    recordScope = { armEpoch: scope.epoch, intentDomain: "arm" };
  } else if (scope?.kind === "settlement") {
    if (!scope.batchId.trim()) throw new ArmSanityFailed("empty settlement batchId");
    recordScope = {
      armEpoch: 0,
      batchId: scope.batchId,
      intentDomain: "settlement",
    };
  }

  const isScopedProduction = scope !== undefined;
  if (isScopedProduction && !expectedNetwork)
    throw new ArmSanityFailed("scoped send requires an expected network identity");
  if (isScopedProduction && !indexer.networkIdentity)
    throw new ArmSanityFailed("scoped send requires indexer network identity proof");
  if (isScopedProduction && algod.pendingTupleMode !== "full")
    throw new ArmSanityFailed("scoped send requires full pending payment tuples");
  if (isScopedProduction && !dryRun && !algod.waitForConfirmation)
    throw new ArmSanityFailed("scoped send requires bounded transaction confirmation");

  const tip = await establishTip(algod, indexer, expectedNetwork);
  const acct = await algod.accountInfo(hotWallet);
  const expectedSigner = acct.authAddr ?? hotWallet;
  if (signer.address !== expectedSigner)
    throw new ArmSigningAuthaddrMismatch(
      `payer ${hotWallet} live auth-addr ${expectedSigner} != signing key ${signer.address}`
    );

  const fold = await loadFold(store);
  const reconciled = new Map<string, Awaited<ReturnType<typeof reconcileUnit>>>();
  for (const unit of units) {
    const folded = fold.get(unit.intentId);
    if (folded?.txid && !isScopedProduction) continue;
    const reconciliation = await reconcileUnit(
      unit,
      hotWallet,
      algod,
      indexer,
      expectedNetwork
    );
    if (
      isScopedProduction &&
      folded?.txid &&
      (!reconciliation.committed || reconciliation.txid !== folded.txid)
    )
      throw new ArmSanityFailed(
        `ledger confirmation ${folded.txid} absent from caught-up chain for ${unit.intentId}`
      );
    reconciled.set(unit.intentId, reconciliation);
  }

  const remainingByAsa = new Map<number, bigint>();
  let remainingSendCount = 0;
  for (const unit of units) {
    const folded = fold.get(unit.intentId);
    if (folded?.txid) continue;
    const decision = decideSend(folded, reconciled.get(unit.intentId)!);
    if (decision.kind !== "SEND_FRESH" && decision.kind !== "RESEND_SAME") continue;
    remainingByAsa.set(
      unit.asaId,
      (remainingByAsa.get(unit.asaId) ?? 0n) + unit.amountBase
    );
    remainingSendCount += 1;
  }

  const remainingAsserted: SendBatchResult["remainingAsserted"] = [];
  for (const asaId of [...remainingByAsa.keys()].sort((a, b) => a - b)) {
    const remaining = remainingByAsa.get(asaId) ?? 0n;
    const holding = await algod.assetHolding(hotWallet, asaId);
    const balance = holding?.amount ?? 0n;
    remainingAsserted.push({ asaId, remaining, balance });
    if (balance < remaining)
      throw new ArmSanityFailed(
        `hot-wallet ${asaId} balance ${balance} < REMAINING manifest ${remaining}`
      );
  }

  const sp0 = await algod.suggestedParams();
  if (expectedNetwork) assertScopedParams(sp0, expectedNetwork);
  const budgetedFlatFee = actualFlatFee(sp0);
  const headroom = opts.algoHeadroomMicro ?? 0n;
  const feeBudget = budgetedFlatFee * BigInt(remainingSendCount) + headroom;
  const minBalance = acct.minBalance ?? 0n;
  const availableAlgo = acct.amount > minBalance ? acct.amount - minBalance : 0n;
  if (remainingSendCount > 0 && availableAlgo < feeBudget)
    throw new ArmSanityFailed(
      `hot-wallet available ALGO ${availableAlgo} < fee budget ${feeBudget} (amount ${acct.amount} - minBalance ${minBalance}; flatFee ${budgetedFlatFee} × ${remainingSendCount} + headroom ${headroom})`
    );

  const outcomes: SendBatchResult["outcomes"] = [];
  const failedSet: SendBatchResult["failedSet"] = [];

  for (const unit of units) {
    try {
      const folded = fold.get(unit.intentId);
      if (folded?.txid) {
        outcomes.push({
          unit,
          outcome: { status: "skipped", txid: folded.txid, reason: "txid-present" },
        });
        continue;
      }

      const rec = reconciled.get(unit.intentId)!;
      const decision = decideSend(folded, rec);
      if (decision.kind === "SKIP_COMMITTED_BACKFILL") {
        await store.append({
          intentId: unit.intentId,
          deviceId: unit.deviceId,
          address: unit.address,
          asaId: unit.asaId,
          amountBase: unit.amountBase.toString(),
          ...recordScope,
          phase: "confirm",
          txid: decision.txid,
          ts: now,
        });
        outcomes.push({
          unit,
          outcome: {
            status: "skipped",
            txid: decision.txid,
            reason: "already-committed",
          },
        });
        continue;
      }
      if (decision.kind === "SKIP_PENDING") {
        outcomes.push({
          unit,
          outcome: { status: "skipped", txid: rec.txid, reason: "pending-pool" },
        });
        continue;
      }

      const recvHolding = await algod.assetHolding(unit.address, unit.asaId);
      if (recvHolding === null) {
        const detail = `recipient ${unit.address} not opted in to ${unit.asaId}`;
        failedSet.push({
          deviceId: unit.deviceId,
          address: unit.address,
          asaId: unit.asaId,
          reason: "recipient-not-opted-in",
          detail,
        });
        outcomes.push({
          unit,
          outcome: { status: "failed", reason: "recipient-not-opted-in", detail },
        });
        continue;
      }

      const sp = await algod.suggestedParams();
      if (expectedNetwork) assertScopedParams(sp, expectedNetwork);
      const unitFee = actualFlatFee(sp);
      if (unitFee > budgetedFlatFee)
        throw new ArmSanityFailed(
          `suggested flat fee increased from ${budgetedFlatFee} to ${unitFee}; rerun balance gate`
        );
      const built = buildAssetTransfer(unit, hotWallet, {
        ...sp,
        fee: Number(unitFee),
      });
      await store.append({
        intentId: unit.intentId,
        deviceId: unit.deviceId,
        address: unit.address,
        asaId: unit.asaId,
        amountBase: unit.amountBase.toString(),
        ...recordScope,
        phase: "intent",
        ts: now,
      });

      const signed = signer.sign(built.txn);
      if (dryRun) {
        outcomes.push({ unit, outcome: { status: "dry-run", txid: built.txid } });
        continue;
      }

      const txid = await algod.submit(signed);
      if (isScopedProduction && txid !== built.txid)
        throw new Error(
          `algod submit txid ${txid} != signed transaction ${built.txid}`
        );
      if (isScopedProduction)
        await algod.waitForConfirmation!(txid, 4);
      await store.append({
        intentId: unit.intentId,
        deviceId: unit.deviceId,
        address: unit.address,
        asaId: unit.asaId,
        amountBase: unit.amountBase.toString(),
        ...recordScope,
        phase: "confirm",
        txid,
        ts: now,
      });
      outcomes.push({ unit, outcome: { status: "paid", txid } });
    } catch (err) {
      if (
        err instanceof ArmNetworkIdentityMismatch ||
        err instanceof ArmSanityFailed
      )
        throw err;
      const { reason, detail } = classify(err);
      failedSet.push({
        deviceId: unit.deviceId,
        address: unit.address,
        asaId: unit.asaId,
        reason,
        detail,
      });
      outcomes.push({ unit, outcome: { status: "failed", reason, detail } });
    }
  }

  return { tip, outcomes, failedSet, remainingAsserted };
}
