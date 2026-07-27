import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base: Record<string, string> = {
  FRY3_DATABASE_URL: "postgresql://x",
  FRY3_BRIDGE_MONGO_URI: "mongodb://y",
  FRY3_BRIDGE_WEBHOOK_URL: "https://discord/webhook",
};

describe("config: fail-fast", () => {
  it("throws on each missing required var", () => {
    expect(() => loadConfig({ ...base, FRY3_DATABASE_URL: "" })).toThrow(/missing_env:FRY3_DATABASE_URL/);
    expect(() => loadConfig({ ...base, FRY3_BRIDGE_MONGO_URI: undefined })).toThrow(
      /missing_env:FRY3_BRIDGE_MONGO_URI/,
    );
    expect(() => loadConfig({ ...base, FRY3_BRIDGE_WEBHOOK_URL: "" })).toThrow(
      /missing_env:FRY3_BRIDGE_WEBHOOK_URL/,
    );
  });
});

describe("config: dry-run default (pre-flip safety)", () => {
  it("defaults dryRun=true when unset", () => {
    expect(loadConfig(base).dryRun).toBe(true);
  });

  it("only 0/false opt into live writes", () => {
    expect(loadConfig({ ...base, FRY3_BRIDGE_DRY_RUN: "0" }).dryRun).toBe(false);
    expect(loadConfig({ ...base, FRY3_BRIDGE_DRY_RUN: "false" }).dryRun).toBe(false);
    expect(loadConfig({ ...base, FRY3_BRIDGE_DRY_RUN: "1" }).dryRun).toBe(true);
    expect(loadConfig({ ...base, FRY3_BRIDGE_DRY_RUN: "yes" }).dryRun).toBe(true);
  });
});

describe("config: numeric parsing + defaults", () => {
  it("uses design defaults when unset", () => {
    const c = loadConfig(base);
    expect(c.intervalMs).toBe(300_000);
    expect(c.checksumSampleSize).toBe(100);
    expect(c.thresholds.maxLagMs).toBe(900_000);
    expect(c.thresholds.persistCycles).toBe(3);
  });

  it("overrides parse", () => {
    const c = loadConfig({ ...base, FRY3_BRIDGE_INTERVAL_MS: "60000", FRY3_BRIDGE_PERSIST_CYCLES: "5" });
    expect(c.intervalMs).toBe(60_000);
    expect(c.thresholds.persistCycles).toBe(5);
  });

  it("throws on a non-numeric override", () => {
    expect(() => loadConfig({ ...base, FRY3_BRIDGE_INTERVAL_MS: "soon" })).toThrow(
      /bad_env_number:FRY3_BRIDGE_INTERVAL_MS/,
    );
  });
});
