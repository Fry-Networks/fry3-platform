/**
 * Bot runtime config — env-driven, fail-fast, single-guild allowlist.
 * P6 wiring is TEST token + TEST guild ONLY (prod tokens forbidden until P9d);
 * the allowlist is the containment: any event from another guild is refused.
 */
export interface BotConfig {
  token: string;
  guildId: string;
  announceChannelId: string;
  guildIsProduction: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): BotConfig {
  const req = (k: string): string => {
    const v = env[k];
    if (v === undefined || v.trim() === "") throw new Error(`missing_env:${k}`);
    return v.trim();
  };
  return {
    token: req("DISCORD_TOKEN"),
    guildId: req("FRY3_GUILD_ID"),
    announceChannelId: req("FRY3_ANNOUNCE_CHANNEL_ID"),
    guildIsProduction: req("FRY3_GUILD_IS_PRODUCTION") === "1",
  };
}

/** Single-guild allowlist: the bot acts ONLY inside its configured guild. */
export function guildAllowed(guildId: string, cfg: Pick<BotConfig, "guildId">): boolean {
  return guildId !== "" && guildId === cfg.guildId;
}
