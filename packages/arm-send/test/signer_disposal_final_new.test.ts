import { describe, expect, it } from "vitest";
import type algosdk from "algosdk";
import { makeSkSigner } from "../src/adapters.js";
import * as cliModule from "../src/cli.js";
import type { Signer } from "../src/types.js";

interface DisposableSigner extends Signer {
  dispose(): void;
}

type RunWithSignerCleanup = <T>(
  signer: Signer,
  guardAuthenticationKey: Uint8Array | undefined,
  action: () => Promise<T>
) => Promise<T>;

function cleanupRunner(): RunWithSignerCleanup {
  const candidate = (cliModule as Record<string, unknown>).runWithSignerCleanup;
  expect(candidate).toBeTypeOf("function");
  return candidate as RunWithSignerCleanup;
}

describe("signing key lifecycle", () => {
  it("zeroes and detaches the secret key when a signer is disposed", () => {
    const secretKey = new Uint8Array(64).fill(9);
    const signer = makeSkSigner("A".repeat(58), secretKey) as DisposableSigner;
    const unsigned = {
      signTxn(key: Uint8Array) {
        expect(key).toBe(secretKey);
        return new Uint8Array([1]);
      },
    } as unknown as algosdk.Transaction;

    expect(signer.sign(unsigned)).toEqual(new Uint8Array([1]));
    expect(signer.dispose).toBeTypeOf("function");
    signer.dispose();

    expect(secretKey.every((value) => value === 0)).toBe(true);
    expect(() => signer.sign(unsigned)).toThrow(/disposed/i);
    expect(() => signer.dispose()).not.toThrow();
  });

  it.each(["success", "failure"] as const)(
    "disposes signer and guard key after CLI action %s",
    async (outcome) => {
      let disposeCalls = 0;
      const signer: Signer = {
        address: "A".repeat(58),
        sign() {
          return new Uint8Array();
        },
        dispose() {
          disposeCalls += 1;
        },
      };
      const guardKey = new Uint8Array(32).fill(7);
      const action = async () => {
        if (outcome === "failure") throw new Error("expected failure");
        return "done";
      };
      const runWithSignerCleanup = cleanupRunner();

      if (outcome === "failure") {
        await expect(
          runWithSignerCleanup(signer, guardKey, action)
        ).rejects.toThrow("expected failure");
      } else {
        await expect(
          runWithSignerCleanup(signer, guardKey, action)
        ).resolves.toBe("done");
      }

      expect(disposeCalls).toBe(1);
      expect(guardKey.every((value) => value === 0)).toBe(true);
    }
  );
});
