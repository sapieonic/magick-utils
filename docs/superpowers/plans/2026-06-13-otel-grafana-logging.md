# OTel → Grafana Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured Pino logger to magick-utils whose log records are exported to Grafana Cloud via OpenTelemetry (OTLP/logs), and migrate existing server-side `console.*` calls to it.

**Architecture:** Logs-only OTel. A main-thread `LoggerProvider` (`@opentelemetry/sdk-logs` + `OTLPLogExporter` proto) is initialized in Next's `instrumentation.ts`. A Pino logger writes to a `pino.multistream` with two destinations: stdout (pretty in dev, JSON in prod) and a custom main-thread `Writable` sink that converts each Pino log line into an OTel `LogRecord` and `emit()`s it. No worker-thread transports (avoids Next.js `output: "standalone"` bundling breakage). Fully gated on `OTEL_ENABLED` + endpoint; degrades to stdout-only when off.

**Tech Stack:** Next.js 16, TypeScript (strict, ESM, `moduleResolution: bundler`), Pino 10, `@opentelemetry/{api-logs,sdk-logs,exporter-logs-otlp-proto,resources,semantic-conventions}` (0.219.0 / 2.8.0 / 1.41.1 lines), vitest.

**Reference (do not modify):** core's `magic-voice-core/src/instrumentation.ts` (header parse, protocol forcing, resource attrs) and `magic-voice-core/src/utils/logger.ts` (Pino shape).

**Working branch:** `feat/otel-grafana-logging` (already created; spec committed there).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/server/observability/otel-pino-sink.ts` | Pure Pino-line → OTel-LogRecord mapping + the `Writable` sink that emits to the global OTel logger |
| `lib/server/observability/otel-logs.ts` | OTel Logs SDK lifecycle: build/register `LoggerProvider`, flush/shutdown |
| `lib/server/logger.ts` | The app Pino logger (multistream, redact, base fields, child helper) |
| `instrumentation.ts` (edit) | Init OTel logs + register shutdown at server start; `console.*` → logger |
| `lib/server/worker.ts` (edit) | `console.*` → logger |
| `next.config.ts` (edit) | `serverExternalPackages` for pino + otel packages |
| `.env.example` (edit/create) | `OTEL_*` / `LOG_LEVEL` documentation block |
| `package.json` (edit) | Add runtime deps |
| `tests/lib/server/otel-pino-sink.test.ts` | Unit test for the pure mapper |

---

## Task 1: Add dependencies

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install runtime dependencies**

Run from `/Users/manasnilorout/Personal/Sapionic/magick-utils`:

```bash
npm install \
  pino@^10.3.1 \
  pino-pretty@^13.1.3 \
  @opentelemetry/api-logs@^0.219.0 \
  @opentelemetry/sdk-logs@^0.219.0 \
  @opentelemetry/exporter-logs-otlp-proto@^0.219.0 \
  @opentelemetry/resources@^2.8.0 \
  @opentelemetry/semantic-conventions@^1.41.1
```

- [ ] **Step 2: Verify they landed in `dependencies`**

Run: `node -e "const d=require('./package.json').dependencies; console.log(['pino','pino-pretty','@opentelemetry/api-logs','@opentelemetry/sdk-logs','@opentelemetry/exporter-logs-otlp-proto','@opentelemetry/resources','@opentelemetry/semantic-conventions'].map(k=>k+'='+ (d[k]||'MISSING')).join('\n'))"`
Expected: every line shows a version, none say `MISSING`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add pino + opentelemetry logs dependencies"
```

---

## Task 2: Pino → OTel LogRecord sink (TDD)

The pure mapper is the only piece with real logic, so it's covered by a unit test first.

