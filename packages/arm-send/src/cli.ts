#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import algosdk from "algosdk";
import {
  makeAlgod,
  makeFileLedgerStore,
  makeIndexer,
  makeMnemonicSigner,
} from "./adapters.js";
import {
  parseMainnetSafetyGate,
  runSettlementDriver,
} from "./driver.js";
import {
  deriveSettlementGuardAuthenticationKey,
  makeFileSettlementProductionGuard,
} from "./production-guard.js";
import type { Signer } from "./types.js";
import {
  parseSettlementManifest,
  settlementManifestSha256,
} from "./settlement.js";

interface CliArguments {
  readonly manifestPath: string;
  readonly safetyGatePath: string;
  readonly ledgerPath: string;
  readonly executeMainnet: boolean;
}

function usage(): never {
  throw new Error(
    "usage: fry3-settlement --manifest <file> --safety-gate <file> " +
      "--ledger <file> [--execute-mainnet]"
  );
}

export function parseArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>();
  let executeMainnet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute-mainnet") {
      if (executeMainnet) usage();
      executeMainnet = true;
      continue;
    }
    if (!["--manifest", "--safety-gate", "--ledger"].includes(argument)) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) usage();
    values.set(argument, value);
    index += 1;
  }
  const manifestPath = values.get("--manifest");
  const safetyGatePath = values.get("--safety-gate");
  const ledgerPath = values.get("--ledger");
  if (!manifestPath || !safetyGatePath || !ledgerPath) usage();
  return { manifestPath, safetyGatePath, ledgerPath, executeMainnet };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function parsePort(name: string): string | number {
  const value = requiredEnvironment(name);
  if (value === "") throw new Error(`${name} must not be empty`);
  return /^\d+$/.test(value) ? Number(value) : value;
}

export async function runWithSignerCleanup<T>(
  signer: Signer,
  guardAuthenticationKey: Uint8Array | undefined,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } finally {
    signer.dispose?.();
    guardAuthenticationKey?.fill(0);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifestRaw = readFileSync(args.manifestPath, "utf8");
  const safetyGateRaw = readFileSync(args.safetyGatePath, "utf8");
  const manifest = parseSettlementManifest(manifestRaw);
  if (args.executeMainnet && manifest.network !== "mainnet")
    throw new Error("--execute-mainnet requires a mainnet settlement manifest");

  let mnemonic = requiredEnvironment("FRY3_SETTLEMENT_MNEMONIC");
  const signer = makeMnemonicSigner(mnemonic);
  const guardAuthenticationKey = args.executeMainnet
    ? deriveSettlementGuardAuthenticationKey(mnemonic)
    : undefined;
  mnemonic = "";
  delete process.env.FRY3_SETTLEMENT_MNEMONIC;

  const result = await runWithSignerCleanup(
    signer,
    guardAuthenticationKey,
    async () => {
      const algodClient = new algosdk.Algodv2(
        requiredEnvironment("FRY3_ALGOD_TOKEN"),
        requiredEnvironment("FRY3_ALGOD_SERVER"),
        parsePort("FRY3_ALGOD_PORT")
      );
      const indexerClient = new algosdk.Indexer(
        requiredEnvironment("FRY3_INDEXER_TOKEN"),
        requiredEnvironment("FRY3_INDEXER_SERVER"),
        parsePort("FRY3_INDEXER_PORT")
      );
      const ledgerRoot = requiredEnvironment("FRY3_SETTLEMENT_LEDGER_ROOT");
      const guardRoot = args.executeMainnet
        ? requiredEnvironment("FRY3_SETTLEMENT_GUARD_ROOT")
        : undefined;
      return runSettlementDriver({
        manifestRaw,
        expectedManifestSha256: settlementManifestSha256(manifestRaw),
        gate: parseMainnetSafetyGate(safetyGateRaw),
        network: manifest.network,
        payerAddress: manifest.payer,
        algod: makeAlgod(algodClient),
        indexer: makeIndexer(indexerClient),
        signer,
        store: makeFileLedgerStore(args.ledgerPath, ledgerRoot),
        productionGuard: args.executeMainnet
          ? makeFileSettlementProductionGuard({
              approvedRoot: ledgerRoot,
              guardRoot: guardRoot!,
              authenticationKey: guardAuthenticationKey!,
            })
          : undefined,
        dryRun: !args.executeMainnet,
        now: new Date().toISOString(),
        // Spendable ALGO gate is amount-minBalance. Live remediation wallet has
        // ~0.71 ALGO free; keep a 0.1 ALGO cushion above fee×count, not 1 ALGO.
        algoHeadroomMicro: 100_000n,
      });
    }
  );
  process.stdout.write(
    `${JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    )}\n`
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`settlement failed: ${message}\n`);
    process.exitCode = 1;
  });
}
