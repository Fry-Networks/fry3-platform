import { describe, it, expect } from "vitest";
import { canExecute, messageMentionAllowed, RateLimiter, dedupeInteractions, BotCommand } from "../src/bot";

const cmd = (over: Partial<BotCommand>): BotCommand => ({ name: "x", guildScope: "both", allowEveryoneMention: false, ...over });

describe("production guard", () => {
  it("test command blocked in production guild", () => {
    expect(canExecute(cmd({ guildScope: "test" }), [], true).reason).toBe("test_command_in_production_guild");
  });
  it("production command blocked in test guild", () => {
    expect(canExecute(cmd({ guildScope: "production" }), [], false).reason).toBe("production_command_in_test_guild");
  });
  it("both-scope runs anywhere", () => {
    expect(canExecute(cmd({}), [], true).ok).toBe(true);
  });
  it("role required", () => {
    expect(canExecute(cmd({ requiredRole: "admin" }), [], true).reason).toBe("missing_required_role");
    expect(canExecute(cmd({ requiredRole: "admin" }), ["admin"], true).ok).toBe(true);
  });
});

describe("@everyone guard", () => {
  it("mass mention rejected by default", () => {
    expect(messageMentionAllowed("hello @everyone", false, false).reason).toBe("mass_mention_not_approved");
  });
  it("@here rejected by default", () => {
    expect(messageMentionAllowed("@here update", false, false).ok).toBe(false);
  });
  it("mass mention rejected without operator approval even if allowed", () => {
    expect(messageMentionAllowed("@everyone", true, false).ok).toBe(false);
  });
  it("mass mention allowed ONLY when allowed AND operator-approved", () => {
    expect(messageMentionAllowed("@everyone release", true, true).ok).toBe(true);
  });
  it("normal message ok", () => {
    expect(messageMentionAllowed("hello world", false, false).ok).toBe(true);
  });
});

describe("rate limit", () => {
  it("enforces limit per user", () => {
    const rl = new RateLimiter(2, 60000);
    expect(rl.allow("u1", 1000)).toBe(true);
    expect(rl.allow("u1", 2000)).toBe(true);
    expect(rl.allow("u1", 3000)).toBe(false);
    expect(rl.allow("u2", 3000)).toBe(true);
    expect(rl.allow("u1", 70000)).toBe(true);
  });
});

describe("idempotent interactions", () => {
  it("dedupes by id", () => {
    expect(dedupeInteractions([{ id: "a" }, { id: "a" }, { id: "b" }])).toHaveLength(2);
  });
});
