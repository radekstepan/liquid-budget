import { describe, expect, it } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guard: native tooltips (`title=` on a DOM element) are banned. Hover hints
// must use the custom <Tooltip> from @ynab/theme. Component props named
// `title` (Modal/Notice/Panel headings, SortableTh/Pill tooltip text) are
// fine — those never render a `title` attribute.
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  path.resolve(here, "../src"),
  path.resolve(here, "../../theme/src"),
  path.resolve(here, "../../../apps/web/src"),
];

function tsxFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const TAG_LINE = /<([A-Za-z][A-Za-z0-9.]*)(?=[\s/>]|$)/;

// For a `title=` attribute, find the JSX tag it belongs to: the nearest tag
// opening at or above its line. Capitalized names are components (allowed);
// lowercase names are DOM elements (native tooltip — banned).
function ownerTag(lines: string[], lineIdx: number): string | null {
  for (let i = lineIdx; i >= Math.max(0, lineIdx - 12); i--) {
    const m = lines[i].match(TAG_LINE);
    if (m) return m[1];
  }
  return null;
}

describe("no native tooltips", () => {
  it("has no title= attributes on DOM elements", () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const file of tsxFiles(root)) {
        const src = readFileSync(file, "utf8");
        const lines = src.split("\n");
        lines.forEach((line, idx) => {
          if (/(^|[^A-Za-z-])title=(?=["'{])/.test(line)) {
            const tag = ownerTag(lines, idx);
            if (tag && tag[0] === tag[0].toLowerCase()) {
              violations.push(`${path.relative(process.cwd(), file)}:${idx + 1} (<${tag} title=...)`);
            }
          }
        });
      }
    }
    expect(violations, "native title= tooltips — wrap in <Tooltip> instead").toEqual([]);
  });
});
