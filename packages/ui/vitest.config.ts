import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    onConsoleLog(log: string, type: "stdout" | "stderr"): boolean | void {
      throw new Error(`Unexpected console output (${type}): ${log}`);
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // TODO(P2) [test-bar]: raise functions threshold 50->70 and cover BudgetView/BudgetApp/
      // SpendingTrends branches directly — E2E happy paths can't bisect CC-waterfall regressions.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 50,
        lines: 85,
      },
    },
  },
});
