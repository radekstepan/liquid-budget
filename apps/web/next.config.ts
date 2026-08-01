import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ynab/logic", "@ynab/server", "@ynab/ui", "@ynab/theme"],
};

export default nextConfig;
