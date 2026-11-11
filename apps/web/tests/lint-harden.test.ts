import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../../..", import.meta.url);

function read(rel: string): string {
  return readFileSync(new URL(rel, REPO_ROOT), "utf8");
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walkTs(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

describe("P2 lint-harden subset: enforceable rules are pinned in config", () => {
  const config = read("eslint.config.mjs");

  it("enforces consistent-type-imports (import() annotations exempt)", () => {
    expect(config).toContain("@typescript-eslint/consistent-type-imports");
    expect(config).toContain("disallowTypeAnnotations");
  });

  it("enforces eqeqeq with the null idiom allowed", () => {
    expect(config).toContain("eqeqeq");
    expect(config).toContain('null: "ignore"');
  });

  it("bans console outside the funnel, scripts, and tests", () => {
    expect(config).toContain('"no-console": "error"');
    expect(config).toContain("apps/web/src/lib/logger.ts");
  });

  it("previously dead code stays removed", () => {
    const engine = read("packages/logic/src/budget-engine.ts");
    expect(engine).not.toMatch(/^import type \{[^}]*\bCategory\b/m);
    const search = read("packages/server/src/queries/search.ts");
    // buildSearchWhere's unused `pre` is gone; rankParams' used one remains.
    expect(search.match(/const pre = `\$\{escapeLike\(qn\)\}%`;/g)).toHaveLength(1);
  });

  it("type-only value imports use import type", () => {
    expect(read("apps/web/src/app/api/export/route.ts")).toContain(
      "import type { NextRequest }"
    );
    expect(read("packages/server/src/queries/transactions/types.ts")).toContain(
      "import type { transactions }"
    );
    expect(read("packages/server/src/schema.ts")).toContain(
      "import type { AnySQLiteColumn }"
    );
  });
});

describe("P2 lint-harden subset: no-console funnel holds for all web src", () => {
  const srcDir = new URL("../src", import.meta.url);
  const files = [...walkTs(srcDir.pathname)].filter(
    (f) => !f.endsWith("lib/logger.ts")
  );
  expect(files.length).toBeGreaterThan(0);

  it.each(files.map((f) => [f.replace(`${srcDir.pathname}/`, "")] as [string]))(
    "%s has no direct console.* calls",
    (rel) => {
      const src = readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/\bconsole\.(debug|info|warn|error|log)\b/);
    }
  );
});
