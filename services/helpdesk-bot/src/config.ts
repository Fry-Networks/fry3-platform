/**
 * Helpdesk bot runtime config — env-driven, fail-fast, single-guild allowlist.
 * P6 wiring is TEST token + TEST guild ONLY (prod tokens forbidden until P9d);
 * the allowlist is the containment: any event from another guild is refused.
 */
export interface HelpdeskConfig {
  token: string;
  guildId: string;
  ticketsCategoryId: string;
  guildIsProduction: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): HelpdeskConfig {
  const req = (k: string): string => {
    const v = env[k];
    if (v === undefined || v.trim() === "") throw new Error(`missing_env:${k}`);
    return v.trim();
  };
  return {
    token: req("DISCORD_TOKEN"),
    guildId: req("FRY3_GUILD_ID"),
    ticketsCategoryId: req("FRY3_TICKETS_CATEGORY_ID"),
    guildIsProduction: req("FRY3_GUILD_IS_PRODUCTION") === "1",
  };
}

/** Single-guild allowlist: the bot acts ONLY inside its configured guild. */
export function guildAllowed(guildId: string, cfg: Pick<HelpdeskConfig, "guildId">): boolean {
  return guildId !== "" && guildId === cfg.guildId;
}
