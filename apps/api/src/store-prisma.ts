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
          accrualId: claim.id, // reservation anchors to claim; ACCRUE entries reference RewardAccrual
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
}
