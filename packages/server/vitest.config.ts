import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    onConsoleLog(log: string, type: "stdout" | "stderr"): boolean | void {
      throw new Error(`Unexpected console output (${type}): ${log}`);
    },
    env: {
      DATABASE_URL: ":memory:",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 70,
        lines: 85,
      },
    },
  },
});
