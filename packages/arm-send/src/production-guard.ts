import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MIN_AUTHENTICATION_KEY_BYTES,
  SAFE_ID,
  SHA256,
  UUID,
  ZERO_MAC,
  defaultInspectProcess,
  defaultOwner,
  deriveSettlementGuardAuthenticationKey,
  equalMac,
  makeAnchor,
  makeLock,
  makeReservationRecords,
  parseAnchor,
  parseLock,
  parseReservation,
  type RegistryAnchor,
  type ReservationRecord,
  type SettlementProcessInspection,
  type SettlementProcessOwner,
} from "./production-guard-integrity.js";

const LOCK_FILE = ".settlement-production.lock";
const REGISTRY_FILE = "settlement-claim-reservations.jsonl";
const ANCHOR_FILE = "settlement-reservation-anchor.json";

export { deriveSettlementGuardAuthenticationKey };
export type { SettlementProcessInspection, SettlementProcessOwner };

export interface SettlementReservation {
  readonly batchId: string;
  readonly manifestSha256: string;
  readonly claimIds: readonly string[];
}

export interface SettlementProductionGuard {
  runExclusive<T>(
    reservation: SettlementReservation,
    action: () => Promise<T>
  ): Promise<T>;
}

export interface SettlementProductionGuardOptions {
  readonly approvedRoot: string;
  readonly guardRoot: string;
  readonly authenticationKey: Uint8Array;
  readonly leaseMs?: number;
  readonly nowMs?: () => number;
  readonly owner?: SettlementProcessOwner;
  readonly inspectProcess?: (
    owner: SettlementProcessOwner
  ) => SettlementProcessInspection;
}

interface RegistryState {
  readonly records: readonly ReservationRecord[];
  readonly anchor: RegistryAnchor;
}

export class SettlementProductionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementProductionGuardError";
  }
}

function validateReservation(
  reservation: SettlementReservation
): SettlementReservation {
  if (!SAFE_ID.test(reservation.batchId))
    throw new SettlementProductionGuardError("invalid settlement batch ID");
  if (!SHA256.test(reservation.manifestSha256))
    throw new SettlementProductionGuardError("invalid settlement manifest hash");
  const claimIds = [...new Set(reservation.claimIds)].sort();
  if (claimIds.length === 0 || claimIds.length !== reservation.claimIds.length)
    throw new SettlementProductionGuardError(
      "settlement reservation requires unique claim IDs"
    );
  if (claimIds.some((claimId) => !UUID.test(claimId)))
    throw new SettlementProductionGuardError("invalid settlement claim ID");
  return { ...reservation, claimIds };
}

function openRegular(path: string, flags: number, mode?: number): number {
  if (existsSync(path)) {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile())
      throw new SettlementProductionGuardError(
        "settlement guard path must be a regular non-symlink file"
      );
  }
  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new SettlementProductionGuardError(
      "settlement guard path must be a regular file"
    );
  }
  return fd;
}

function validateRoot(path: string, label: string): string {
  const root = resolve(path);
  const state = lstatSync(root);
  if (state.isSymbolicLink() || !state.isDirectory())
    throw new SettlementProductionGuardError(
      `${label} must be a non-symlink directory`
    );
  return root;
}

function readRegistry(path: string, key: Uint8Array): ReservationRecord[] {
  if (!existsSync(path)) return [];
  const fd = openRegular(path, constants.O_RDONLY);
  try {
    const raw = readFileSync(fd, "utf8");
    if (raw.length === 0) return [];
    if (!raw.endsWith("\n"))
      throw new SettlementProductionGuardError(
        "settlement reservation registry has a truncated final record"
      );
    const records = raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseReservation(line, key));
    const claimIds = new Set<string>();
    records.forEach((record, index) => {
      const expectedSequence = index + 1;
      const expectedPrevious = index === 0 ? ZERO_MAC : records[index - 1]!.mac;
      if (
        record.sequence !== expectedSequence ||
        !equalMac(record.previousMac, expectedPrevious)
      )
        throw new SettlementProductionGuardError(
          "settlement reservation registry chain integrity failed"
        );
      if (claimIds.has(record.claimId))
        throw new SettlementProductionGuardError(
          `duplicate claim reservation ${record.claimId}`
        );
      claimIds.add(record.claimId);
    });
    return records;
  } finally {
    closeSync(fd);
  }
}

