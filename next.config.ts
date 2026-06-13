import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the production
  // Docker image only needs the traced runtime files — not the full node_modules.
  output: "standalone",
};

export default nextConfig;
