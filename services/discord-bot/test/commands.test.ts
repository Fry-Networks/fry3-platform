import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/bot";
import { DiscordRest, DEFAULT_REACTIONS } from "../src/announce";
import { BotConfig } from "../src/config";
import {
  COMMANDS,
  buildGuildCommandsPayload,
  dispatchInteraction,
  registerGuildCommands,
  Interaction,
} from "../src/commands";

const cfg: BotConfig = {
  token: "T",
  guildId: "g-test",
  announceChannelId: "chan1",
  guildIsProduction: false,
};

function mockRest() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const rest: DiscordRest = {
    get: async (path) => (calls.push({ method: "GET", path }), {}),
    post: async (path, body) => (calls.push({ method: "POST", path, body }), { id: "msg1" }),
    put: async (path, body) => (calls.push({ method: "PUT", path, body }), body ?? {}),
  };
  return { rest, calls };
}

function deps(over: Partial<Parameters<typeof dispatchInteraction>[1]> = {}) {
  const { rest, calls } = mockRest();
  return {
    calls,
    d: { cfg, rest, limiter: new RateLimiter(10, 60000), seen: new Set<string>(), ...over },
  };
}

const base: Interaction = { id: "i1", guildId: "g-test", userId: "u1", userRoles: [], command: "ping" };

describe("command registration", () => {
  it("payload covers the full command surface", () => {
    const names = buildGuildCommandsPayload().map((c) => c.name);
    expect(names).toEqual(COMMANDS.map((c) => c.name));
  });
  it("registers guild-scoped to the configured guild only", async () => {
    const { rest, calls } = mockRest();
    await registerGuildCommands(rest, "app1", "g-test", cfg);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("/applications/app1/guilds/g-test/commands");
  });
  it("refuses to register into any other guild", async () => {
    const { rest, calls } = mockRest();
    await expect(registerGuildCommands(rest, "app1", "g-prod", cfg)).rejects.toThrow("guild_not_allowed");
    expect(calls).toHaveLength(0);
  });
});

describe("dispatchInteraction guards", () => {
  it("guild allowlist: foreign-guild interaction refused", async () => {
    const { d } = deps();
    expect(await dispatchInteraction({ ...base, guildId: "g-other" }, d)).toEqual({
      ok: false,
      reason: "guild_not_allowed",
    });
  });
  it("unknown command refused", async () => {
    const { d } = deps();
    expect((await dispatchInteraction({ ...base, command: "nope" }, d)).reason).toBe("unknown_command");
  });
  it("duplicate interaction id handled once", async () => {
    const { d } = deps();
    expect((await dispatchInteraction(base, d)).ok).toBe(true);
    expect((await dispatchInteraction(base, d)).reason).toBe("duplicate_interaction");
  });
  it("rate limit enforced per user", async () => {
    const { d } = deps({ limiter: new RateLimiter(1, 60000) });
    expect((await dispatchInteraction({ ...base, id: "a" }, d)).ok).toBe(true);
    expect((await dispatchInteraction({ ...base, id: "b" }, d)).reason).toBe("rate_limited");
  });
  it("announce requires the operator role", async () => {
    const { d } = deps();
    const i: Interaction = { ...base, id: "x", command: "announce", options: { headline: "h" } };
    expect((await dispatchInteraction(i, d)).reason).toBe("missing_required_role");
  });
});

describe("dispatchInteraction handlers", () => {
  it("ping replies pong", async () => {
    const { d } = deps();
    expect(await dispatchInteraction(base, d)).toEqual({ ok: true, reply: "pong" });
  });
  it("status reports API health via injected probe", async () => {
    const { d } = deps({ apiHealth: async () => "ok" });
    expect((await dispatchInteraction({ ...base, id: "s1", command: "status" }, d)).reply).toBe("ok");
  });
  it("announce (role + operator approval) posts @everyone-first + three default reactions", async () => {
    const { d, calls } = deps();
    const i: Interaction = {
      ...base,
      id: "a1",
      command: "announce",
      userRoles: ["fry3-operator"],
      options: { headline: "FRY3 live", body: "details" },
      operatorApproved: true,
    };
    const r = await dispatchInteraction(i, d);
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("announced:msg1");
    expect(calls[0].body).toMatchObject({ content: "@everyone\nFRY3 live\ndetails" });
    expect(calls.length).toBe(1 + DEFAULT_REACTIONS.length);
  });
  it("announce WITHOUT operator approval throws before posting", async () => {
    const { d, calls } = deps();
    const i: Interaction = {
      ...base,
      id: "a2",
      command: "announce",
      userRoles: ["fry3-operator"],
      options: { headline: "x" },
    };
    await expect(dispatchInteraction(i, d)).rejects.toThrow("mass_mention_not_approved");
    expect(calls).toHaveLength(0);
  });
  it("production guard composes: prod guild honours scope gates", async () => {
    const prodCfg = { ...cfg, guildId: "g-prod", guildIsProduction: true };
    const { d } = deps({ cfg: prodCfg });
    expect((await dispatchInteraction({ ...base, guildId: "g-prod" }, d)).ok).toBe(true);
  });
});
