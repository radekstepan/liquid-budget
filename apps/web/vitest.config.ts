import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    env: {
      DATABASE_URL: ":memory:",
    },
    onConsoleLog(log: string, type: "stdout" | "stderr"): boolean | void {
      throw new Error(`Unexpected console output (${type}): ${log}`);
    },
  },
});
