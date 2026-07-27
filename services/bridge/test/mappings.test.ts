import { describe, it, expect } from "vitest";
import {
  MAPPINGS,
  findWriteLoops,
  assertNoWriteLoop,
  mappingByKey,
  type FieldMapping,
} from "../src/mappings.js";

describe("mappings: field-ownership contract", () => {
  it("ships the seven design mappings (4 PG-owned, 3 Mongo-owned)", () => {
    expect(MAPPINGS).toHaveLength(7);
    expect(MAPPINGS.filter((m) => m.direction === "PG_TO_MONGO")).toHaveLength(4);
    expect(MAPPINGS.filter((m) => m.direction === "MONGO_TO_PG")).toHaveLength(3);
  });

  it("owner store always equals the source store of the direction", () => {
    for (const m of MAPPINGS) {
      expect(m.owner).toBe(m.direction === "PG_TO_MONGO" ? "PG" : "MONGO");
    }
  });

  it("has ZERO write loops (each field synced in exactly one direction)", () => {
    expect(findWriteLoops()).toEqual([]);
    expect(() => assertNoWriteLoop()).not.toThrow();
  });

  it("detects a write loop when a field is claimed in both directions", () => {
    const bad: FieldMapping[] = [
      {
        key: "a",
        direction: "PG_TO_MONGO",
        owner: "PG",
        source: "s",
        target: "t",
        keyBy: "k",
        fields: ["banned"],
        description: "",
      },
      {
        key: "b",
        direction: "MONGO_TO_PG",
        owner: "MONGO",
        source: "s2",
        target: "t2",
        keyBy: "k",
        fields: ["banned"],
        description: "",
      },
    ];
    expect(findWriteLoops(bad)).toEqual(["banned"]);
    expect(() => assertNoWriteLoop(bad)).toThrow(/bridge_write_loop:banned/);
  });

  it("carries the design's owned fields on the right side", () => {
    expect(mappingByKey("device_liveness")?.fields).toContain("last_heartbeat_at");
    expect(mappingByKey("blacklist_ban")?.fields).toEqual(["banned"]);
    expect(mappingByKey("device_admin")?.fields).toContain("multiplier");
    // gap-b: device token is NOT bridged
    const allFields = MAPPINGS.flatMap((m) => m.fields);
    expect(allFields).not.toContain("device_token");
    expect(allFields).not.toContain("deviceTokenHash");
  });

  it("every mapping has a unique key", () => {
    const keys = MAPPINGS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
