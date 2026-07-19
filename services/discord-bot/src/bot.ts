/**
 * Fry Discord bot — least-privilege, test-guild support, production guard.
 * @everyone ONLY for operator-approved announcements. No mass-mention/prod test posts.
 */

export type GuildScope = "test" | "production" | "both";

export interface BotCommand {
  name: string;
  requiredRole?: string;
  guildScope: GuildScope;
  allowEveryoneMention: boolean;
}

/** Production guard: a "test"-scoped command cannot run in a production guild. */
export function canExecute(command: BotCommand, userRoles: string[], guildIsProduction: boolean): { ok: boolean; reason?: string } {
  if (guildIsProduction && command.guildScope === "test") {
    return { ok: false, reason: "test_command_in_production_guild" };
  }
  if (!guildIsProduction && command.guildScope === "production") {
    return { ok: false, reason: "production_command_in_test_guild" };
  }
  if (command.requiredRole && !userRoles.includes(command.requiredRole)) {
    return { ok: false, reason: "missing_required_role" };
  }
  return { ok: true };
}

/** @everyone/@here guard: rejected unless command allows AND operator approved. */
export function messageMentionAllowed(
  body: string,
  allowEveryoneMention: boolean,
  operatorApproved: boolean
): { ok: boolean; reason?: string } {
  const hasMass = /@everyone|@here/.test(body);
  if (!hasMass) return { ok: true };
  if (allowEveryoneMention && operatorApproved) return { ok: true };
  return { ok: false, reason: "mass_mention_not_approved" };
}

/** Token-bucket rate limit per user. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number) {}
  allow(userId: string, now = Date.now()): boolean {
    const b = this.buckets.get(userId);
    if (!b || now >= b.resetAt) {
      this.buckets.set(userId, { tokens: this.limit - 1, resetAt: now + this.windowMs });
      return true;
    }
    if (b.tokens <= 0) return false;
    b.tokens -= 1;
    return true;
  }
}

/** Idempotent interaction handling: same interaction id handled once. */
export function dedupeInteractions<T extends { id: string }>(interactions: T[]): T[] {
  const seen = new Set<string>();
  return interactions.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}