**Files:**
- Create: `lib/server/observability/otel-pino-sink.ts`
- Test: `tests/lib/server/otel-pino-sink.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/server/otel-pino-sink.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { pinoLineToLogRecord } from "@/lib/server/observability/otel-pino-sink";

describe("pinoLineToLogRecord", () => {
  it("maps each pino level to the right OTel severity", () => {
    const cases: Array<[number, SeverityNumber, string]> = [
      [10, SeverityNumber.TRACE, "TRACE"],
      [20, SeverityNumber.DEBUG, "DEBUG"],
      [30, SeverityNumber.INFO, "INFO"],
      [40, SeverityNumber.WARN, "WARN"],
      [50, SeverityNumber.ERROR, "ERROR"],
      [60, SeverityNumber.FATAL, "FATAL"],
    ];
    for (const [level, num, text] of cases) {
      const rec = pinoLineToLogRecord({ level, msg: "x", time: "2026-06-13T00:00:00.000Z" });
      expect(rec.severityNumber).toBe(num);
      expect(rec.severityText).toBe(text);
    }
  });

  it("defaults unknown levels to INFO", () => {
    const rec = pinoLineToLogRecord({ level: 99, msg: "x", time: "2026-06-13T00:00:00.000Z" });
    expect(rec.severityNumber).toBe(SeverityNumber.INFO);
    expect(rec.severityText).toBe("INFO");
  });

  it("uses msg as the body and parses time into an epoch-ms timestamp", () => {
    const rec = pinoLineToLogRecord({ level: 30, msg: "hello world", time: "2026-06-13T00:00:00.000Z" });
    expect(rec.body).toBe("hello world");
    expect(rec.timestamp).toBe(Date.parse("2026-06-13T00:00:00.000Z"));
  });

  it("routes remaining fields into attributes and excludes reserved keys", () => {
    const rec = pinoLineToLogRecord({
      level: 30,
      msg: "m",
      time: "2026-06-13T00:00:00.000Z",
      pid: 123,
      hostname: "box",
      jobId: "j-1",
      service: "magick-utils",
    });
    expect(rec.attributes).toEqual({ jobId: "j-1", service: "magick-utils" });
    expect(rec.attributes).not.toHaveProperty("level");
    expect(rec.attributes).not.toHaveProperty("time");
    expect(rec.attributes).not.toHaveProperty("msg");
    expect(rec.attributes).not.toHaveProperty("pid");
    expect(rec.attributes).not.toHaveProperty("hostname");
  });

  it("JSON-stringifies nested object/array attribute values", () => {
    const rec = pinoLineToLogRecord({
      level: 50,
      msg: "boom",
      time: "2026-06-13T00:00:00.000Z",
      err: { message: "nope", code: 7 },
      tags: ["a", "b"],
    });
    expect(rec.attributes.err).toBe(JSON.stringify({ message: "nope", code: 7 }));
    expect(rec.attributes.tags).toBe(JSON.stringify(["a", "b"]));
  });

  it("falls back to an empty body when msg is absent", () => {
    const rec = pinoLineToLogRecord({ level: 30, time: "2026-06-13T00:00:00.000Z" });
    expect(rec.body).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/server/otel-pino-sink.test.ts`
Expected: FAIL — cannot resolve `@/lib/server/observability/otel-pino-sink` (module doesn't exist yet).

- [ ] **Step 3: Implement the sink module**

Create `lib/server/observability/otel-pino-sink.ts`:

```ts
// Pino → OpenTelemetry bridge that runs on the MAIN THREAD (no worker-thread
// transport — that breaks under Next.js `output: "standalone"`). The pure mapper
// is unit-tested; `createOtelSink` is thin glue over the global Logs API.

import { Writable } from "node:stream";
import { logs, SeverityNumber, type AnyValue } from "@opentelemetry/api-logs";

const LOGGER_NAME = "magick-utils";

// Pino numeric level → OTel severity. Unknown levels fall back to INFO.
const SEVERITY: Record<number, { number: SeverityNumber; text: string }> = {
  10: { number: SeverityNumber.TRACE, text: "TRACE" },
  20: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  30: { number: SeverityNumber.INFO, text: "INFO" },
  40: { number: SeverityNumber.WARN, text: "WARN" },
  50: { number: SeverityNumber.ERROR, text: "ERROR" },
  60: { number: SeverityNumber.FATAL, text: "FATAL" },
};

// Keys that carry Pino bookkeeping, not business attributes.
const RESERVED = new Set(["level", "time", "msg", "pid", "hostname"]);

export interface MappedLogRecord {
  severityNumber: SeverityNumber;
  severityText: string;
  body: string;
  timestamp: number; // epoch ms
  attributes: Record<string, AnyValue>;
}

/** Pure: convert a parsed Pino log object into OTel LogRecord fields. */
export function pinoLineToLogRecord(obj: Record<string, unknown>): MappedLogRecord {
  const level = typeof obj.level === "number" ? obj.level : 30;
  const sev = SEVERITY[level] ?? SEVERITY[30]!;

  const attributes: Record<string, AnyValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED.has(key) || value === undefined) continue;
    attributes[key] =
      value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : (value as AnyValue);
  }

  const time = typeof obj.time === "string" ? Date.parse(obj.time) : Number(obj.time);

  return {
    severityNumber: sev.number,
    severityText: sev.text,
    body: typeof obj.msg === "string" ? obj.msg : "",
    timestamp: Number.isNaN(time) ? Date.now() : time,
    attributes,
  };
}

/**
 * A main-thread Writable that receives serialized Pino JSON lines and emits each
 * as an OTel LogRecord via the globally-registered LoggerProvider. If no provider
 * is registered yet, `logs.getLogger` returns a no-op and the line is dropped from
 * OTel (it still reached stdout via the other multistream destination). All errors
 * are swallowed so logging never throws into the app/worker path.
 */
export function createOtelSink(): Writable {
  return new Writable({
    write(chunk: Buffer | string, _enc, callback) {
      try {
        const obj = JSON.parse(chunk.toString());
        const rec = pinoLineToLogRecord(obj);
        logs.getLogger(LOGGER_NAME).emit({
          severityNumber: rec.severityNumber,
          severityText: rec.severityText,
          body: rec.body,
          timestamp: rec.timestamp,
          attributes: rec.attributes,
        });
      } catch {
        // never throw into the logging path
      }
      callback();
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/server/otel-pino-sink.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/server/observability/otel-pino-sink.ts tests/lib/server/otel-pino-sink.test.ts
git commit -m "feat: add main-thread pino->otel log record sink"
```

---

## Task 3: OTel Logs SDK lifecycle

No unit test — this is thin glue over OTel SDK constructors; verified by type-check.

**Files:**
- Create: `lib/server/observability/otel-logs.ts`

- [ ] **Step 1: Implement the lifecycle module**

Create `lib/server/observability/otel-logs.ts`:

```ts
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

> If `tsc` reports that `LoggerProvider` has no `processors` constructor option (older SDK), instead construct `new LoggerProvider({ resource })` and call `provider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter))`. The installed version (0.219.0) uses `processors`; this note is the fallback only.

- [ ] **Step 3: Commit**

```bash
git add lib/server/observability/otel-logs.ts
git commit -m "feat: add otel logs sdk lifecycle (logger provider + otlp exporter)"
```

---

## Task 4: Application logger

No unit test — Pino configuration glue; verified by type-check and exercised by later tasks.

**Files:**
- Create: `lib/server/logger.ts`

- [ ] **Step 1: Implement the logger**

Create `lib/server/logger.ts`:

```ts
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
const level = process.env.LOG_LEVEL || "info";

