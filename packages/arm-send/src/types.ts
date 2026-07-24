/**
 * FRY3 R14.5 arm-send — shared types.
 *
 * Money-arm send batch is IRREVERSIBLE and the host loop can crash mid-batch and
 * resurrect (or hand off across host succession). Every type here exists to make the
 * batch crash-safe + ON-CHAIN-EXACT idempotent per plans/fry3-p9-arm-hardening.md §E.
 *
 * Base-unit amounts are ALWAYS bigint (the exact integer an AssetTransferTxn consumes).
 * Never float. Never Number for amounts.
 */

/** The two arm assets. Independent per-ASA single txns (NOT an atomic group). */
export const FRY3_ASA = 3612979527;
export const FNODE_ASA = 2485202024;
export const TFRY_ASA = 2681521901;
export const ARM_ASSETS = [FRY3_ASA, FNODE_ASA] as const;
export const PAYMENT_ASSETS = [...ARM_ASSETS, TFRY_ASA] as const;
export type ArmAsset = (typeof ARM_ASSETS)[number];
export type PaymentAsset = (typeof PAYMENT_ASSETS)[number];

export type BatchScope =
  | { kind: "arm"; epoch: number }
  | { kind: "settlement"; batchId: string };

/** Lease/note windowing. ~1000-round validity window per §E.2. */
export const VALIDITY_WINDOW_ROUNDS = 1000;
/** Stable note schema — the searchable idempotency key on-chain. */
export const NOTE_PREFIX = "fry3-arm:v1:";
export const SETTLEMENT_NOTE_PREFIX = "fry3-settlement:v1:";

/** One reconciled-ledger payout row (from arm-manifest-<epoch>.json). */
export interface ManifestRow {
  deviceId: string;
  address: string; // recipient Algorand address (58 chars)
  fry3Base: bigint; // FRY3 owed, base units
  fnodeBase: bigint; // fNODE owed, base units
}

/** The FROZEN arm manifest. epoch minted ONCE; reused verbatim on every resume. */
export interface ArmManifest {
  epoch: number; // frozen arm-epoch; == <epoch> in the file name
  generatedAt: string; // ISO stamp (informational; NOT part of intent-id)
  rows: ManifestRow[];
  aggregates: {
    fry3Total: bigint; // sum of rows[].fry3Base
    fnodeTotal: bigint; // sum of rows[].fnodeBase
    deviceCount: number;
  };
  /** Total owed across the whole reconciled ledger (the can't-exceed-owed ceiling, R14.2.1). */
  owed: { fry3Total: bigint; fnodeTotal: bigint };
}

/** A single (device, ASA) send unit derived from a manifest row. */
export interface SendUnit {
  deviceId: string;
  address: string;
  asaId: PaymentAsset;
  amountBase: bigint;
  intentId: string;
  intentDomain?: "arm" | "settlement";
}

/** Append-only send-ledger record (arm-sends-<epoch>.jsonl). */
export interface LedgerRecord {
  intentId: string;
  deviceId: string;
  address: string;
  asaId: number;
  amountBase: string; // bigint serialized as decimal string
  armEpoch: number;
  batchId?: string;
  intentDomain?: "arm" | "settlement";
  /** "intent" = written atomically BEFORE submit; "confirm" = txid backfilled on confirm. */
  phase: "intent" | "confirm";
  txid?: string; // present only on a "confirm" record
  ts: string; // ISO stamp injected by caller (scripts stamp; workflows are deterministic)
}

/** Folded state per intent-id from replaying the append-only ledger. */
export interface FoldedIntent {
  intentWritten: boolean;
  txid: string | null;
}

/** Result of indexer-authoritative across-window reconciliation for one intent. */
export interface ReconcileResult {
  /** committed on chain (full-tuple match) */
  committed: boolean;
  /** in the algod pending pool (broadcast, not yet committed) */
  pending: boolean;
  txid: string | null;
}

/** The resume/idempotency decision for one send unit. */
export type SendDecision =
  | { kind: "SKIP_TXID_PRESENT"; txid: string }
  | { kind: "SKIP_COMMITTED_BACKFILL"; txid: string }
  | { kind: "SKIP_PENDING" }
  | { kind: "RESEND_SAME" } // intent written, not committed, not pending → resend same id/note/lease/amount
  | { kind: "SEND_FRESH" }; // no ledger entry, not on chain → first send

/** Per-send terminal outcome (recorded, surfaced in the report). */
export type SendOutcome =
  | { status: "paid"; txid: string }
  | { status: "skipped"; txid: string | null; reason: string }
  | { status: "dry-run"; txid: string } // built+signed, NOT submitted (this build session)
  | { status: "failed"; reason: SendFailureClass; detail: string };

export type SendFailureClass =
  | "recipient-not-opted-in"
  | "insufficient-funds"
  | "network"
  | "other";

/** Minimal algod surface this harness needs (real adapter wraps algosdk.Algodv2). */
export interface PendingTransfer {
  txid: string;
  note: string | null;
  sender?: string;
  receiver?: string;
  assetId?: number;
  amount?: bigint;
}

export interface NetworkIdentity {
  genesisID: string;
  genesisHash: string;
}

export interface AlgodLike {
  /** Live adapters set this only when pending entries include the full payment tuple. */
  readonly pendingTupleMode?: "full";
  /** current round tip + liveness. */
  status(): Promise<{ lastRound: number }>;
  /** suggested params for building txns (flat min-fee expected). */
  suggestedParams(): Promise<{
    fee: number;
    flatFee: boolean;
    firstRound: number;
    lastRound: number;
    genesisID: string;
    genesisHash: string;
    minFee?: number;
  }>;
  /** on-chain account info incl auth-addr (rekey) + ALGO balance (microAlgos). */
  accountInfo(addr: string): Promise<{
    authAddr: string | null;
    amount: bigint;
    minBalance?: bigint;
  }>;
  /** ASA holding for an account; null if NOT opted-in. */
  assetHolding(addr: string, assetId: number): Promise<{ amount: bigint } | null>;
  /** pending pool txns from a sender; full live adapters return every payment tuple field. */
  pendingFromSender(addr: string): Promise<PendingTransfer[]>;
  /** submit a signed txn; returns txid. */
  submit(signed: Uint8Array): Promise<string>;
  /** bounded confirmation wait; required for scoped non-dry-run production sends. */
  waitForConfirmation?(txid: string, maxRounds: number): Promise<void>;
}

/** Minimal indexer surface — across-window authoritative history search. */
export interface IndexerLike {
  /** indexer health round (must be caught-up to algod tip before a "not found" is trusted). */
  healthRound(): Promise<number>;
  /** Network identity from the block at the observed health round. Required for scoped sends. */
  networkIdentity?(round: number): Promise<NetworkIdentity>;
  /**
   * Search committed txns matching the full tuple. Returns matches (may be empty).
   * The caller asserts the FULL tuple — never note-alone.
   */
  findByNote(args: {
    sender: string;
    receiver: string;
    assetId: number;
    note: string;
  }): Promise<Array<{ txid: string; amount: bigint }>>;
}

/** Signer abstraction — real signer uses algosdk secret key; tests use a stub. */
export interface Signer {
  /** address whose key this signer holds (from mnemonicToSecretKey.addr). */
  address: string;
  /** sign an unsigned txn → signed bytes. */
  sign(unsigned: import("algosdk").Transaction): Uint8Array;
  /** Zero and detach owned signing material. Idempotent when present. */
  dispose?(): void;
}
