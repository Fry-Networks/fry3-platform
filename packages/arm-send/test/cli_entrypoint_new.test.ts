import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

describe("production settlement CLI", () => {
  it("exposes one composed executable instead of README-only orchestration", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8")
    );

    expect(pkg.bin).toMatchObject({
      "fry3-settlement": "./dist/cli.js",
    });
    expect(pkg.scripts).toMatchObject({
      build: "tsc -p tsconfig.json",
      settlement: "node dist/cli.js",
    });
    expect(existsSync(resolve(packageRoot, "src/cli.ts"))).toBe(true);
  });
});
