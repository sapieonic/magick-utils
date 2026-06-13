// OpenTelemetry Logs SDK lifecycle for magick-utils. Logs-only — no traces,
// metrics, or auto-instrumentation. Mirrors magic-voice-core's instrumentation
// conventions: manual OTLP header parsing, forced http/protobuf (Grafana Cloud
// has no gRPC), and a service Resource. Fully gated on OTEL_ENABLED + endpoint;
// idempotent; safe to call when OTel is disabled.

import { logs } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { readFileSync } from "node:fs";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "magick-utils";

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Parse "k1=v1,k2=v2" — split on the FIRST '=' only (base64 header values contain '='). */
function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq > 0) headers[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  return headers;
}

let provider: LoggerProvider | null = null;
let shutdownHandlersInstalled = false;

/** Idempotent. No-op unless OTEL_ENABLED==='true' and an OTLP endpoint is set. */
export function initOtelLogs(): void {
  if (provider) return;

  const enabled = process.env.OTEL_ENABLED === "true";
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!enabled || !endpoint) {
    if (enabled && !endpoint) {
      console.warn("[otel] OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is not set — skipping log export");
    }
    return;
  }

  // Grafana Cloud doesn't support gRPC.
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";

  const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS || "");
  if (Object.keys(headers).length === 0) {
    console.warn("[otel] WARNING: no OTEL_EXPORTER_OTLP_HEADERS — log export will likely fail (401)");
  }

  const exporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
    headers,
  });

  provider = new LoggerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: appVersion(),
      "deployment.environment": process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || "development",
    }),
    processors: [new BatchLogRecordProcessor(exporter)],
  });

  logs.setGlobalLoggerProvider(provider);
  console.log(`[otel] log export initialized — endpoint: ${endpoint}/v1/logs`);
}

/** Flush + shut down the provider. Safe when never initialized. */
export async function shutdownOtelLogs(): Promise<void> {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch {
    // best-effort flush on shutdown
  } finally {
    provider = null;
  }
}

/**
 * Register SIGTERM/SIGINT handlers that flush + shut down log export on exit.
 * Idempotent. Lives here (a Node-only module reached only via dynamic import)
 * rather than in instrumentation.ts so Next's Edge-Runtime static scanner never
 * sees `process.on` — keeping the edge bundle clean without any `as any` casts.
 */
export function installLogShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  process.on("SIGTERM", () => void shutdownOtelLogs());
  process.on("SIGINT", () => void shutdownOtelLogs());
}
