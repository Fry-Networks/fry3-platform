import type { LedgerStore } from "./ledger.js";
import { runSendBatch, type SendBatchResult } from "./send.js";
import {
  deriveSettlementUnits,
  parseSettlementManifest,
  settlementManifestSha256,
} from "./settlement.js";
import type {
  SettlementProductionGuard,
  SettlementReservation,
} from "./production-guard.js";
import type { AlgodLike, IndexerLike, Signer } from "./types.js";

import algosdk from "algosdk";
export const REQUIRED_MAINNET_PREDICATES = [
  "exactClaimResolution",
  "manifestFrozen",
  "chainReconciled",
  "nodeIndexerParity",
  "payerAuthAddrVerified",
  "recipientOptInsVerified",
  "assetBalanceVerified",
  "algoHeadroomVerified",
  "singleWriterVerified",
  "dryRunZeroSubmit",
] as const;

export type MainnetPredicate = (typeof REQUIRED_MAINNET_PREDICATES)[number];

export interface MainnetSafetyGate {
  version: 1;
  runId: string;
  batchId: string;
  manifestSha256: string;
  observedAt: string;
  expiresAt: string;
  predicates: Record<MainnetPredicate, boolean>;
  signerAddress: string;
  signature: string;
}

export type UnsignedMainnetSafetyGate = Omit<
  MainnetSafetyGate,
  "signerAddress" | "signature"
>;

export interface SettlementDriverOptions {
  readonly manifestRaw: string;
  readonly expectedManifestSha256: string;
  readonly gate: MainnetSafetyGate;
  readonly network: "mainnet" | "testnet";
  readonly payerAddress: string;
  readonly algod: AlgodLike;
  readonly indexer: IndexerLike;
  readonly signer: Signer;
  readonly store: LedgerStore;
  readonly dryRun: boolean;
  readonly now: string;
  readonly algoHeadroomMicro?: bigint;
  readonly productionGuard?: SettlementProductionGuard;
}

export interface SettlementDriverResult {
  readonly manifestSha256: string;
  readonly batch: SendBatchResult;
}

export const MAINNET_NETWORK = {
  genesisID: "mainnet-v1.0",
  genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
} as const;
export const TESTNET_NETWORK = {
  genesisID: "testnet-v1.0",
  genesisHash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
} as const;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_GATE_LIFETIME_MS = 15 * 60 * 1000;

export class MainnetGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainnetGateError";
  }
}

function gateTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string") throw new MainnetGateError(`${field}: expected ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MainnetGateError(`${field}: invalid ISO timestamp`);
  return parsed;
}

export function canonicalMainnetSafetyGate(
  gate: UnsignedMainnetSafetyGate
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: gate.version,
      runId: gate.runId,
      batchId: gate.batchId,
      manifestSha256: gate.manifestSha256,
      observedAt: gate.observedAt,
      expiresAt: gate.expiresAt,
      predicates: Object.fromEntries(
        REQUIRED_MAINNET_PREDICATES.map((predicate) => [
          predicate,
          gate.predicates[predicate] === true,
        ])
      ),
    })
  );
}

export function signMainnetSafetyGate(
  gate: UnsignedMainnetSafetyGate,
  signerAddress: string,
  secretKey: Uint8Array
): MainnetSafetyGate {
  if (!algosdk.isValidAddress(signerAddress))
    throw new MainnetGateError("invalid mainnet safety gate signer address");
  const signature = algosdk.signBytes(canonicalMainnetSafetyGate(gate), secretKey);
  const signed = {
    ...gate,
    predicates: { ...gate.predicates },
    signerAddress,
    signature: Buffer.from(signature).toString("base64"),
  };
  verifyMainnetSafetyGate(signed, signerAddress);
  return signed;
}

export function verifyMainnetSafetyGate(
  gate: MainnetSafetyGate,
  expectedSignerAddress: string
): void {
  if (gate.signerAddress !== expectedSignerAddress)
    throw new MainnetGateError("mainnet safety gate signer does not match active signer");
  if (!algosdk.isValidAddress(gate.signerAddress))
    throw new MainnetGateError("invalid mainnet safety gate signer address");
  let signature: Uint8Array;
  try {
    const decoded = Buffer.from(gate.signature, "base64");
    if (decoded.length !== 64 || decoded.toString("base64") !== gate.signature)
      throw new Error("invalid length");
    signature = new Uint8Array(decoded);
  } catch {
    throw new MainnetGateError("invalid mainnet safety gate signature encoding");
  }
  const unsigned: UnsignedMainnetSafetyGate = {
    version: gate.version,
    runId: gate.runId,
    batchId: gate.batchId,
    manifestSha256: gate.manifestSha256,
    observedAt: gate.observedAt,
    expiresAt: gate.expiresAt,
    predicates: gate.predicates,
  };
  if (
    !algosdk.verifyBytes(
      canonicalMainnetSafetyGate(unsigned),
      signature,
      gate.signerAddress
    )
  )
    throw new MainnetGateError("invalid mainnet safety gate signature");
}