function readAnchor(path: string, key: Uint8Array): RegistryAnchor | null {
  if (!existsSync(path)) return null;
  const fd = openRegular(path, constants.O_RDONLY);
  try {
    return parseAnchor(readFileSync(fd, "utf8").trim(), key);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function createInitialAnchor(
  path: string,
  guardRoot: string,
  key: Uint8Array
): RegistryAnchor {
  const anchor = makeAnchor(0, ZERO_MAC, key);
  const fd = openRegular(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    writeFileSync(fd, `${JSON.stringify(anchor)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(guardRoot);
  return anchor;
}

function replaceAnchor(
  path: string,
  guardRoot: string,
  anchor: RegistryAnchor
): void {
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  const fd = openRegular(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    writeFileSync(fd, `${JSON.stringify(anchor)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(guardRoot);
}

function loadRegistryState(
  registryPath: string,
  anchorPath: string,
  guardRoot: string,
  key: Uint8Array
): RegistryState {
  const registryExists = existsSync(registryPath);
  const records = readRegistry(registryPath, key);
  let anchor = readAnchor(anchorPath, key);
  if (!anchor) {
    if (registryExists)
      throw new SettlementProductionGuardError(
        "settlement reservation registry exists without trusted anchor"
      );
    anchor = createInitialAnchor(anchorPath, guardRoot, key);
  }
  if (anchor.sequence > records.length)
    throw new SettlementProductionGuardError(
      "settlement reservation registry is missing or truncated behind anchor"
    );
  const anchoredHead =
    anchor.sequence === 0 ? ZERO_MAC : records[anchor.sequence - 1]!.mac;
  if (!equalMac(anchor.headMac, anchoredHead))
    throw new SettlementProductionGuardError(
      "settlement reservation registry does not match trusted anchor"
    );
  if (records.length > anchor.sequence) {
    const head = records[records.length - 1]!.mac;
    anchor = makeAnchor(records.length, head, key);
    replaceAnchor(anchorPath, guardRoot, anchor);
  }
  return { records, anchor };
}

function appendReservations(
  registryPath: string,
  anchorPath: string,
  guardRoot: string,
  reservation: SettlementReservation,
  claimIds: readonly string[],
  state: RegistryState,
  key: Uint8Array
): void {
  if (claimIds.length === 0) return;
  const records = makeReservationRecords(
    reservation,
    claimIds,
    state.records,
    key
  );
  const serialized = records.map((record) => JSON.stringify(record)).join("\n");
  const fd = openRegular(
    registryPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600
  );
  try {
    writeFileSync(fd, `${serialized}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const head = records[records.length - 1]!;
  replaceAnchor(
    anchorPath,
    guardRoot,
    makeAnchor(head.sequence, head.mac, key)
  );
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

function reclaimExactStaleLock(
  lockPath: string,
  reservation: SettlementReservation,
  nowMs: number,
  inspectProcess: (
    owner: SettlementProcessOwner
  ) => SettlementProcessInspection,
  key: Uint8Array
): void {
  const fd = openRegular(lockPath, constants.O_RDONLY);
  const state = fstatSync(fd);
  let lock;
  try {
    lock = parseLock(readFileSync(fd, "utf8"), key);
  } finally {
    closeSync(fd);
  }
  if (
    lock.batchId !== reservation.batchId ||
    lock.manifestSha256 !== reservation.manifestSha256
  )
    throw new SettlementProductionGuardError(
      "settlement production lock belongs to a different batch"
    );
  if (lock.leaseUntilMs > nowMs)
    throw new SettlementProductionGuardError(
      "settlement production lock already held; lease has not expired"
    );
  const inspection = inspectProcess(lock.owner);
  const hasDifferentIdentity =
    inspection.state === "alive" &&
    inspection.startIdentity !== undefined &&
    inspection.startIdentity !== lock.owner.startIdentity;
  if (inspection.state !== "dead" && !hasDifferentIdentity)
    throw new SettlementProductionGuardError(
      "settlement production lock owner is live or cannot be disproved"
    );
  const current = lstatSync(lockPath);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== state.dev ||
    current.ino !== state.ino
  )
    throw new SettlementProductionGuardError(
      "settlement production lock changed during stale-lock validation"
    );
  unlinkSync(lockPath);
}

function acquireLock(
  lockPath: string,
  reservation: SettlementReservation,
  owner: SettlementProcessOwner,
  nowMs: () => number,
  leaseMs: number,
  inspectProcess: (
    owner: SettlementProcessOwner
  ) => SettlementProcessInspection,
  key: Uint8Array
): { readonly fd: number; readonly state: ReturnType<typeof fstatSync> } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt > 0)
        throw new SettlementProductionGuardError(
          "settlement production lock changed while being reclaimed"
        );
      reclaimExactStaleLock(
        lockPath,
        reservation,
        nowMs(),
        inspectProcess,
        key
      );
      continue;
    }
    const state = fstatSync(fd);
    const lock = makeLock(reservation, owner, nowMs(), leaseMs, key);
    try {
      writeFileSync(fd, `${JSON.stringify(lock)}\n`, { encoding: "utf8" });
      fsyncSync(fd);
      return { fd, state };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  throw new SettlementProductionGuardError(
    "settlement production lock could not be acquired"
  );
}

export function makeFileSettlementProductionGuard(
  options: SettlementProductionGuardOptions
): SettlementProductionGuard {
  const approvedRoot = validateRoot(
    options.approvedRoot,
    "approved settlement ledger root"
  );
  const guardRoot = validateRoot(
    options.guardRoot,
    "approved settlement guard root"
  );
  if (approvedRoot === guardRoot)
    throw new SettlementProductionGuardError(
      "settlement guard root must be separate from mutable ledger root"
    );
  if (options.authenticationKey.byteLength < MIN_AUTHENTICATION_KEY_BYTES)
    throw new SettlementProductionGuardError(
      "settlement guard authentication key must be at least 32 bytes"
    );
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    leaseMs > MAX_LEASE_MS
  )
    throw new SettlementProductionGuardError(
      "settlement production lock lease must be bounded"
    );
  const nowMs = options.nowMs ?? Date.now;
  const owner = options.owner ?? defaultOwner(nowMs);
  const inspectProcess = options.inspectProcess ?? defaultInspectProcess;
  const lockPath = join(guardRoot, LOCK_FILE);
  const registryPath = join(approvedRoot, REGISTRY_FILE);
  const anchorPath = join(guardRoot, ANCHOR_FILE);
  const key = options.authenticationKey;

  return {
    async runExclusive<T>(
      input: SettlementReservation,
      action: () => Promise<T>
    ): Promise<T> {
      const reservation = validateReservation(input);
      const lock = acquireLock(
        lockPath,
        reservation,
        owner,
        nowMs,
        leaseMs,
        inspectProcess,
        key
      );
      try {
        const state = loadRegistryState(
          registryPath,
          anchorPath,
          guardRoot,
          key
        );
        const byClaim = new Map(
          state.records.map((record) => [record.claimId, record] as const)
        );
        const newClaims = reservation.claimIds.filter((claimId) => {
          const prior = byClaim.get(claimId);
          if (!prior) return true;
          if (
            prior.batchId !== reservation.batchId ||
            prior.manifestSha256 !== reservation.manifestSha256
          )
            throw new SettlementProductionGuardError(
              `claim ${claimId} already reserved by a different batch`
            );
          return false;
        });
        appendReservations(
          registryPath,
          anchorPath,
          guardRoot,
          reservation,
          newClaims,
          state,
          key
        );
        return await action();
      } finally {
        try {
          const current = lstatSync(lockPath);
          if (
            current.isFile() &&
            !current.isSymbolicLink() &&
            current.dev === lock.state.dev &&
            current.ino === lock.state.ino
          )
            unlinkSync(lockPath);
        } finally {
          closeSync(lock.fd);
        }
      }
    },
  };
}
