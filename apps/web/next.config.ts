import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TODO(P2) [toolchain]: document why build uses `next build --webpack` (better-sqlite3 bundling?)
  // vs Turbopack on Next 16; remove flag if not deliberate. See apps/web/package.json build script.
  transpilePackages: ["@ynab/logic", "@ynab/server", "@ynab/ui", "@ynab/theme"],
};

export default nextConfig;
