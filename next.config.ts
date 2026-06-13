import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the production
  // Docker image only needs the traced runtime files — not the full node_modules.
  output: "standalone",

  // Keep these external (required from node_modules at runtime) rather than
  // bundled — pino and the OTel logs SDK use dynamic requires / Node APIs that
  // break when webpack/turbopack bundles them.
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "@opentelemetry/sdk-logs",
    "@opentelemetry/exporter-logs-otlp-proto",
    "@opentelemetry/api-logs",
    "@opentelemetry/resources",
    "@opentelemetry/semantic-conventions",
  ],
};

export default nextConfig;
