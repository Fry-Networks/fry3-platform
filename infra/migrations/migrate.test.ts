import { describe, it, expect } from "vitest";
import {
  dedupeUsersByEmail,
  deviceCanonicalId,
  filterAlreadyMigrated,
  provenanceKey,
  reconcile,
  reconcileAmounts,
} from "./migrate";
import { createHash } from "crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("dedupeUsersByEmail (R1)", () => {
  it("keeps lowest createdAt, logs repair", () => {
    const docs = [
      { _id: "1", email: "a@x.com", createdAt: "2026-01-02" },
      { _id: "2", email: "a@x.com", createdAt: "2026-01-01" },
    ];
    const { kept, repairs } = dedupeUsersByEmail(docs);
    expect(kept).toHaveLength(1);
    expect(kept[0]._id).toBe("2"); // older
    expect(repairs).toHaveLength(1);
    expect(repairs[0].rule).toBe("R1");
  });
  it("no duplicates -> no repairs", () => {
    const { kept, repairs } = dedupeUsersByEmail([{ _id: "1", email: "a@x.com" }]);
    expect(kept).toHaveLength(1);
    expect(repairs).toHaveLength(0);
  });
});

describe("deviceCanonicalId (R3)", () => {
  it("uses fem_key_map entry when present", () => {
    expect(deviceCanonicalId("mk", "canonical-1", sha256).canonicalId).toBe("canonical-1");
    expect(deviceCanonicalId("mk", "canonical-1", sha256).flagged).toBe(false);
  });
  it("falls back to sha256(minerKey), flagged", () => {
    const r = deviceCanonicalId("minerkey1", null, sha256);
    expect(r.canonicalId).toBe(sha256("minerkey1"));
    expect(r.flagged).toBe(true);
  });
});

describe("idempotent migration", () => {
  const docs = [
    { sourceDb: "main", sourceCollection: "devices", sourceId: "1", doc: {} },
    { sourceDb: "main", sourceCollection: "devices", sourceId: "2", doc: {} },
  ];
  it("provenanceKey stable", () => {
    expect(provenanceKey(docs[0])).toBe("main|devices|1");
  });
  it("skips already-migrated", () => {
    const migrated = new Set(["main|devices|1"]);
    const out = filterAlreadyMigrated(docs, migrated);
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe("2");
  });
});

describe("reconcile", () => {
  it("all exact", () => {
    const r = reconcile([{ entity: "devices", sourceCount: 19980, targetCount: 19980, exact: true }]);
    expect(r.allExact).toBe(true);
    expect(r.mismatches).toHaveLength(0);
  });
  it("detects mismatch", () => {
    const r = reconcile([{ entity: "devices", sourceCount: 19980, targetCount: 19979, exact: false }]);
    expect(r.allExact).toBe(false);
    expect(r.mismatches).toHaveLength(1);
  });
});

describe("reconcileAmounts (integer base-units)", () => {
  it("exact sums", () => {
    const r = reconcileAmounts(["100", "200"], ["150", "150"]);
    expect(r.exact).toBe(true);
    expect(r.sourceSum).toBe(300n);
  });
  it("detects diff", () => {
    expect(reconcileAmounts(["100"], ["99"]).exact).toBe(false);
  });
});
