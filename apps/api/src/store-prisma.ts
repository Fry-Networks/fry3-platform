/**
 * Prisma-backed ApiStore against canonical PG.
 * Transactional claim reservation (claim row + ledger entry, atomic).
 */
import type { ApiStore } from "./server.js";
// ESM import; PrismaClient is external at bundle time, resolved at runtime.
// Typed as any to avoid a hard dependency on the generated client's types at typecheck.
import pkg from "@prisma/client";
const { PrismaClient } = pkg as any;

export class PrismaStore implements ApiStore {
  private prisma: any;
  constructor(databaseUrl?: string) {
    this.prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  }

  async getActivePolicy() {
    const p = await this.prisma.rewardPolicy.findFirst({ orderBy: { version: "desc" } });
    if (!p) return null;
    const weights: Record<string, bigint> = {};
    const w = (p.weights as Record<string, string>) ?? {};
    for (const k of Object.keys(w)) weights[k] = BigInt(w[k]);
    return {
      version: p.version,
      weights,
      storageCapabilityWeight: BigInt(p.storageCapabilityWeight),
      onlineThresholdSeconds: p.onlineThresholdSeconds,
      intervalSeconds: p.intervalSeconds,
    };
  }

  async getDeviceState(deviceId: string) {
    const d = await this.prisma.device.findFirst({
      where: { OR: [{ id: deviceId }, { canonicalId: deviceId }, { minerKey: deviceId }] },
      select: { lastHeartbeatAt: true, banned: true, status: true },
    });
    if (!d) return null;
    return { lastHeartbeatAt: d.lastHeartbeatAt, banned: d.banned, disabled: d.status === "DISABLED" };
  }

  async heartbeatNonceExists(nonce: string): Promise<boolean> {
    const h = await this.prisma.heartbeat.findUnique({ where: { nonce }, select: { id: true } });
    return !!h;
  }

  async persistHeartbeat(hb: { deviceId: string; receivedAt: Date; reportedAt: Date | null; nonce: string; signature: string; integrationSnapshot: unknown }) {
    // resolve device PK
    const d = await this.prisma.device.findFirst({
      where: { OR: [{ id: hb.deviceId }, { canonicalId: hb.deviceId }, { minerKey: hb.deviceId }] },
      select: { id: true },
    });
    if (!d) throw new Error("device_not_found");
    await this.prisma.$transaction([
      this.prisma.heartbeat.create({
        data: {
          deviceId: d.id,
          receivedAt: hb.receivedAt,
          reportedAt: hb.reportedAt,
          nonce: hb.nonce,
          signature: hb.signature,
          payloadHash: null,
          integrationSnapshot: (hb.integrationSnapshot as any) ?? undefined,
        },
      }),
      this.prisma.device.update({ where: { id: d.id }, data: { lastHeartbeatAt: hb.receivedAt, lastSeenAt: hb.receivedAt, status: "ONLINE" } }),
    ]);
  }

  async getReservableBalanceBase(userId: string): Promise<bigint> {
    // reservable = sum(ACC RUE) - sum(reserved/paid). Read from ledger via accruals owned by user's devices minus claim reservations.
    const accruals = await this.prisma.rewardAccrual.findMany({
      where: { device: { ownerUserId: userId }, eligible: true },
      select: { amountBase: true },
    });
    const accrued = accruals.reduce((a: bigint, r: { amountBase: string }) => a + BigInt(r.amountBase), 0n);
    const reserved = await this.prisma.claim.findMany({
      where: { userId, status: { in: ["RESERVED", "DISPATCHED", "CONFIRMED", "RECONCILED"] } },
      select: { amountBase: true },
    });
    const claimed = reserved.reduce((a: bigint, r: { amountBase: string }) => a + BigInt(r.amountBase), 0n);
    const res = (accrued as bigint) - (claimed as bigint);
    return res > 0n ? res : 0n;
  }

  async claimByIdempotencyKey(key: string) {
    const c = await this.prisma.claim.findUnique({ where: { idempotencyKey: key }, select: { id: true, status: true } });
    return c ? { id: c.id, status: c.status } : null;
  }

