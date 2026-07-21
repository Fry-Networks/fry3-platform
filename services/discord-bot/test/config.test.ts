import { describe, it, expect } from "vitest";
import { guildAllowed, loadConfig } from "../src/config";

const env = {
  DISCORD_TOKEN: "tok",
  FRY3_GUILD_ID: "g1",
  FRY3_ANNOUNCE_CHANNEL_ID: "c1",
  FRY3_GUILD_IS_PRODUCTION: "0",
};

describe("loadConfig", () => {
  it("loads a complete env", () => {
    expect(loadConfig(env)).toEqual({
      token: "tok",
      guildId: "g1",
      announceChannelId: "c1",
      guildIsProduction: false,
    });
  });
  it("fails fast on each missing var", () => {
    for (const k of Object.keys(env)) {
      const partial: Record<string, string | undefined> = { ...env, [k]: undefined };
      expect(() => loadConfig(partial)).toThrow(`missing_env:${k}`);
    }
  });
  it("blank counts as missing", () => {
    expect(() => loadConfig({ ...env, DISCORD_TOKEN: "  " })).toThrow("missing_env:DISCORD_TOKEN");
  });
  it("production flag only on literal '1'", () => {
    expect(loadConfig({ ...env, FRY3_GUILD_IS_PRODUCTION: "1" }).guildIsProduction).toBe(true);
    expect(loadConfig({ ...env, FRY3_GUILD_IS_PRODUCTION: "true" }).guildIsProduction).toBe(false);
  });
});

describe("guildAllowed", () => {
  it("exact match only", () => {
    expect(guildAllowed("g1", { guildId: "g1" })).toBe(true);
    expect(guildAllowed("g2", { guildId: "g1" })).toBe(false);
    expect(guildAllowed("", { guildId: "" })).toBe(false);
  });
});
