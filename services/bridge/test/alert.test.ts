import { describe, it, expect, vi } from "vitest";
import { formatAlert, sendAlert, ALERT_PREFIX, DEFAULT_USER_AGENT } from "../src/alert.js";
import type { AlarmDecision } from "../src/drift.js";

const cfg = { webhookUrl: "https://discord.example/webhook", userAgent: DEFAULT_USER_AGENT };

const alarms: AlarmDecision[] = [
  { key: "device_liveness", alarm: true, reasons: ["lag=1000000ms>900000ms"] },
  { key: "reward_dailies", alarm: false, reasons: [] },
  { key: "device_admin", alarm: true, reasons: ["mismatch_persisted=3>=3"] },
];

describe("alert: formatAlert", () => {
  it("prefixes with the drift tag and lists only firing mappings", () => {
    const msg = formatAlert(alarms, { cycle: 7 });
    expect(msg.startsWith(ALERT_PREFIX)).toBe(true);
    expect(msg).toContain("2 mapping(s) drifting (cycle 7)");
    expect(msg).toContain("device_liveness");
    expect(msg).toContain("device_admin");
    expect(msg).not.toContain("reward_dailies"); // not firing
  });
});

describe("alert: sendAlert", () => {
  it("dry-run NEVER calls the sender (pre-flip safety)", async () => {
    const send = vi.fn(
      async (_url: string, _body: string, _headers: Record<string, string>) => ({ status: 204 }),
    );
    const r = await sendAlert(cfg, "msg", send, true);
    expect(send).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: false, dryRun: true });
  });

  it("live send posts JSON with an explicit User-Agent (403 gotcha) + returns status", async () => {
    const send = vi.fn(
      async (_url: string, _body: string, headers: Record<string, string>) => {
        expect(headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
        expect(headers["Content-Type"]).toBe("application/json");
        return { status: 204 };
      },
    );
    const r = await sendAlert(cfg, "hello", send, false);
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0][1];
    expect(JSON.parse(body)).toEqual({ content: "hello" });
    expect(r).toEqual({ sent: true, dryRun: false, status: 204 });
  });
});
