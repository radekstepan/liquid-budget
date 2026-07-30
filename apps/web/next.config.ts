import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ynab/logic", "@ynab/server", "@ynab/ui"],
};

export default nextConfig;
