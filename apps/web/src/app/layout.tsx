import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Budget - Liquid",
  description: "A zero-based envelope budgeting app. A YNAB4 alternative.",
};

/**
 * Applies the stored theme before first paint so the sidebar never flashes
 * the default. Mirrors the ids in `packages/theme/src/themes.ts` (kept as a
 * static string so it can run synchronously during parsing).
 */
const THEME_INIT_SCRIPT = `!function(){try{var v=null;try{v=JSON.parse(localStorage.getItem("ynab:theme:id")||"null")}catch(e){}if(v==="classic"||v==="midnight"||v==="ocean"||v==="forest"||v==="ember"||v==="wine"||v==="mocha"||v==="graphite"||v==="onyx"){document.documentElement.setAttribute("data-theme",v)}}catch(e){}}();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint script above sets data-theme
    // on <html> before React hydrates, so the client attribute intentionally
    // differs from the server HTML (same pattern next-themes recommends).
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
