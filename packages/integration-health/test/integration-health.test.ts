import { describe, it, expect } from "vitest";
import { effectiveHealth, verifiedHealthySet, HealthEvidence } from "../src/index";
import { IntegrationKind } from "@fry3/reward-policy";

const now = new Date("2026-07-19T12:00:00.000Z");
const ev = (over: Partial<HealthEvidence>): HealthEvidence => ({
  integration: IntegrationKind.STORJ,
  healthy: true,
  evidenceAt: now,
  evidenceType: "telemetry",
  ...over,
});

describe("effectiveHealth", () => {
  it("no evidence -> unhealthy", () => {
    expect(effectiveHealth(null, now).healthy).toBe(false);
  });
  it("fresh healthy telemetry -> healthy", () => {
    expect(effectiveHealth(ev({}), now).healthy).toBe(true);
  });
  it("stale evidence -> unhealthy", () => {
    const old = ev({ evidenceAt: new Date(now.getTime() - 1000 * 1000) });
    expect(effectiveHealth(old, now, 600).reason).toBe("stale_evidence");
  });
  it("reported unhealthy -> unhealthy", () => {
    expect(effectiveHealth(ev({ healthy: false }), now).reason).toBe("reported_unhealthy");
  });
  it("config toggle with no telemetry counts as no_evidence", () => {
    expect(effectiveHealth(null, now).reason).toBe("no_evidence");
  });
});

describe("verifiedHealthySet", () => {
  it("includes only fresh healthy", () => {
    const list: HealthEvidence[] = [
      ev({ integration: IntegrationKind.STORJ, healthy: true }),
      ev({ integration: IntegrationKind.BANDWIDTH, healthy: false }),
      ev({ integration: IntegrationKind.COMPUTE, healthy: true, evidenceAt: new Date(now.getTime() - 5000 * 1000) }),
    ];
    const set = verifiedHealthySet(list, now, 600);
    expect(set.has(IntegrationKind.STORJ)).toBe(true);
    expect(set.has(IntegrationKind.BANDWIDTH)).toBe(false);
    expect(set.has(IntegrationKind.COMPUTE)).toBe(false); // stale
  });
  it("uses most recent evidence per integration", () => {
    const list: HealthEvidence[] = [
      ev({ integration: IntegrationKind.STORJ, healthy: false, evidenceAt: new Date(now.getTime() - 100 * 1000) }),
      ev({ integration: IntegrationKind.STORJ, healthy: true, evidenceAt: now }),
    ];
    const set = verifiedHealthySet(list, now, 600);
    expect(set.has(IntegrationKind.STORJ)).toBe(true);
  });
});
