import { describe, it, expect } from "vitest";
import {
  classifyOnlineState,
  isClockSkewAcceptable,
  validateHeartbeatEnvelope,
} from "../src/online-state";
import { DeviceStatus } from "@fry3/reward-policy";

const now = new Date("2026-07-19T12:00:00.000Z");

describe("classifyOnlineState", () => {
  it("banned -> BANNED regardless of heartbeat", () => {
    expect(classifyOnlineState({ lastHeartbeatAt: now, banned: true, disabled: false, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.BANNED);
  });
  it("disabled -> DISABLED", () => {
    expect(classifyOnlineState({ lastHeartbeatAt: now, banned: false, disabled: true, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.DISABLED);
  });
  it("never seen -> OFFLINE", () => {
    expect(classifyOnlineState({ lastHeartbeatAt: null, banned: false, disabled: false, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.OFFLINE);
  });
  it("recent heartbeat -> ONLINE", () => {
    const hb = new Date(now.getTime() - 100 * 1000);
    expect(classifyOnlineState({ lastHeartbeatAt: hb, banned: false, disabled: false, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.ONLINE);
  });
  it("aged past threshold -> DEGRADED", () => {
    const hb = new Date(now.getTime() - 400 * 1000);
    expect(classifyOnlineState({ lastHeartbeatAt: hb, banned: false, disabled: false, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.DEGRADED);
  });
  it("very old -> OFFLINE", () => {
    const hb = new Date(now.getTime() - 5000 * 1000);
    expect(classifyOnlineState({ lastHeartbeatAt: hb, banned: false, disabled: false, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.OFFLINE);
  });
  it("boundary exactly at threshold -> ONLINE", () => {
    const hb = new Date(now.getTime() - 300 * 1000);
    expect(classifyOnlineState({ lastHeartbeatAt: hb, banned: false, disabled: false, now, onlineThresholdSeconds: 300 })).toBe(DeviceStatus.ONLINE);
  });
});

describe("clock skew", () => {
  it("future heartbeat beyond skew -> rejected", () => {
    const future = new Date(now.getTime() + 200 * 1000);
    expect(isClockSkewAcceptable(future, now, 120)).toBe(false);
  });
  it("within skew -> accepted", () => {
    const near = new Date(now.getTime() + 60 * 1000);
    expect(isClockSkewAcceptable(near, now, 120)).toBe(true);
  });
  it("no reportedAt -> accepted (nothing to validate)", () => {
    expect(isClockSkewAcceptable(null, now, 120)).toBe(true);
  });
});

describe("validateHeartbeatEnvelope", () => {
  const base = { deviceId: "d1", receivedAt: now, nonce: "abcdefgh12345678", signature: "sig" };
  it("valid", () => {
    expect(validateHeartbeatEnvelope(base, now).ok).toBe(true);
  });
  it("missing device id", () => {
    expect(validateHeartbeatEnvelope({ ...base, deviceId: "" }, now).reason).toBe("missing_device_id");
  });
  it("short nonce", () => {
    expect(validateHeartbeatEnvelope({ ...base, nonce: "abc" }, now).reason).toBe("invalid_nonce");
  });
  it("missing signature", () => {
    expect(validateHeartbeatEnvelope({ ...base, signature: "" }, now).reason).toBe("missing_signature");
  });
  it("future skew", () => {
    const hb = { ...base, reportedAt: new Date(now.getTime() + 500 * 1000) };
    expect(validateHeartbeatEnvelope(hb, now).reason).toBe("clock_skew_exceeded");
  });
});
