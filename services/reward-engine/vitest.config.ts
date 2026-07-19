import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: { alias: { "@fry3/reward-policy": path.resolve(__dirname, "../../packages/reward-policy/src/index.ts") } },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