  async createClaimTransactional(input: { userId: string; amountBase: bigint; destination: string; idempotencyKey: string }) {
    return this.prisma.$transaction(async (tx: any) => {
      const claim = await tx.claim.create({
        data: {
          userId: input.userId,
          amountBase: input.amountBase.toString(),
          status: "RESERVED",
          idempotencyKey: input.idempotencyKey,
          destination: input.destination,
          reservedAt: new Date(),
        },
      });
      // ledger reservation entry (immutable, idempotent)
      await tx.rewardLedgerEntry.create({
        data: {
          // claim-lifecycle entries are not accrual-anchored (accrualId null); the claim is referenced via refId
          entryType: "CLAIM_RESERVE",
          amountBase: (-input.amountBase).toString(),
          balanceAfter: "0", // recomputed by reconciliation job
          refId: claim.id,
          idempotencyKey: `reserve-${input.idempotencyKey}`,
        },
      });
      return { id: claim.id };
    });
  }

  async legacyInstallationHeartbeat(input: { minerKey: string; installId: string; version: string | null; body: unknown; now: Date; deviceTokenHash?: string | null }) {
    let d = await this.prisma.device.findFirst({
      where: { OR: [{ minerKey: input.minerKey }, { canonicalId: input.minerKey }] },
      select: { id: true },
    });
    if (!d) {
      // Frozen contract (P7.1): heartbeat IS registration — the legacy backend upserts
      // unknown miners, never 404s. New devices land on the Migration Holding owner
      // until a user binds them (same owner P4 used for stub devices).
      const owner = await this.prisma.user.findUnique({
        where: { primaryEmail: "migration-holding@fry3.invalid" },
        select: { id: true },
      });
      if (!owner) return { ok: false as const, reason: "registration_owner_missing" };
      try {
        d = await this.prisma.device.create({
          data: {
            ownerUserId: owner.id,
            canonicalId: `legacy:${input.minerKey}`,
            minerKey: input.minerKey,
            label: `LEGACY-REG ${input.minerKey}`,
            status: "OFFLINE",
          },
          select: { id: true },
        });
      } catch {
        // unique-constraint race: a concurrent heartbeat registered it first
        d = await this.prisma.device.findFirst({
          where: { OR: [{ minerKey: input.minerKey }, { canonicalId: input.minerKey }] },
          select: { id: true },
        });
        if (!d) return { ok: false as const, reason: "registration_race" };
      }
    }
    const nonce = `legacy:${input.installId}:${crypto.randomUUID()}`;
    const tokenHash = input.deviceTokenHash ?? null;
    await this.prisma.$transaction([
      this.prisma.femInstance.upsert({
        where: { instanceKey: input.installId },
        create: { deviceId: d.id, instanceKey: input.installId, version: input.version, lastSeenAt: input.now, deviceTokenHash: tokenHash },
        update: { version: input.version ?? undefined, lastSeenAt: input.now, ...(tokenHash ? { deviceTokenHash: tokenHash } : {}) },
      }),
      this.prisma.heartbeat.create({
        data: {
          deviceId: d.id,
          receivedAt: input.now,
          reportedAt: null,
          nonce,
          signature: "LEGACY_UNSIGNED",
          payloadHash: null,
          integrationSnapshot: (input.body as any) ?? undefined,
        },
      }),
      this.prisma.device.update({ where: { id: d.id }, data: { lastHeartbeatAt: input.now, lastSeenAt: input.now, status: "ONLINE" } }),
    ]);
    return { ok: true as const };
  }

