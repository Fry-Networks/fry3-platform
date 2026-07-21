import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: {
    alias: {
      "@fry3/reward-policy": path.resolve(__dirname, "../../packages/reward-policy/src/index.ts"),
      "@fry3/integration-health": path.resolve(__dirname, "../../packages/integration-health/src/index.ts"),
    },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
