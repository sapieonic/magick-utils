// Application logger for magick-utils server code. Pino with a main-thread
// multistream: stdout (pretty in dev / JSON in prod) plus, when OTel is enabled,
// an OTel sink that exports each line to Grafana via OTLP. Server-only.

import pino from "pino";
import pretty from "pino-pretty";
import { initOtelLogs } from "./observability/otel-logs";
import { createOtelSink } from "./observability/otel-pino-sink";

const isProduction = process.env.NODE_ENV === "production";
const otelEnabled =
  process.env.OTEL_ENABLED === "true" && Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
const level = (process.env.LOG_LEVEL || "info") as pino.LevelWithSilent;

// Ensure the global LoggerProvider exists before any line hits the OTel sink —
// idempotent, so instrumentation.register() calling it again is harmless.
if (otelEnabled) initOtelLogs();

function buildStreams(): pino.StreamEntry<pino.LevelWithSilent>[] {
  const stdout: pino.StreamEntry<pino.LevelWithSilent> = isProduction
    ? { level, stream: process.stdout }
    : { level, stream: pretty({ colorize: true }) };

  const streams: pino.StreamEntry<pino.LevelWithSilent>[] = [stdout];
  if (otelEnabled) streams.push({ level, stream: createOtelSink() });
  return streams;
}

// Secret-bearing fields that must never reach stdout or log storage. magick-utils
// carries Firebase `idToken` on jobs/contexts and may log request headers.
// Note: "*.idToken" matches one nesting level only (pino wildcards are single-segment);
// deeper paths like context.job.idToken are not covered.
export const REDACT_PATHS = [
  "idToken",
  "*.idToken",
  "headers.authorization",
  'headers["x-api-key"]',
  "req.headers.authorization",
  'req.headers["x-api-key"]',
];

export const logger = pino(
  {
    level,
    // Service version is attached as an OTel Resource attribute in otel-logs.ts,
    // so it doesn't need to repeat on every line.
    base: { service: "magick-utils" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { err: pino.stdSerializers.err },
  },
  pino.multistream(buildStreams()),
);

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
