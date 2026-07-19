import { defineConfig } from "vitest/config";
import path from "path";
const P = path.resolve(__dirname, "../../packages");
const S = path.resolve(__dirname, "../../services");
export default defineConfig({
  resolve: { alias: {
    "@fry3/reward-policy": path.join(P, "reward-policy/src/index.ts"),
    "@fry3/integration-health": path.join(P, "integration-health/src/index.ts"),
    "@fry3/heartbeat-ingest": path.join(S, "heartbeat-ingest/src/online-state.ts"),
    "@fry3/claim-dispatcher": path.join(S, "claim-dispatcher/src/claim.ts"),
  }},
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
