import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deliberate: API routes bundle @ynab/server (transpilePackages, not
  // serverExternalPackages), whose better-sqlite3 dependency is a native
  // `.node` binding that Turbopack (the Next 16 default) cannot bundle.
  // See docs/toolchain-adr.md item 2; drop the flag only with a
  // stdlib-only sqlite driver or an externalized server.
  transpilePackages: ["@ynab/logic", "@ynab/server", "@ynab/ui", "@ynab/theme"],
};

export default nextConfig;
