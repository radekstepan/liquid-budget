/**
 * App themes.
 *
 * A theme is a named set of CSS custom-property overrides, applied by
 * setting `data-theme` on `<html>` (see the `[data-theme="…"]` blocks in
 * `index.css`). New themes only need an entry here plus a matching CSS
 * block — keep {@link THEME_IDS} and the pre-paint script in
 * `apps/web/src/app/layout.tsx` in sync.
 */

export type ThemeId =
  | "classic"
  | "midnight"
  | "ocean"
  | "forest"
  | "ember"
  | "wine"
  | "mocha"
  | "graphite"
  | "onyx";

export const THEME_IDS: readonly ThemeId[] = [
  "classic",
  "midnight",
  "ocean",
  "forest",
  "ember",
  "wine",
  "mocha",
  "graphite",
  "onyx",
];

export const DEFAULT_THEME_ID: ThemeId = "classic";

/** localStorage key, following the `ynab:<area>:<pref>` convention. */
export const THEME_STORAGE_KEY = "ynab:theme:id";

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  description: string;
  /** Sidebar gradient + accent, used by the Themes settings preview cards. */
  swatches: {
    sideTop: string;
    sideBot: string;
    accent: string;
  };
};

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "classic",
    label: "Classic Blue",
    description: "The original YNAB4 cyan-blue linen.",
    swatches: { sideTop: "#2e99c7", sideBot: "#2b95c4", accent: "#2f7fb0" },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep navy sidebar with a steel-blue accent.",
    swatches: { sideTop: "#3d4f63", sideBot: "#2c3b4d", accent: "#3a6ea5" },
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep teal sidebar with a matching teal accent.",
    swatches: { sideTop: "#2a7f7c", sideBot: "#226664", accent: "#2b7a76" },
  },
  {
    id: "forest",
    label: "Forest",
    description: "Deep green sidebar with a pine accent.",
    swatches: { sideTop: "#3f7d4c", sideBot: "#356a40", accent: "#3d7a52" },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm terracotta sidebar with a clay accent.",
    swatches: { sideTop: "#8f5340", sideBot: "#7a4433", accent: "#9a5a33" },
  },
  {
    id: "wine",
    label: "Wine",
    description: "Deep burgundy sidebar with a claret accent.",
    swatches: { sideTop: "#7c3340", sideBot: "#682a36", accent: "#93343f" },
  },
  {
    id: "mocha",
    label: "Mocha",
    description: "Dark espresso sidebar with a bronze accent.",
    swatches: { sideTop: "#6b5847", sideBot: "#584739", accent: "#7a6248" },
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Neutral slate sidebar with a graphite accent.",
    swatches: { sideTop: "#5a6167", sideBot: "#484e54", accent: "#54687a" },
  },
  {
    id: "onyx",
    label: "Onyx",
    description: "Near-black sidebar with a slate accent.",
    swatches: { sideTop: "#33373c", sideBot: "#26292d", accent: "#3f4a55" },
  },
];

export function isThemeId(val: unknown): val is ThemeId {
  return (
    typeof val === "string" && (THEME_IDS as readonly string[]).includes(val)
  );
}

/** Point the document at a theme. No-op during SSR. */
export function applyThemeId(id: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = id;
}