export function parseMainnetSafetyGate(raw: string): MainnetSafetyGate {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MainnetGateError("invalid mainnet safety gate JSON");
  }
  if (value?.version !== 1) throw new MainnetGateError("mainnet safety gate version must be 1");
  if (typeof value?.runId !== "string" || !SAFE_ID.test(value.runId))
    throw new MainnetGateError("invalid mainnet safety gate runId");
  if (typeof value?.batchId !== "string" || !SAFE_ID.test(value.batchId))
    throw new MainnetGateError("invalid mainnet safety gate batchId");
  if (typeof value?.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256))
    throw new MainnetGateError("invalid mainnet safety gate manifest hash");
  gateTimestamp(value?.observedAt, "safety gate observedAt");
  gateTimestamp(value?.expiresAt, "safety gate expiresAt");
  if (value?.predicates === null || typeof value?.predicates !== "object")
    throw new MainnetGateError("mainnet safety gate predicates must be an object");
  if (typeof value?.signerAddress !== "string")
    throw new MainnetGateError("mainnet safety gate signer address missing");
  if (typeof value?.signature !== "string")
    throw new MainnetGateError("mainnet safety gate signature missing");
  const predicates = Object.fromEntries(
    REQUIRED_MAINNET_PREDICATES.map((predicate) => [
      predicate,
      value.predicates[predicate] === true,
    ])
  ) as Record<MainnetPredicate, boolean>;
  return {
    version: 1,
    runId: value.runId,
    batchId: value.batchId,
    manifestSha256: value.manifestSha256,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    predicates,
    signerAddress: value.signerAddress,
    signature: value.signature,
  };
}

function assertPreflight(
  options: SettlementDriverOptions,
  manifest: ReturnType<typeof parseSettlementManifest>,
  manifestSha256: string
) {
  verifyMainnetSafetyGate(options.gate, options.signer.address);
  if (!SHA256.test(options.expectedManifestSha256))
    throw new MainnetGateError("invalid expected settlement manifest hash");
  if (
    manifestSha256 !== options.expectedManifestSha256 ||
    manifestSha256 !== options.gate.manifestSha256
  )
    throw new MainnetGateError("settlement manifest hash mismatch");
  if (manifest.network !== options.network)
    throw new MainnetGateError("settlement network does not match manifest");
  if (manifest.payer !== options.payerAddress)
    throw new MainnetGateError("settlement payer does not match manifest");
  if (options.gate.batchId !== manifest.batchId)
    throw new MainnetGateError("settlement safety gate batch does not match manifest");
  if (options.algod.pendingTupleMode !== "full")
    throw new MainnetGateError("settlement driver requires full pending payment tuples");

  const observedAt = gateTimestamp(options.gate.observedAt, "safety gate observedAt");
  const expiresAt = gateTimestamp(options.gate.expiresAt, "safety gate expiresAt");
  const now = gateTimestamp(options.now, "driver now");
  if (expiresAt <= observedAt)
    throw new MainnetGateError("settlement safety gate expiration must follow observation");
  if (expiresAt - observedAt > MAX_GATE_LIFETIME_MS)
    throw new MainnetGateError("settlement safety gate lifetime exceeds 15 minutes");
  if (observedAt > now) throw new MainnetGateError("settlement safety gate is future-dated");
  if (expiresAt <= now) throw new MainnetGateError("settlement safety gate expired");
  if (options.network === "mainnet" && !options.dryRun && !options.productionGuard)
    throw new MainnetGateError(
      "mainnet settlement execution requires a runtime production guard"
    );
  for (const predicate of REQUIRED_MAINNET_PREDICATES) {
    if (options.gate.predicates[predicate] !== true)
      throw new MainnetGateError(`settlement safety predicate not proven: ${predicate}`);
  }
}

export async function runSettlementDriver(
  options: SettlementDriverOptions
): Promise<SettlementDriverResult> {
  const manifest = parseSettlementManifest(options.manifestRaw);
  const manifestSha256 = settlementManifestSha256(options.manifestRaw);
  assertPreflight(options, manifest, manifestSha256);
  const expectedNetwork =
    options.network === "mainnet" ? MAINNET_NETWORK : TESTNET_NETWORK;
  const suggestedParams = await options.algod.suggestedParams();
  if (
    suggestedParams.genesisID !== expectedNetwork.genesisID ||
    suggestedParams.genesisHash !== expectedNetwork.genesisHash
  )
    throw new MainnetGateError(
      "algod genesis identity does not match settlement network"
    );

  const send = () =>
    runSendBatch({
      units: deriveSettlementUnits(manifest),
      hotWallet: manifest.payer,
      store: options.store,
      algod: options.algod,
      indexer: options.indexer,
      signer: options.signer,
      dryRun: options.dryRun,
      now: options.now,
      algoHeadroomMicro: options.algoHeadroomMicro,
      scope: { kind: "settlement", batchId: manifest.batchId },
      expectedNetwork,
    });

  let batch: SendBatchResult;
  if (options.network === "mainnet" && !options.dryRun) {
    const reservation: SettlementReservation = {
      batchId: manifest.batchId,
      manifestSha256,
      claimIds: manifest.rows.map((row) => row.claimId),
    };
    batch = await options.productionGuard!.runExclusive(reservation, send);
  } else {
    batch = await send();
  }
  return { manifestSha256, batch };
}
