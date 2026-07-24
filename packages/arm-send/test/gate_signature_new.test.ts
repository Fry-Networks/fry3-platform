import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import {
  MainnetGateError,
  REQUIRED_MAINNET_PREDICATES,
  signMainnetSafetyGate,
  verifyMainnetSafetyGate,
  type UnsignedMainnetSafetyGate,
} from "../src/driver.js";

function unsignedGate(): UnsignedMainnetSafetyGate {
  return {
    version: 1,
    runId: "p9final_1784868963",
    batchId: "p9final_1784868963",
    manifestSha256: "a".repeat(64),
    observedAt: "2026-07-24T04:30:00.000Z",
    expiresAt: "2026-07-24T04:35:00.000Z",
    predicates: Object.fromEntries(
      REQUIRED_MAINNET_PREDICATES.map((predicate) => [predicate, true])
    ) as UnsignedMainnetSafetyGate["predicates"],
  };
}

describe("signed mainnet safety gate", () => {
  it("verifies gate signed by active transaction signer", () => {
    const signer = algosdk.generateAccount();
    const gate = signMainnetSafetyGate(unsignedGate(), signer.addr, signer.sk);

    expect(() => verifyMainnetSafetyGate(gate, signer.addr)).not.toThrow();
  });

  it("rejects predicate tampering after signature", () => {
    const signer = algosdk.generateAccount();
    const gate = signMainnetSafetyGate(unsignedGate(), signer.addr, signer.sk);
    const tampered = {
      ...gate,
      predicates: { ...gate.predicates, exactClaimResolution: false },
    };

    expect(() => verifyMainnetSafetyGate(tampered, signer.addr)).toThrow(
      MainnetGateError
    );
  });

  it("rejects a valid signature from the wrong signer", () => {
    const signer = algosdk.generateAccount();
    const wrong = algosdk.generateAccount();
    const gate = signMainnetSafetyGate(unsignedGate(), wrong.addr, wrong.sk);

    expect(() => verifyMainnetSafetyGate(gate, signer.addr)).toThrow(
      MainnetGateError
    );
  });
});
