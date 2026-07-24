import { describe, expect, it } from "vitest";
import { reconcileUnit, ArmReconcileIndexerStale } from "../src/reconcile.js";
import { FRY3_ASA, type SendUnit } from "../src/types.js";
import { freshChain, mockAlgod, mockIndexer } from "./mocks.js";

const unit: SendUnit = {
  deviceId: "lagging-indexer-regression",
  address: "R".repeat(58),
  asaId: FRY3_ASA,
  amountBase: 10n,
  intentId: "f".repeat(64),
};

describe("negative reconciliation requires exact indexer catch-up", () => {
  it.each([1, 2])(
    "blocks resend when accepted transaction is absent and indexer trails by %i round(s)",
    async (lag) => {
      const payer = "P".repeat(58);
      const chain = freshChain({ tip: 1_000, indexerRound: 1_000 - lag });

      await expect(
        reconcileUnit(
          unit,
          payer,
          mockAlgod(chain, payer),
          mockIndexer(chain)
        )
      ).rejects.toBeInstanceOf(ArmReconcileIndexerStale);
      expect(chain.submitted).toBe(0);
    }
  );
});
