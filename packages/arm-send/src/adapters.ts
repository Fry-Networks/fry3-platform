/**
 * Live glue — real algosdk-backed AlgodLike / IndexerLike, real signers, fs LedgerStore.
 *
 * These wrap algosdk.Algodv2 (ATLAS00 :8190 primary; Nodely fallback) and algosdk.Indexer
 * (local if ATLAS00 runs one, else Nodely). The pure logic (intent/manifest/ledger/
 * reconcile/decide/send) is tested against mocks; these adapters carry the network I/O and
 * are exercised at real arm time. dryRun never calls submit().
 *
 * NO credential is read here. The signer takes an in-memory mnemonic supplied by the caller
 * at arm time only (never logged / persisted / echoed).
 */
import algosdk from "algosdk";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AlgodLike, IndexerLike, Signer } from "./types.js";
import { serializeRecord, parseLine, type LedgerStore } from "./ledger.js";
import type { LedgerRecord } from "./types.js";

const b64ToStr = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");

/** Real algod adapter. `client` = new algosdk.Algodv2(token, server, port). */
function exactBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new Error(`${field}: expected exact integer string or safe integer`);
}

function base64Bytes(value: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

function base64PublicKey(value: string): Uint8Array | null {
  const bytes = base64Bytes(value);
  return bytes?.length === 32 ? bytes : null;
}

function transactionForId(txn: any): any {
  const normalized = { ...txn };
  for (const field of ["snd", "arcv", "aclose", "asnd", "rekey"] as const) {
    if (typeof normalized[field] !== "string") continue;
    const bytes = base64PublicKey(normalized[field]);
    if (bytes) normalized[field] = bytes;
  }
  for (const field of ["note", "lx", "gh"] as const) {
    if (typeof normalized[field] !== "string") continue;
    const bytes = base64Bytes(normalized[field]);
    if (bytes) normalized[field] = bytes;
  }
  return normalized;
}

function addressString(value: any): string {
  if (!value) return "";
  if (typeof value === "string") {
    if (algosdk.isValidAddress(value)) return value;
    const decoded = base64PublicKey(value);
    return decoded ? algosdk.encodeAddress(decoded) : value;
  }
  const bytes = value.publicKey ?? value;
  if (bytes instanceof Uint8Array || Buffer.isBuffer(bytes))
    return algosdk.encodeAddress(new Uint8Array(bytes));
  return String(value);
}

function noteString(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    if (
      value.startsWith("fry3-arm:v1:") ||
      value.startsWith("fry3-settlement:v1:")
    )
      return value;
    return Buffer.from(value, "base64").toString("utf8");
  }
  return Buffer.from(value).toString("utf8");
}

function pendingTxid(signed: any, txn: any): string {
  const direct = signed?.txid ?? signed?.txId ?? signed?.id;
  if (direct) return String(direct);
  if (typeof signed?.txID === "function") return String(signed.txID());
  if (typeof txn?.txID === "function") return String(txn.txID());
  return algosdk.Transaction.from_obj_for_encoding(transactionForId(txn)).txID();
}

function parsePendingTransfer(value: any) {
  const signed = value?.txn ?? value;
  const txn = signed?.txn ?? signed;
  const transfer =
    txn?.["asset-transfer-transaction"] ??
    txn?.assetTransferTransaction ??
    txn?.axfer ??
    txn;
  const rawAssetId =
    transfer?.["asset-id"] ?? transfer?.assetId ?? transfer?.xaid ?? txn?.xaid;
  if (rawAssetId === undefined) return null;
  const rawAmount = transfer?.amount ?? transfer?.aamt ?? txn?.aamt;
  const sender = addressString(txn?.sender ?? txn?.snd);
  const receiver = addressString(
    transfer?.receiver ?? transfer?.rcv ?? transfer?.arcv ?? txn?.arcv
  );
  if (!sender || !receiver || rawAmount === undefined)
    throw new Error("pending tuple parse failed: incomplete asset transfer");
  const txid = pendingTxid(signed, txn);
  if (!txid) throw new Error("pending tuple parse failed: missing txid");
  return {
    txid,
    note: noteString(txn?.note),
    sender,
    receiver,
    assetId: Number(exactBigInt(rawAssetId, "pending asset id")),
    amount: exactBigInt(rawAmount, "pending amount"),
  };
}

export function makeAlgod(client: algosdk.Algodv2): AlgodLike {
  return {
    pendingTupleMode: "full",
    async status() {
      const s: any = await client.status().do();
      return { lastRound: Number(s["last-round"] ?? s.lastRound) };
    },
    async suggestedParams() {
      const p: any = await client.getTransactionParams().do();
      return {
        fee: Number(p.fee),
        flatFee: Boolean(p.flatFee),
        firstRound: Number(p.firstRound),
        lastRound: Number(p.lastRound),
        genesisID: String(p.genesisID),
        genesisHash:
          typeof p.genesisHash === "string"
            ? p.genesisHash
            : Buffer.from(p.genesisHash).toString("base64"),
        minFee: p.minFee !== undefined ? Number(p.minFee) : undefined,
      };
    },
    async accountInfo(addr) {
      const account: any = await client.accountInformation(addr).do();
      const rawAuthAddr = account["auth-addr"] ?? account.authAddr;
      return {
        authAddr: rawAuthAddr ? addressString(rawAuthAddr) : null,
        amount: exactBigInt(account.amount ?? 0, "account amount"),
        minBalance: exactBigInt(
          account["min-balance"] ?? account.minBalance ?? 0,
          "account minimum balance"
        ),
      };
    },
    async assetHolding(addr, assetId) {
      try {
        const response: any = await client.accountAssetInformation(addr, assetId).do();
        const holding = response["asset-holding"] ?? response.assetHolding;
        if (!holding) return null;
        return { amount: exactBigInt(holding.amount ?? 0, "asset holding amount") };
      } catch (error: any) {
        if (
          String(error?.status) === "404" ||
          String(error?.message ?? "").includes("404")
        )
          return null;
        throw error;
      }
    },
    async pendingFromSender(addr) {
      const response: any = await client.pendingTransactionByAddress(addr).do();
      const list: any[] = response["top-transactions"] ?? response.topTransactions ?? [];
      return list
        .map(parsePendingTransfer)
        .filter((transfer): transfer is NonNullable<typeof transfer> => transfer !== null);
    },
    async submit(signed) {
      const response: any = await client.sendRawTransaction(signed).do();
      const txid = response.txId ?? response.txid;
      if (typeof txid !== "string" || txid.length === 0)
        throw new Error("algod submit response missing transaction id");
      return txid;
    },
    async waitForConfirmation(txid, maxRounds) {
      await algosdk.waitForConfirmation(client, txid, maxRounds);
    },
  };
}

