import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as currentHostname } from "node:os";

export const SAFE_ID = /^[A-Za-z0-9_.-]{1,100}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ZERO_MAC = "0".repeat(64);
export const DEFAULT_LEASE_MS = 15 * 60 * 1_000;
export const MAX_LEASE_MS = 30 * 60 * 1_000;
export const MIN_AUTHENTICATION_KEY_BYTES = 32;

const NONCE = /^[0-9a-f]{32}$/;
const GUARD_KEY_DOMAIN = "fry3-settlement-production-guard-v1";

export interface ReservationIdentity {
  readonly batchId: string;
  readonly manifestSha256: string;
}

export interface SettlementProcessOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly startIdentity: string;
}

export interface SettlementProcessInspection {
  readonly state: "alive" | "dead" | "unknown";
  readonly startIdentity?: string;
}

export interface ReservationRecord extends ReservationIdentity {
  readonly version: 2;
  readonly sequence: number;
  readonly previousMac: string;
  readonly claimId: string;
  readonly mac: string;
}

export interface RegistryAnchor {
  readonly version: 1;
  readonly sequence: number;
  readonly headMac: string;
  readonly mac: string;
}

export interface LockRecord extends ReservationIdentity {
  readonly version: 1;
  readonly owner: SettlementProcessOwner;
  readonly acquiredAtMs: number;
  readonly leaseUntilMs: number;
  readonly nonce: string;
  readonly mac: string;
}

export class SettlementGuardIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementGuardIntegrityError";
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  return (
    actual.length === expected.length &&
    expected.slice().sort().every((key, index) => actual[index] === key)
  );
}

