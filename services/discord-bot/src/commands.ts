/**
 * Command surface + dispatcher. All command handling flows through the same
 * guards as ad-hoc messages: guild allowlist -> scope/role gate -> rate limit
 * -> idempotency. /announce reuses the canonical announcement path (first line
 * "@everyone" + three default reactions).
 */
import { BotCommand, canExecute, RateLimiter } from "./bot";
import { DiscordRest, buildAnnouncement, postAnnouncement } from "./announce";
import { BotConfig, guildAllowed } from "./config";

export const COMMANDS: BotCommand[] = [
  { name: "ping", guildScope: "both", allowEveryoneMention: false },
  { name: "status", guildScope: "both", allowEveryoneMention: false },
  { name: "announce", requiredRole: "fry3-operator", guildScope: "both", allowEveryoneMention: true },
];

/** Guild-scoped registration payload (NEVER registered globally at P6). */
export function buildGuildCommandsPayload(): Array<Record<string, unknown>> {
  return [
    { name: "ping", description: "Liveness check", type: 1 },
    { name: "status", description: "New-stack API health", type: 1 },
    {
      name: "announce",
      description: "Operator announcement (first line @everyone + three default reactions)",
      type: 1,
      options: [
        { name: "headline", description: "Announcement headline", type: 3, required: true },
        { name: "body", description: "Announcement body", type: 3, required: false },
      ],
    },
  ];
}

/** Bulk-overwrite the commands of ONE guild. Refuses any guild but the configured one. */
export async function registerGuildCommands(
  rest: DiscordRest,
  appId: string,
  guildId: string,
  cfg: Pick<BotConfig, "guildId">
): Promise<any> {
  if (!guildAllowed(guildId, cfg)) throw new Error("register_rejected:guild_not_allowed");
  return rest.put(`/applications/${appId}/guilds/${guildId}/commands`, buildGuildCommandsPayload());
}

export interface Interaction {
  id: string;
  guildId: string;
  userId: string;
  userRoles: string[];
  command: string;
  options?: Record<string, string>;
  /** true ONLY when the invocation carries explicit operator approval. */
  operatorApproved?: boolean;
}

export interface DispatchDeps {
  cfg: BotConfig;
  rest: DiscordRest;
  limiter: RateLimiter;
  /** Interaction ids already handled (idempotency). */
  seen: Set<string>;
  apiHealth?: () => Promise<string>;
}

export interface DispatchResult {
  ok: boolean;
  reason?: string;
  reply?: string;
}

export async function dispatchInteraction(i: Interaction, deps: DispatchDeps): Promise<DispatchResult> {
  if (deps.seen.has(i.id)) return { ok: false, reason: "duplicate_interaction" };
  deps.seen.add(i.id);
  if (!guildAllowed(i.guildId, deps.cfg)) return { ok: false, reason: "guild_not_allowed" };
  const def = COMMANDS.find((c) => c.name === i.command);
  if (!def) return { ok: false, reason: "unknown_command" };
  const gate = canExecute(def, i.userRoles, deps.cfg.guildIsProduction);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  if (!deps.limiter.allow(i.userId)) return { ok: false, reason: "rate_limited" };
  switch (i.command) {
    case "ping":
      return { ok: true, reply: "pong" };
    case "status":
      return { ok: true, reply: deps.apiHealth ? await deps.apiHealth() : "unknown" };
    case "announce": {
      const content = buildAnnouncement(i.options?.headline ?? "", i.options?.body);
      const r = await postAnnouncement(deps.rest, deps.cfg.announceChannelId, content, {
        operatorApproved: i.operatorApproved === true,
      });
      return { ok: true, reply: `announced:${r.messageId}` };
    }
    default:
      return { ok: false, reason: "unhandled_command" };
  }
}
