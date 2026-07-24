# @fry3/arm-send — R14.5 crash-safe idempotent mainnet ASA send batch

Build/gate artifact for the FRY3 P9 **9f money-arm** (`plans/fry3-p9-arm-hardening.md §E`,
worker.txt **R14.5**). Sends the reconciled payout manifest to devices as **independent
per-ASA** mainnet transfers of **FRY3 `3612979527`** and **fNODE `2485202024`**, safely
across host crash / succession.

**This package's tests validate TESTNET/DRY-RUN only. No mainnet send occurs here.**

## R14.5 requirement → module map

| R14.5 clause | Where | Gate |
|---|---|---|
| 1. Deterministic frozen intent-id `HASH(device+ASA+owed+arm-epoch)` | `src/intent.ts` `computeIntentId` | `intent.test.ts` (determinism, every field bound, base-unit-exact, negative/bad-arg reject) |
| 2. note + 32-byte lease, ~1000-round window | `src/intent.ts` `noteFor`/`leaseFor`, `src/build.ts` | `intent.test.ts`, `build.test.ts` (lease 32B, `lastRound-firstRound==1000`, note round-trip) |
| 3. Indexer-authoritative across-window reconcile; full-tuple; caught-up-to-tip else BLOCKER; pending-pool | `src/reconcile.ts` | `reconcile.test.ts` (node-stale / indexer-stale BLOCKERs, full-tuple, wrong-amount throws, wrong-sender miss, pending, none) |
| 4. Append-only jsonl written BEFORE submit, txid backfilled; resume decision tree | `src/ledger.ts`, `src/decide.ts`, `src/send.ts` | `ledger.test.ts`, `decide.test.ts` (all 6 tree branches + indexer-missing refusal), `send.test.ts` |
| 5. Rekey-aware auth-addr check → BLOCKER | `src/send.ts` | `send.test.ts` (auth-addr mismatch, signer≠hot) |
| 6. Independent per-ASA txns (NOT grouped) + pre-send opt-in → `recipient-not-opted-in` never fabricated | `src/build.ts`, `src/send.ts` | `send.test.ts` (per-ASA partial pay, opt-in miss), `build.test.ts` (`group undefined`) |
| 7. Per-send failure classify + never inline-resubmit an already-broadcast txn | `src/send.ts` `classify`, resume-via-idempotency | `send.test.ts` (crash-safety: submit throws → intent persisted, no confirm, resume resends exactly once, no double) |
| R14.2 sanity + base-unit assertion (can't-exceed-owed, derived band, balance, ALGO fee budget) | `src/manifest.ts`, `src/send.ts` | `manifest.test.ts`, `send.test.ts` (balance/fee BLOCKERs) |

## Arm-time invocation (the flip/arm session — NOT run here)

```
import { parseManifest, assertSanity, deriveSendUnits, perAsaSendCount,
         MAINNET_NETWORK, makeAlgod, makeIndexer, makeMnemonicSigner,
         makeFileLedgerStore, runSendBatch } from "@fry3/arm-send";
import algosdk from "algosdk";

// 1. bind the FROZEN manifest (newest existing arm-manifest-<epoch>.json — never re-mint epoch/owed)
const m = parseManifest(fs.readFileSync(`.../arm-manifest-${epoch}.json`,"utf8"));
assertSanity(m, entitlementsFromReconciledLedger, absurdCeiling);   // BLOCKER on breach
const units = deriveSendUnits(m);

// 2. real clients — ATLAS00 :8190 algod primary (stale→Nodely); local indexer if present else Nodely
const algod   = makeAlgod(new algosdk.Algodv2(token, "http://100.69.195.100", 8190));
const indexer = makeIndexer(new algosdk.Indexer(itoken, indexerServer, indexerPort));

// 3. signer from the in-memory mnemonic (credcache item nnagvb2qd2myce5xxiaqy3oecm) — ARM TIME ONLY, never logged
const signer  = makeMnemonicSigner(mnemonicInMemory);

// 4. append-only ledger on ARES00; DRY-RUN first, then dryRun:false ONCE all R14 predicates green
const ledgerRoot = `/home/fry/fry3p/var/payment-ledgers`;
const store = makeFileLedgerStore(
  `${ledgerRoot}/arm-sends-${epoch}.jsonl`,
  ledgerRoot
);
const res = await runSendBatch({ units, hotWallet: signer.address, store, algod, indexer,
                                signer, dryRun: false, now: new Date().toISOString(),
                                algoHeadroomMicro: 1_000_000n,
                                scope: { kind: "arm", epoch },
                                expectedNetwork: MAINNET_NETWORK });
// res.outcomes / res.failedSet → the terminal report (paid / skipped / failed-with-reason)
```

## Pre-cutover tFRY remediation CLI

The remediation driver accepts only a canonical settlement manifest plus an Ed25519-signed
safety gate produced by `signMainnetSafetyGate`. The gate binds the batch, manifest SHA-256,
active signer, observation/expiry window, and every required production predicate. Scoped runs
also prove the indexer's genesis from the indexed block at its caught-up round, revalidate algod
genesis on every params fetch, require full pending tuples, and wait for bounded confirmation.

Set these values in the current process environment without printing them:

- `FRY3_SETTLEMENT_MNEMONIC`
- `FRY3_ALGOD_TOKEN`, `FRY3_ALGOD_SERVER`, `FRY3_ALGOD_PORT`
- `FRY3_INDEXER_TOKEN`, `FRY3_INDEXER_SERVER`, `FRY3_INDEXER_PORT`
- `FRY3_SETTLEMENT_LEDGER_ROOT`
- `FRY3_SETTLEMENT_GUARD_ROOT` (existing non-symlink directory, separate from ledger root)

Then build and run the frozen inputs first with zero submits:

```
npm run build
npm run settlement -- --manifest <settlement-manifest.json> \
  --safety-gate <signed-safety-gate.json> --ledger <settlement-sends.jsonl>
```

Only after the dry-run and independent financial gates pass, execute that same manifest/gate:

```
npm run settlement -- --manifest <settlement-manifest.json> \
  --safety-gate <signed-safety-gate.json> --ledger <settlement-sends.jsonl> \
  --execute-mainnet
```

Mainnet execution acquires `.settlement-production.lock` under the separate guard root and
fsyncs HMAC-chained claim reservations to `settlement-claim-reservations.jsonl` under the
ledger root before the first submit. An authenticated head anchor stays under the guard root,
so deletion, truncation, rewrite, or field tampering in the mutable registry fails closed.
Exact batch/hash resumes are allowed. A different batch can never reserve an existing claim.
A crash-stale lock is reclaimed only for the exact batch after its bounded lease expires and
the recorded process is conclusively dead or has a different Linux process-start identity;
live, cross-host, malformed, or ambiguous locks fail closed. The guard authentication key is
domain-derived in memory from the settlement mnemonic and zeroed after execution. The mnemonic
environment entry is deleted immediately after signer construction.

**Resume** is automatic and safe: re-run the identical call. `runSendBatch` re-establishes tip
(BLOCKER on stale), re-checks auth-addr, re-asserts balance ≥ **REMAINING**, folds the existing
jsonl, and for each unit runs (txid-present → skip) / (indexer committed → skip+backfill) /
(pending → skip) / (else → resend SAME id+note+lease+amount). Epoch and owed are read from the
frozen manifest/filename — **never re-minted, never recomputed from a live recompute**.

## Dry-run validation performed in this build session (secret-free, offline)
`dryrun_testnet.test.ts` builds+signs BOTH arm-ASA legs with an **ephemeral throwaway** account
and synthetic-valid suggested params, decodes the signed bytes, and asserts the on-chain-exact
tuple (from/to/asset/amount/note/lease/txid) with **zero submits**. This is the exact arm-time
code path; only `makeMnemonicSigner` (real key) and `algod.submit` (thin `sendRawTransaction`
wrapper, covered by the `send.test.ts` mock-submit path) differ at arm time.

**Remaining (arm session, gated behind all R14 predicates):** a live-testnet funded submit is
the only exercise not run here (needs testnet funding + network); the submit adapter is a 2-line
`sendRawTransaction` wrapper. NO mainnet send until parity(R14.1)==100% EXACT ∧
money_path_100x(R14.3)==pass ∧ e2e_green==true.

## Placement into fry3-platform (at flip, additive)
Copy `src/` → `services/arm-send/src/`, `test/` → `services/arm-send/test/`, plus this
`package.json`/`tsconfig.json`/`tsconfig.test.json`/`vitest.config.ts`. Additive/untracked,
gate-green in the reviewed Node.js 22 build container (`vitest@3.2.6`). Reversal: remove only
the additive `services/arm-send` path. Live stores remain untouched until gated execution;
`algosdk` pinned `^2.11.0` to match the fry3 ecosystem's 2.x pin (3.x has breaking changes).