/** Real indexer adapter. `client` = new algosdk.Indexer(token, server, port). */
export function makeIndexer(client: algosdk.Indexer): IndexerLike {
  return {
    async healthRound() {
      const h: any = await client.makeHealthCheck().do();
      return Number(h.round);
    },
    async networkIdentity(round) {
      const response = (await client.lookupBlock(round).do()) as unknown;
      if (response === null || typeof response !== "object")
        throw new Error("indexer block response must be an object");
      const responseRecord = response as Record<string, unknown>;
      const blockValue = responseRecord.block ?? response;
      if (blockValue === null || typeof blockValue !== "object")
        throw new Error("indexer block missing block object");
      const block = blockValue as Record<string, unknown>;
      const genesisID = block.genesisId ?? block["genesis-id"];
      const genesisHash = block.genesisHash ?? block["genesis-hash"];
      if (typeof genesisID !== "string" || genesisID.length === 0)
        throw new Error("indexer block missing genesis ID");
      if (
        typeof genesisHash !== "string" &&
        !(genesisHash instanceof Uint8Array) &&
        !Buffer.isBuffer(genesisHash)
      )
        throw new Error("indexer block missing genesis hash");
      return {
        genesisID,
        genesisHash:
          typeof genesisHash === "string"
            ? genesisHash
            : Buffer.from(genesisHash).toString("base64"),
      };
    },
    async findByNote({ sender, receiver, assetId, note }) {
      const notePrefix = new TextEncoder().encode(note);
      const r: any = await client
        .searchForTransactions()
        .address(receiver)
        .addressRole("receiver")
        .assetID(assetId)
        .notePrefix(notePrefix)
        .do();
      const txns: any[] = r.transactions ?? [];
      const out: Array<{ txid: string; amount: bigint }> = [];
      for (const t of txns) {
        const s = String(t.sender ?? "");
        const at = t["asset-transfer-transaction"];
        if (!at) continue;
        const noteStr = t.note ? b64ToStr(t.note) : "";
        const actualReceiver = addressString(at.receiver ?? at.rcv ?? at.arcv);
        if (
          s === sender &&
          actualReceiver === receiver &&
          noteStr === note &&
          Number(exactBigInt(at["asset-id"], "indexer asset id")) === assetId
        ) {
          out.push({
            txid: String(t.id),
            amount: exactBigInt(at.amount ?? 0, "indexer transfer amount"),
          });
        }
      }
      return out;
    },
  };
}

/** In-memory-key signer. The signer owns `sk`; dispose zeroes and detaches it. */
export function makeSkSigner(addr: string, sk: Uint8Array): Signer {
  let secretKey: Uint8Array | null = sk;
  return {
    address: addr,
    sign(unsigned) {
      if (!secretKey) throw new Error("signer disposed");
      return unsigned.signTxn(secretKey);
    },
    dispose() {
      if (!secretKey) return;
      secretKey.fill(0);
      secretKey = null;
    },
  };
}

/** Real arm signer from an in-memory mnemonic (supplied at arm time only). */
export function makeMnemonicSigner(mnemonic: string): Signer {
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic);
  return makeSkSigner(addr, sk);
}

/** Ephemeral throwaway account signer — for testnet/dry-run construction with NO real key. */
export function makeEphemeralSigner(): Signer {
  const a = algosdk.generateAccount();
  return makeSkSigner(a.addr, a.sk);
}

/** Append-only fs-backed jsonl ledger (arm-sends-<epoch>.jsonl on ARES00). */
export function makeFileLedgerStore(
  path: string,
  approvedRoot?: string
): LedgerStore {
  const ledgerPath = resolve(path);
  if (approvedRoot) {
    const root = resolve(approvedRoot);
    const fromRoot = relative(root, ledgerPath);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot))
      throw new Error(`ledger path must remain under approved ledger root ${root}`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const openRegular = (flags: number, mode?: number) => {
    if (existsSync(ledgerPath)) {
      const before = lstatSync(ledgerPath);
      if (before.isSymbolicLink() || !before.isFile())
        throw new Error("ledger path must be a regular non-symlink file");
    }
    const fd = openSync(ledgerPath, flags | noFollow, mode);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw new Error("ledger path must be a regular file");
    }
    return fd;
  };

  return {
    async append(record: LedgerRecord) {
      const fd = openRegular(
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
        0o600
      );
      try {
        writeFileSync(fd, `${serializeRecord(record)}\n`, { encoding: "utf8" });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    async readAll() {
      if (!existsSync(ledgerPath)) return [];
      const fd = openRegular(constants.O_RDONLY);
      try {
        const text = readFileSync(fd, "utf8");
        return text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map(parseLine);
      } finally {
        closeSync(fd);
      }
    },
  };
}