  async legacyMeasurement(input: { hexId: string; minerCode: string | null; installId: string | null; measurementType: string | null; integration: string; timestamp: Date | null; value: unknown; now: Date }) {
    let deviceId: string | null = null;
    if (input.installId) {
      const fi = await this.prisma.femInstance.findUnique({ where: { instanceKey: input.installId }, select: { id: true, deviceId: true } });
      if (fi) {
        deviceId = fi.deviceId;
        await this.prisma.femInstance.update({ where: { id: fi.id }, data: { lastSeenAt: input.now } });
      }
    }
    if (!deviceId && input.minerCode) {
      const d = await this.prisma.device.findFirst({
        where: { OR: [{ minerKey: input.minerCode }, { canonicalId: input.minerCode }] },
        select: { id: true },
      });
      if (d) deviceId = d.id;
    }
    if (!deviceId) return { ok: false as const, reason: "unknown_install" };
    await this.prisma.integrationHealth.upsert({
      where: { deviceId_integration: { deviceId, integration: input.integration } },
      create: {
        deviceId,
        integration: input.integration,
        healthy: true,
        evidenceAt: input.timestamp ?? input.now,
        evidenceType: "telemetry",
        details: { hexId: input.hexId, measurementType: input.measurementType, value: input.value as any },
      },
      update: {
        healthy: true,
        evidenceAt: input.timestamp ?? input.now,
        evidenceType: "telemetry",
        details: { hexId: input.hexId, measurementType: input.measurementType, value: input.value as any },
      },
    });
    return { ok: true as const };
  }

  async byodLicenseLookup(licenseKey: string) {
    const lic = await this.prisma.byodLicense.findUnique({
      where: { licenseKey },
      select: { status: true, activatedAt: true, expiresAt: true, createdAt: true, deviceId: true },
    });
    if (!lic) return null;
    let device: { id: string; label: string | null; lastHeartbeatAt: Date | null; banned: boolean; disabled: boolean } | null = null;
    if (lic.deviceId) {
      const d = await this.prisma.device.findUnique({
        where: { id: lic.deviceId },
        select: { id: true, label: true, lastHeartbeatAt: true, banned: true, status: true },
      });
      if (d) device = { id: d.id, label: d.label, lastHeartbeatAt: d.lastHeartbeatAt, banned: d.banned, disabled: d.status === "DISABLED" };
    }
    return { status: lic.status, activatedAt: lic.activatedAt, expiresAt: lic.expiresAt, createdAt: lic.createdAt, device };
  }

  async byodActivate(input: { licenseKey: string; deviceRef: string; now: Date }) {
    return this.prisma.$transaction(async (tx: any) => {
      const lic = await tx.byodLicense.findUnique({
        where: { licenseKey: input.licenseKey },
        select: { id: true, userId: true, status: true, expiresAt: true, deviceId: true, activatedAt: true },
      });
      if (!lic) return { ok: false as const, code: 404, reason: "license_not_found" };
      if (lic.status !== "ACTIVE") return { ok: false as const, code: 409, reason: "license_not_active" };
      if (lic.expiresAt && lic.expiresAt <= input.now) return { ok: false as const, code: 409, reason: "license_expired" };
      const d = await tx.device.findFirst({
        where: { OR: [{ id: input.deviceRef }, { canonicalId: input.deviceRef }, { minerKey: input.deviceRef }] },
        select: { id: true, ownerUserId: true, banned: true },
      });
      if (!d) return { ok: false as const, code: 404, reason: "device_not_found" };
      if (lic.deviceId && lic.deviceId === d.id) {
        return { ok: true as const, deviceId: d.id, activatedAt: lic.activatedAt ?? input.now, idempotent: true };
      }
      if (lic.deviceId) return { ok: false as const, code: 409, reason: "license_device_bound" };
      if (d.ownerUserId !== lic.userId) return { ok: false as const, code: 403, reason: "cross_account_denied" };
      if (d.banned) return { ok: false as const, code: 409, reason: "device_banned" };
      const other = await tx.byodLicense.findFirst({ where: { deviceId: d.id }, select: { id: true } });
      if (other) return { ok: false as const, code: 409, reason: "device_already_licensed" };
      await tx.byodLicense.update({ where: { id: lic.id }, data: { deviceId: d.id, activatedAt: input.now } });
      return { ok: true as const, deviceId: d.id, activatedAt: input.now };
    });
  }
}
