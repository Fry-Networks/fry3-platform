import { describe, it, expect } from "vitest";
import {
  DEFAULT_REACTIONS,
  DiscordRest,
  buildAnnouncement,
  postAnnouncement,
  validateAnnouncement,
} from "../src/announce";

function mockRest() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const rest: DiscordRest = {
    get: async (path) => (calls.push({ method: "GET", path }), {}),
    post: async (path, body) => (calls.push({ method: "POST", path, body }), { id: "msg1" }),
    put: async (path, body) => (calls.push({ method: "PUT", path, body }), {}),
  };
  return { rest, calls };
}

describe("DEFAULT_REACTIONS", () => {
  it("is exactly the three FryBot default emojis, in order", () => {
    expect(DEFAULT_REACTIONS).toEqual(["\u{1F35F}", "\u{1F389}", "\u{1F525}"]);
    expect(DEFAULT_REACTIONS).toHaveLength(3);
  });
});

describe("validateAnnouncement", () => {
  it("accepts @everyone first line + body", () => {
    expect(validateAnnouncement("@everyone\nheadline").ok).toBe(true);
  });
  it("rejects when first line is not @everyone", () => {
    expect(validateAnnouncement("headline\n@everyone").reason).toBe("first_line_not_everyone");
  });
  it("rejects @everyone embedded mid-line", () => {
    expect(validateAnnouncement("hey @everyone\nbody").reason).toBe("first_line_not_everyone");
  });
  it("rejects empty body", () => {
    expect(validateAnnouncement("@everyone").reason).toBe("empty_body");
    expect(validateAnnouncement("@everyone\n \n ").reason).toBe("empty_body");
  });
  it("tolerates surrounding whitespace on the first line only", () => {
    expect(validateAnnouncement("  @everyone  \nbody").ok).toBe(true);
  });
});

describe("buildAnnouncement", () => {
  it("puts @everyone first, before the headline", () => {
    expect(buildAnnouncement("Maintenance done", "details")).toBe("@everyone\nMaintenance done\ndetails");
  });
  it("omits absent body", () => {
    expect(buildAnnouncement("H")).toBe("@everyone\nH");
  });
});

describe("postAnnouncement", () => {
  it("posts then applies the three default reactions, in order", async () => {
    const { rest, calls } = mockRest();
    const r = await postAnnouncement(rest, "chan1", buildAnnouncement("release"), { operatorApproved: true });
    expect(r).toEqual({ messageId: "msg1", channelId: "chan1", reactionsAdded: [...DEFAULT_REACTIONS] });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/channels/chan1/messages",
      body: { content: "@everyone\nrelease", allowed_mentions: { parse: ["everyone"] } },
    });
    const reactionPaths = calls.slice(1).map((c) => c.path);
    expect(reactionPaths).toEqual(
      DEFAULT_REACTIONS.map((e) => `/channels/chan1/messages/msg1/reactions/${encodeURIComponent(e)}/@me`)
    );
    expect(calls.slice(1).every((c) => c.method === "PUT")).toBe(true);
  });
  it("rejects without operator approval — nothing posted", async () => {
    const { rest, calls } = mockRest();
    await expect(
      postAnnouncement(rest, "chan1", "@everyone\nx", { operatorApproved: false })
    ).rejects.toThrow("mass_mention_not_approved");
    expect(calls).toHaveLength(0);
  });
  it("rejects malformed content — nothing posted", async () => {
    const { rest, calls } = mockRest();
    await expect(
      postAnnouncement(rest, "chan1", "no everyone\nbody", { operatorApproved: true })
    ).rejects.toThrow("first_line_not_everyone");
    expect(calls).toHaveLength(0);
  });
});