// Ensure the global LoggerProvider exists before any line hits the OTel sink —
// idempotent, so instrumentation.register() calling it again is harmless.
if (otelEnabled) initOtelLogs();

function buildStreams(): pino.StreamEntry[] {
  const stdout: pino.StreamEntry = isProduction
    ? { level, stream: process.stdout }
    : { level, stream: pretty({ colorize: true }) };

  const streams: pino.StreamEntry[] = [stdout];
  if (otelEnabled) streams.push({ level, stream: createOtelSink() });
  return streams;
}

// Secret-bearing fields that must never reach stdout or log storage. magick-utils
// carries Firebase `idToken` on jobs/contexts and may log request headers.
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-test the logger loads and emits (OTel off)**

Run: `npx tsx -e "process.env.NODE_ENV='production'; const {logger}=await import('./lib/server/logger.ts'); logger.info({jobId:'j1'},'logger smoke'); logger.error({err:new Error('x')},'err smoke');"`

(If `tsx` isn't available, run `npx vitest run` later — Task 9 — which imports the module transitively.)
Expected: two JSON lines on stdout containing `"msg":"logger smoke"` and `"msg":"err smoke"`, with `"service":"magick-utils"`. No throw.

- [ ] **Step 4: Commit**

```bash
git add lib/server/logger.ts
git commit -m "feat: add pino logger with stdout + otel multistream"
```

---

## Task 5: Wire OTel logs + logger into instrumentation.ts

**Files:**
- Modify: `instrumentation.ts`

- [ ] **Step 1: Replace the file contents**

Overwrite `instrumentation.ts` with:

```ts
// Next.js instrumentation hook — runs once when the server process starts.
// On the Node runtime: initialize OTel log export, then (if backend configured)
// ensure Mongo indexes and boot the in-process ingestion worker. No-ops cleanly
// when unconfigured (mock mode).

import { initOtelLogs, shutdownOtelLogs } from "./lib/server/observability/otel-logs";
import { logger } from "./lib/server/logger";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  initOtelLogs();
  process.on("SIGTERM", () => void shutdownOtelLogs());
  process.on("SIGINT", () => void shutdownOtelLogs());

  const { isBackendConfigured } = await import("./lib/server/env");
  if (!isBackendConfigured()) {
    logger.info("backend not configured — running on mock data");
    return;
  }
  try {
    const { ensureIndexes } = await import("./lib/server/db");
    const { startWorker } = await import("./lib/server/worker");
    await ensureIndexes();
    startWorker();
    logger.info("Mongo indexes ensured; ingestion worker started");
  } catch (err) {
    logger.error({ err }, "startup failed");
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add instrumentation.ts
git commit -m "feat: init otel log export and use structured logger in instrumentation"
```

---

## Task 6: Migrate worker.ts to the logger

**Files:**
- Modify: `lib/server/worker.ts`

- [ ] **Step 1: Add the logger import**

At the top of `lib/server/worker.ts`, after the existing imports block (after the `import type { Job, ... }` line), add:

```ts
import { logger } from "./logger";
```

- [ ] **Step 2: Replace the two console.error calls**

Replace:

```ts
      console.error("[worker] claimNextJob failed", err);
```

with:

```ts
      logger.error({ err }, "[worker] claimNextJob failed");
```

Replace:

```ts
      console.error(`[worker] job ${job.jobId} failed`, err);
```

with:

```ts
      logger.error({ err, jobId: job.jobId }, "[worker] job failed");
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/server/worker.ts
git commit -m "refactor: use structured logger in ingestion worker"
```

---

## Task 7: next.config.ts — keep packages external in standalone

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Add `serverExternalPackages`**

Replace `next.config.ts` with:

```ts
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
  ],
};

export default nextConfig;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add next.config.ts
git commit -m "build: mark pino + otel logs packages as server-external"
```

---

## Task 8: Document env vars in .env.example

**Files:**
- Modify (or create): `.env.example`

- [ ] **Step 1: Append the OTel block**

If `.env.example` exists, append the block below to the end. If it does not exist, create it with just this block.

```
# ── OpenTelemetry logging (Grafana Cloud) ──
# Logs-only export. When OTEL_ENABLED is not "true" or the endpoint is unset,
# logs go to stdout only (pretty in dev, JSON in prod).
OTEL_ENABLED=false
# OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-<region>.grafana.net/otlp
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceId:apiToken)>
# OTEL_SERVICE_NAME=magick-utils
# OTEL_ENVIRONMENT=production
# LOG_LEVEL=info
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: document OTEL_* and LOG_LEVEL env vars"
```

---

## Task 9: Sweep for remaining server-side console.* and final verification

**Files:**
- Modify: any server-side files still using `console.*` (discovered below)

- [ ] **Step 1: Find remaining server-side console usage**

Run: `grep -rn "console\.\(log\|error\|warn\|info\|debug\)" lib/server app/api instrumentation.ts 2>/dev/null`
Expected: ideally only matches inside `lib/server/observability/otel-logs.ts` (its `[otel] …` startup lines, which intentionally use `console` to avoid a logger import cycle) remain.

- [ ] **Step 2: Migrate any other matches**

For each remaining match **outside** `otel-logs.ts`: add `import { logger } from "@/lib/server/logger";` (or the correct relative path for the file) if not present, and convert:
- `console.log("msg", obj)` → `logger.info({ obj }, "msg")`
- `console.error("msg", err)` → `logger.error({ err }, "msg")`
- `console.warn("msg")` → `logger.warn("msg")`

Leave the `console.*` lines inside `lib/server/observability/otel-logs.ts` as-is (intentional — they run before/around logger init and must not import the logger).

> If Step 1 found no matches outside `otel-logs.ts`, skip Steps 2–3 and proceed to Step 4.

- [ ] **Step 3: Commit migrations (only if Step 2 changed files)**

```bash
git add -A
git commit -m "refactor: migrate remaining server console.* to structured logger"
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, including `tests/lib/server/otel-pino-sink.test.ts`.

- [ ] **Step 5: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Production build smoke (catches bundling/standalone issues)**

Run: `npm run build`
Expected: build completes without errors referencing pino / worker_threads / `@opentelemetry/*` resolution.

> If the build fails on an OTel or pino module-resolution error, confirm the package is listed in `serverExternalPackages` (Task 7) and installed (Task 1).

- [ ] **Step 7: Final commit (if build produced lockfile/config drift)**

```bash
git add -A
git commit -m "chore: finalize otel grafana logging" --allow-empty
```

---

## Done criteria

- `npm test` and `npx tsc --noEmit` pass.
- `npm run build` succeeds (standalone bundling intact).
- With `OTEL_ENABLED=false`: logs print to stdout (pretty in dev / JSON in prod); no OTel provider created.
- With `OTEL_ENABLED=true` + endpoint + headers: the same logs are additionally exported to Grafana via OTLP `/v1/logs` (`http/protobuf`, `Authorization` header), tagged with `service.name=magick-utils`.
- No server-side `console.*` remain except the intentional `[otel] …` startup lines in `otel-logs.ts`.
