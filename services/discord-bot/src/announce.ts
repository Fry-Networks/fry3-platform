/**
 * FryBot announcement path — the canonical new-stack announcement primitive.
 * Contract (binding plan P6 / operating manual §20):
 *   - first line of every announcement is exactly "@everyone" (before headline, before body);
 *   - posted via the path that applies FryBot's three default reaction emojis (🍟 🎉 🔥), in order;
 *   - mass-mention still passes the operator-approval guard (messageMentionAllowed).
 */
import { messageMentionAllowed } from "./bot";

/** FryBot's three default reaction emojis, in canonical order. */
export const DEFAULT_REACTIONS: readonly string[] = ["\u{1F35F}", "\u{1F389}", "\u{1F525}"]; // 🍟 🎉 🔥

/** Minimal Discord REST surface; injected so tests run against a mock. */
export interface DiscordRest {
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
  put(path: string, body?: unknown): Promise<any>;
}

export function validateAnnouncement(content: string): { ok: boolean; reason?: string } {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "@everyone") return { ok: false, reason: "first_line_not_everyone" };
  if (lines.length < 2 || lines.slice(1).join("").trim() === "") return { ok: false, reason: "empty_body" };
  return { ok: true };
}

/** Compose a compliant announcement: "@everyone" first line, then headline, then optional body. */
export function buildAnnouncement(headline: string, body?: string): string {
  return ["@everyone", headline, ...(body !== undefined && body !== "" ? [body] : [])].join("\n");
}

export interface AnnounceResult {
  messageId: string;
  channelId: string;
  reactionsAdded: string[];
}

/**
 * Post an announcement and apply the three default reactions.
 * Throws (posts nothing) if the content violates the first-line contract or the
 * operator-approval guard; reactions are applied in DEFAULT_REACTIONS order.
 */
export async function postAnnouncement(
  rest: DiscordRest,
  channelId: string,
  content: string,
  opts: { operatorApproved: boolean }
): Promise<AnnounceResult> {
  const v = validateAnnouncement(content);
  if (!v.ok) throw new Error(`announcement_rejected:${v.reason}`);
  const gate = messageMentionAllowed(content, true, opts.operatorApproved);
  if (!gate.ok) throw new Error(`announcement_rejected:${gate.reason}`);
  const msg = await rest.post(`/channels/${channelId}/messages`, {
    content,
    allowed_mentions: { parse: ["everyone"] },
  });
  const reactionsAdded: string[] = [];
  for (const emoji of DEFAULT_REACTIONS) {
    await rest.put(`/channels/${channelId}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`);
    reactionsAdded.push(emoji);
  }
  return { messageId: msg.id, channelId, reactionsAdded };
}

/** fetch-backed DiscordRest (node >= 18). One bounded retry on 429. */
export function fetchRest(token: string, apiBase = "https://discord.com/api/v10"): DiscordRest {
  async function call(method: string, path: string, body?: unknown, retried = false): Promise<any> {
    const res = await fetch(apiBase + path, {
      method,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && !retried) {
      const data = await res.json().catch(() => ({}));
      const waitMs = Math.min(10000, Math.ceil(((data as any).retry_after ?? 1) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
      return call(method, path, body, true);
    }
    if (!res.ok) throw new Error(`discord_api_${res.status}:${method} ${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
  };
}