function authenticate(key: Uint8Array, payload: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

export function equalMac(actual: string, expected: string): boolean {
  if (!SHA256.test(actual) || !SHA256.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function reservationPayload(
  record: Omit<ReservationRecord, "mac">
): string {
  return JSON.stringify([
    record.version,
    record.sequence,
    record.previousMac,
    record.batchId,
    record.manifestSha256,
    record.claimId,
  ]);
}

function anchorPayload(anchor: Omit<RegistryAnchor, "mac">): string {
  return JSON.stringify([anchor.version, anchor.sequence, anchor.headMac]);
}

function lockPayload(lock: Omit<LockRecord, "mac">): string {
  return JSON.stringify([
    lock.version,
    lock.batchId,
    lock.manifestSha256,
    lock.owner.pid,
    lock.owner.hostname,
    lock.owner.startIdentity,
    lock.acquiredAtMs,
    lock.leaseUntilMs,
    lock.nonce,
  ]);
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SettlementGuardIntegrityError(
      `invalid settlement ${label} JSON`
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SettlementGuardIntegrityError(
      `invalid settlement ${label} record`
    );
  return value as Record<string, unknown>;
}

export function parseReservation(
  line: string,
  key: Uint8Array
): ReservationRecord {
  const record = parseJsonRecord(line, "reservation registry");
  if (
    !exactKeys(record, [
      "version",
      "sequence",
      "previousMac",
      "batchId",
      "manifestSha256",
      "claimId",
      "mac",
    ]) ||
    record.version !== 2 ||
    !Number.isSafeInteger(record.sequence) ||
    Number(record.sequence) <= 0 ||
    typeof record.previousMac !== "string" ||
    !SHA256.test(record.previousMac) ||
    typeof record.batchId !== "string" ||
    !SAFE_ID.test(record.batchId) ||
    typeof record.manifestSha256 !== "string" ||
    !SHA256.test(record.manifestSha256) ||
    typeof record.claimId !== "string" ||
    !UUID.test(record.claimId) ||
    typeof record.mac !== "string" ||
    !SHA256.test(record.mac)
  )
    throw new SettlementGuardIntegrityError(
      "invalid settlement reservation registry record"
    );
  const parsed: ReservationRecord = {
    version: 2,
    sequence: Number(record.sequence),
    previousMac: record.previousMac,
    batchId: record.batchId,
    manifestSha256: record.manifestSha256,
    claimId: record.claimId,
    mac: record.mac,
  };
  const expected = authenticate(
    key,
    reservationPayload({
      version: parsed.version,
      sequence: parsed.sequence,
      previousMac: parsed.previousMac,
      batchId: parsed.batchId,
      manifestSha256: parsed.manifestSha256,
      claimId: parsed.claimId,
    })
  );
  if (!equalMac(parsed.mac, expected))
    throw new SettlementGuardIntegrityError(
      "settlement reservation registry authentication failed"
    );
  return parsed;
}

export function parseAnchor(raw: string, key: Uint8Array): RegistryAnchor {
  const record = parseJsonRecord(raw, "reservation anchor");
  if (
    !exactKeys(record, ["version", "sequence", "headMac", "mac"]) ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.sequence) ||
    Number(record.sequence) < 0 ||
    typeof record.headMac !== "string" ||
    !SHA256.test(record.headMac) ||
    typeof record.mac !== "string" ||
    !SHA256.test(record.mac)
  )
    throw new SettlementGuardIntegrityError(
      "invalid settlement reservation anchor record"
    );
  const parsed: RegistryAnchor = {
    version: 1,
    sequence: Number(record.sequence),
    headMac: record.headMac,
    mac: record.mac,
  };
  const expected = authenticate(
    key,
    anchorPayload({
      version: parsed.version,
      sequence: parsed.sequence,
      headMac: parsed.headMac,
    })
  );
  if (!equalMac(parsed.mac, expected))
    throw new SettlementGuardIntegrityError(
      "settlement reservation anchor authentication failed"
    );
  return parsed;
}

export function parseLock(raw: string, key: Uint8Array): LockRecord {
  const record = parseJsonRecord(raw.trim(), "production lock metadata");
  if (
    !exactKeys(record, [
      "version",
      "batchId",
      "manifestSha256",
      "owner",
      "acquiredAtMs",
      "leaseUntilMs",
      "nonce",
      "mac",
    ]) ||
    record.version !== 1 ||
    typeof record.batchId !== "string" ||
    !SAFE_ID.test(record.batchId) ||
    typeof record.manifestSha256 !== "string" ||
    !SHA256.test(record.manifestSha256) ||
    record.owner === null ||
    typeof record.owner !== "object" ||
    Array.isArray(record.owner) ||
    !Number.isSafeInteger(record.acquiredAtMs) ||
    !Number.isSafeInteger(record.leaseUntilMs) ||
    Number(record.acquiredAtMs) < 0 ||
    Number(record.leaseUntilMs) <= Number(record.acquiredAtMs) ||
    Number(record.leaseUntilMs) - Number(record.acquiredAtMs) > MAX_LEASE_MS ||
    typeof record.nonce !== "string" ||
    !NONCE.test(record.nonce) ||
    typeof record.mac !== "string" ||
    !SHA256.test(record.mac)
  )
    throw new SettlementGuardIntegrityError(
      "invalid settlement production lock metadata"
    );
  const owner = record.owner as Record<string, unknown>;
  if (
    !exactKeys(owner, ["pid", "hostname", "startIdentity"]) ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 ||
    typeof owner.hostname !== "string" ||
    owner.hostname.length === 0 ||
    typeof owner.startIdentity !== "string" ||
    owner.startIdentity.length === 0
  )
    throw new SettlementGuardIntegrityError(
      "invalid settlement production lock owner metadata"
    );
  const parsed: LockRecord = {
    version: 1,
    batchId: record.batchId,
    manifestSha256: record.manifestSha256,
    owner: {
      pid: Number(owner.pid),
      hostname: owner.hostname,
      startIdentity: owner.startIdentity,
    },
    acquiredAtMs: Number(record.acquiredAtMs),
    leaseUntilMs: Number(record.leaseUntilMs),
    nonce: record.nonce,
    mac: record.mac,
  };
  const expected = authenticate(
    key,
    lockPayload({
      version: parsed.version,
      batchId: parsed.batchId,
      manifestSha256: parsed.manifestSha256,
      owner: parsed.owner,
      acquiredAtMs: parsed.acquiredAtMs,
      leaseUntilMs: parsed.leaseUntilMs,
      nonce: parsed.nonce,
    })
  );
  if (!equalMac(parsed.mac, expected))
    throw new SettlementGuardIntegrityError(
      "settlement production lock metadata authentication failed"
    );
  return parsed;
}

export function makeAnchor(
  sequence: number,
  headMac: string,
  key: Uint8Array
): RegistryAnchor {
  const payload = { version: 1 as const, sequence, headMac };
  return { ...payload, mac: authenticate(key, anchorPayload(payload)) };
}

export function makeReservationRecords(
  reservation: ReservationIdentity,
  claimIds: readonly string[],
  existing: readonly ReservationRecord[],
  key: Uint8Array
): ReservationRecord[] {
  let previousMac = existing.at(-1)?.mac ?? ZERO_MAC;
  return claimIds.map((claimId, index) => {
    const payload = {
      version: 2 as const,
      sequence: existing.length + index + 1,
      previousMac,
      batchId: reservation.batchId,
      manifestSha256: reservation.manifestSha256,
      claimId,
    };
    const record = {
      ...payload,
      mac: authenticate(key, reservationPayload(payload)),
    };
    previousMac = record.mac;
    return record;
  });
}

function linuxProcessStartIdentity(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function defaultOwner(nowMs: () => number): SettlementProcessOwner {
  return {
    pid: process.pid,
    hostname: currentHostname(),
    startIdentity:
      linuxProcessStartIdentity(process.pid) ??
      `fallback-${process.pid}-${Math.floor(nowMs() - process.uptime() * 1_000)}`,
  };
}

export function defaultInspectProcess(
  owner: SettlementProcessOwner
): SettlementProcessInspection {
  if (owner.hostname !== currentHostname()) return { state: "unknown" };
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "ESRCH") return { state: "dead" };
    if (code === "EPERM") return { state: "alive" };
    return { state: "unknown" };
  }
  const startIdentity = linuxProcessStartIdentity(owner.pid);
  return {
    state: "alive",
    ...(startIdentity ? { startIdentity } : {}),
  };
}

export function makeLock(
  reservation: ReservationIdentity,
  owner: SettlementProcessOwner,
  nowMs: number,
  leaseMs: number,
  key: Uint8Array
): LockRecord {
  const payload = {
    version: 1 as const,
    batchId: reservation.batchId,
    manifestSha256: reservation.manifestSha256,
    owner,
    acquiredAtMs: nowMs,
    leaseUntilMs: nowMs + leaseMs,
    nonce: randomBytes(16).toString("hex"),
  };
  return { ...payload, mac: authenticate(key, lockPayload(payload)) };
}

export function deriveSettlementGuardAuthenticationKey(
  mnemonic: string
): Uint8Array {
  if (mnemonic.trim().length === 0)
    throw new SettlementGuardIntegrityError(
      "settlement guard key derivation requires mnemonic"
    );
  return new Uint8Array(
    createHmac("sha256", Buffer.from(mnemonic, "utf8"))
      .update(GUARD_KEY_DOMAIN, "utf8")
      .digest()
  );
}
