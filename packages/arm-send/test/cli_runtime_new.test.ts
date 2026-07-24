import { describe, expect, it } from "vitest";
import { parseArguments } from "../src/cli.js";

describe("settlement CLI argument safety", () => {
  it("defaults to dry-run and requires all artifact paths", () => {
    expect(
      parseArguments([
        "--manifest",
        "manifest.json",
        "--safety-gate",
        "gate.json",
        "--ledger",
        "sends.jsonl",
      ])
    ).toEqual({
      manifestPath: "manifest.json",
      safetyGatePath: "gate.json",
      ledgerPath: "sends.jsonl",
      executeMainnet: false,
    });
  });

  it("accepts one explicit mainnet execution flag", () => {
    expect(
      parseArguments([
        "--manifest",
        "manifest.json",
        "--safety-gate",
        "gate.json",
        "--ledger",
        "sends.jsonl",
        "--execute-mainnet",
      ]).executeMainnet
    ).toBe(true);
  });

  it.each([
    { argv: [] },
    { argv: ["--manifest", "manifest.json"] },
    { argv: ["--unknown", "value"] },
    { argv: ["--execute-mainnet", "--execute-mainnet"] },
    { argv: ["--manifest", "one", "--manifest", "two"] },
  ])("rejects incomplete or ambiguous arguments %#", ({ argv }) => {
    expect(() => parseArguments(argv)).toThrow(/usage:/);
  });
});
