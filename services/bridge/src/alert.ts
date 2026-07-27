/**
 * Tooth B (R3) — drift alarm alert route: Discord webhook.
 *
 * Decision (contracts/toothB-bridge-design.md): alert route = Discord webhook
 * (op://dbRewards/DISCORD_WEBHOOK_URL). Message prefix `[FRY3-BRIDGE-DRIFT]`.
 * An explicit User-Agent is REQUIRED — urllib/undici default UA gets a 403 on
 * Discord webhooks (known Fry gotcha, feedback_discord_webhook_user_agent).
 *
 * The sender is injected so the unit gate never touches the network and the
 * pre-flip dry-run path provably sends nothing.
 */

import type { AlarmDecision } from "./drift.js";

export const ALERT_PREFIX = "[FRY3-BRIDGE-DRIFT]";
export const DEFAULT_USER_AGENT = "fry3-bridge-drift-monitor/1.0 (+fry-networks)";

export interface AlertConfig {
  webhookUrl: string;
  userAgent: string;
}

/** Build the Discord message content string from the alarming mappings. */
export function formatAlert(alarms: AlarmDecision[], meta: { cycle: number }): string {
  const firing = alarms.filter((a) => a.alarm);
  const lines = firing.map((a) => `• ${a.key}: ${a.reasons.join(", ")}`);
  return [
    `${ALERT_PREFIX} ${firing.length} mapping(s) drifting (cycle ${meta.cycle})`,
    ...lines,
  ].join("\n");
}

/** Minimal injectable HTTP sender — real impl posts JSON to the webhook. */
export interface WebhookSender {
  (url: string, body: string, headers: Record<string, string>): Promise<{ status: number }>;
}

export interface SendResult {
  sent: boolean;
  dryRun: boolean;
  status?: number;
}

/**
 * Post the alert. In dryRun mode the sender is NEVER called (pre-flip safety):
 * live Mongo/Discord side effects only start at the P9c flip.
 */
export async function sendAlert(
  cfg: AlertConfig,
  message: string,
  send: WebhookSender,
  dryRun: boolean,
): Promise<SendResult> {
  if (dryRun) return { sent: false, dryRun: true };
  const body = JSON.stringify({ content: message });
  const res = await send(cfg.webhookUrl, body, {
    "Content-Type": "application/json",
    "User-Agent": cfg.userAgent, // explicit — default UA → 403
  });
  return { sent: true, dryRun: false, status: res.status };
}
