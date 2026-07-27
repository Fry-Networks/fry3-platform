/**
 * Tooth B (R3) — bridge runtime config (env-driven, fail-fast).
 *
 * Mirrors the discord-bot config convention: required vars throw on missing,
 * numeric/bool vars parse with defaults. DRY_RUN defaults to TRUE so a
 * mis-started container cannot write live stores before the P9c flip — the
 * entrypoint must be explicitly told FRY3_BRIDGE_DRY_RUN=0 at flip-time.
 */

import { DEFAULT_THRESHOLDS, type DriftThresholds } from "./drift.js";
import { DEFAULT_USER_AGENT } from "./alert.js";

export interface BridgeConfig {
  databaseUrl: string;
  mongoUri: string;
  webhookUrl: string;
  userAgent: string;
  dryRun: boolean;
  intervalMs: number;
  checksumSampleSize: number;
  thresholds: DriftThresholds;
}

function req(env: Record<string, string | undefined>, k: string): string {
  const v = env[k];
  if (v === undefined || v.trim() === "") throw new Error(`missing_env:${k}`);
  return v.trim();
}

function num(env: Record<string, string | undefined>, k: string, dflt: number): number {
  const v = env[k];
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad_env_number:${k}`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): BridgeConfig {
  // DRY_RUN default true: only "0"/"false" opt into live writes.
  const dryRaw = (env.FRY3_BRIDGE_DRY_RUN ?? "1").trim().toLowerCase();
  const dryRun = !(dryRaw === "0" || dryRaw === "false");

  return {
    databaseUrl: req(env, "FRY3_DATABASE_URL"),
    mongoUri: req(env, "FRY3_BRIDGE_MONGO_URI"),
    webhookUrl: req(env, "FRY3_BRIDGE_WEBHOOK_URL"),
    userAgent: (env.FRY3_BRIDGE_USER_AGENT ?? DEFAULT_USER_AGENT).trim(),
    dryRun,
    intervalMs: num(env, "FRY3_BRIDGE_INTERVAL_MS", 5 * 60 * 1000),
    checksumSampleSize: num(env, "FRY3_BRIDGE_CHECKSUM_N", 100),
    thresholds: {
      maxLagMs: num(env, "FRY3_BRIDGE_MAX_LAG_MS", DEFAULT_THRESHOLDS.maxLagMs),
      persistCycles: num(env, "FRY3_BRIDGE_PERSIST_CYCLES", DEFAULT_THRESHOLDS.persistCycles),
    },
  };
}
