# OTel → Grafana Logging for magick-utils

**Date:** 2026-06-13
**Status:** Approved (design)
**Scope:** Logs only (no traces/metrics). Add a structured logger whose log records
are exported to Grafana via OTLP, and migrate existing server-side `console.*` calls
to it.

## Goal

Give magick-utils the same Grafana log visibility that `magic-voice-core` has:
structured logs pushed through OpenTelemetry (OTLP) to Grafana Cloud. Match core's
*configuration* conventions (manual OTLP header parsing, `http/protobuf` protocol,
service resource attributes, env-var gating) while adapting the *transport mechanism*
to Next.js.

Non-goals: traces, metrics, auto-instrumentation, trace/log correlation (there is no
tracer in this scope, so no active spans to correlate against).

## Context

- **Target project:** `magick-utils` — Next.js 16 (App Router), TypeScript strict,
  ESM, `output: "standalone"` (Docker), Node ^20, vitest. Long-running Node host
  (Render/Railway/Fly) — not serverless.
- **Current logging:** bare `console.log`/`console.error` with `[prefix]` brackets.
  No structured logger, no OTel.
- **Server-side `console.*` call sites today:** `instrumentation.ts` (3),
  `lib/server/worker.ts` (2). Implementation will grep for any others under server
  paths (`lib/server/**`, `app/api/**`, `instrumentation.ts`) and migrate those too.
  Client/React `console` usage (browser runtime) is **out of scope** and left alone.
- **Reference pattern (core):** `src/instrumentation.ts` (OTLP header parse, protocol
  forcing, resource attrs) and `src/utils/logger.ts` (Pino + multistream + redact +
  base fields + ISO timestamps).

## Key architectural decision: how logs reach OTel under Next.js

Core uses `pino → pino-opentelemetry-transport → OTLP`. That transport runs in a
**worker thread** (via `thread-stream`). Under Next.js `output: "standalone"`, Next
traces/bundles server files and worker-thread Pino transports routinely fail to
resolve their worker entry at runtime. `pino-pretty` used as a `transport` has the
same failure mode.

**Chosen approach:** keep everything on the **main thread**. Stand up an OTel
`LoggerProvider` and attach a custom `pino.multistream` destination that converts each
Pino log line into an OTel `LogRecord` and `emit()`s it. No worker threads → Next-safe.
This reproduces core's behavior and config while avoiding the fragile transport.

Rejected alternatives:
- **Port core verbatim** (`pino-opentelemetry-transport`): fragile under standalone
  bundling; would need `serverExternalPackages` gymnastics and still risk breaking in
  the Docker image.
- **`@vercel/otel`**: trace-centric, pulls in more than needed, less control over the
  Grafana auth header shape. Overkill for logs-only.

## Dependencies to add

Runtime (`dependencies`):

- `pino`
- `pino-pretty` (dev console formatting; used as a **main-thread stream factory**, not
  a worker transport)
- `@opentelemetry/api-logs` (Logs API: `logs.getLogger`, `SeverityNumber`)
- `@opentelemetry/sdk-logs` (`LoggerProvider`, `BatchLogRecordProcessor`)
- `@opentelemetry/exporter-logs-otlp-proto` (`OTLPLogExporter`, protobuf — matches
  core's proto choice for Grafana Cloud)
- `@opentelemetry/resources` (`resourceFromAttributes`)
- `@opentelemetry/semantic-conventions`

Versions follow core's experimental-package line (`^0.2xx` for the OTel
experimental/exporter/sdk-logs packages, `^1.x`/`^2.x` for api-logs/resources/
semantic-conventions). Exact versions resolved at `npm install` time; the OTel
experimental packages (`sdk-logs`, `exporter-logs-otlp-proto`, `api-logs`) must share a
compatible release line.

No `@opentelemetry/sdk-node` and no auto-instrumentations — this is logs-only.

## Components

### 1. `lib/server/observability/otel-logs.ts`

OTel Logs SDK lifecycle. Server-only.

- `initOtelLogs(): void` — **idempotent**. No-op unless
  `OTEL_ENABLED === 'true'` **and** `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  When active:
  - Sets `process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'` (Grafana Cloud
    has no gRPC).
  - Parses `OTEL_EXPORTER_OTLP_HEADERS` manually with split-on-first-`=` per entry
    (base64 values contain `=`), identical to core.
  - Builds a `Resource` via `resourceFromAttributes`:
    - `service.name` = `OTEL_SERVICE_NAME` || `'magick-utils'`
    - `service.version` = app version (read from `package.json`)
    - `deployment.environment` = `OTEL_ENVIRONMENT` || `NODE_ENV` || `'development'`
  - Builds `OTLPLogExporter({ url: \`${endpoint}/v1/logs\`, headers })` wrapped in a
    `BatchLogRecordProcessor`, attached to a `LoggerProvider`, registered globally via
    `logs.setGlobalLoggerProvider(provider)`.
  - Logs a one-line confirmation (using `console` here to avoid a logger import cycle,
    matching core's `[otel] …` startup lines), and a warning if enabled-but-no-headers
    (likely 401), mirroring core.
- `shutdownOtelLogs(): Promise<void>` — flushes + shuts down the provider
  (`BatchLogRecordProcessor` flushes on shutdown). Safe to call when never initialized.

### 2. `lib/server/observability/otel-pino-sink.ts`

Main-thread Pino → OTel bridge. Server-only.

- `pinoLineToLogRecord(obj): LogRecordInput` — **pure, exported for unit test.** Maps a
  parsed Pino log object to OTel LogRecord fields:
  - level → `severityNumber` / `severityText`:
    `10→TRACE`, `20→DEBUG`, `30→INFO`, `40→WARN`, `50→ERROR`, `60→FATAL`
    (unknown → `INFO`).
  - `msg` → `body`.
  - `time` (ISO string) → `timestamp` (epoch ms via `Date.parse`).
  - remaining own fields (minus `level`, `time`, `msg`, `pid`, `hostname`) →
    `attributes`. Nested objects/arrays are JSON-stringified for attribute-value
    safety; primitives pass through.
- `createOtelSink(): Writable` — a `Writable` (object/line mode) that, per line:
  parses JSON, calls `pinoLineToLogRecord`, and `logs.getLogger('magick-utils').emit(...)`.
  Resolves the logger lazily per emit so that if the global provider isn't registered
  yet it's a Noop (log still hits stdout). Parse failures are swallowed (never throw
  into the log path).

### 3. `lib/server/logger.ts`

The application logger, mirroring core's `src/utils/logger.ts` shape.

- Reads `LOG_LEVEL` (default `info`), `NODE_ENV`, OTel gating envs.
- When OTel is enabled, calls `initOtelLogs()` (idempotent) at module load so the
  provider exists whenever the logger is used (covers route handlers that import the
  logger before/independently of `instrumentation.register()`).
- `pino.multistream` destinations:
  - **stdout**: `pino-pretty` factory stream in dev (`colorize: true`), raw
    `process.stdout` JSON in production.
  - **otel sink** (`createOtelSink()`): added only when OTel is enabled.
- Pino options: `level`, `base: { service: 'magick-utils', version }`,
  `timestamp: pino.stdTimeFunctions.isoTime`, `serializers: { err: pino.stdSerializers.err }`,
  and a `redact` list for secret-bearing fields (`headers.authorization`,
  `headers["x-api-key"]`, and `idToken` — magick-utils carries Firebase `idToken` on
  jobs/contexts; censor `[REDACTED]`).
- Exports `logger` and `createChildLogger(bindings)`.

### 4. `instrumentation.ts` (existing — edit)

- At the top of `register()` (after the `NEXT_RUNTIME !== 'nodejs'` guard), call
  `initOtelLogs()` and register `shutdownOtelLogs()` on `SIGTERM`/`SIGINT`.
- Replace the 3 `console.*` calls with `logger` (e.g.
  `logger.info('backend not configured — running on mock data')`,
  `logger.info('Mongo indexes ensured; ingestion worker started')`,
  `logger.error({ err }, 'startup failed')`).
- Keep dynamic `import()` for `env`/`db`/`worker`; import the logger
  (and `initOtelLogs`) statically at top since they're cheap and server-only.

### 5. `next.config.ts` (existing — edit)

Add:

```ts
serverExternalPackages: [
  'pino',
  'pino-pretty',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/api-logs',
],
```

so standalone keeps these external (required from `node_modules` at runtime) rather
than bundling their dynamic internals.

### 6. `.env.example` (create/append)

Append an OTel block mirroring core:

```
# ── OpenTelemetry logging (Grafana Cloud) ──
OTEL_ENABLED=false
# OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-<region>.grafana.net/otlp
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceId:apiToken)>
# OTEL_SERVICE_NAME=magick-utils
# OTEL_ENVIRONMENT=production
# LOG_LEVEL=info
```

## Data flow

```
logger.info({ jobId }, 'msg')
  → pino (base + mixin-less, redact, ISO time)
  → multistream
      ├─ stdout (pretty in dev / JSON in prod)
      └─ otel sink (Writable, main thread)
            → pinoLineToLogRecord(parsedLine)
            → logs.getLogger('magick-utils').emit(record)
            → BatchLogRecordProcessor
            → OTLPLogExporter (http/protobuf, /v1/logs, Authorization header)
            → Grafana Cloud (Loki)
```

## Behavior when OTel is disabled

`OTEL_ENABLED` unset/false (or endpoint missing): the logger still works (stdout JSON
in prod, pretty in dev); the OTel sink is not attached and no provider is created —
zero OTel overhead. Matches core's graceful-degradation posture.

## Error handling

- OTel init is fully gated and idempotent; missing endpoint/headers degrade to
  stdout-only (with a startup warning when enabled-but-misconfigured), never a crash.
- The OTel sink swallows JSON-parse and emit errors so logging never throws into the
  app/worker path.
- Shutdown flush is best-effort and safe to call when uninitialized.

## Testing

`tests/lib/otel-pino-sink.test.ts` (vitest, node env):

- level → severity mapping table (10/20/30/40/50/60 + unknown → INFO).
- `pinoLineToLogRecord` maps `msg`→body, `time`→epoch timestamp, and routes remaining
  fields into `attributes` (nested values JSON-stringified; reserved keys `level`/
  `time`/`msg`/`pid`/`hostname` excluded).

(The SDK wiring in `otel-logs.ts` and the Pino logger I/O are not unit-tested — they're
thin glue over library calls; the pure mapping is the logic worth covering.)

## File summary

| File | Action |
|------|--------|
| `lib/server/observability/otel-logs.ts` | new — LoggerProvider lifecycle |
| `lib/server/observability/otel-pino-sink.ts` | new — Pino→LogRecord sink + pure mapper |
| `lib/server/logger.ts` | new — Pino logger (multistream, redact, child) |
| `instrumentation.ts` | edit — init/shutdown OTel logs; console.* → logger |
| `lib/server/worker.ts` | edit — console.* → logger |
| `next.config.ts` | edit — serverExternalPackages |
| `.env.example` | edit — OTEL_* / LOG_LEVEL block |
| `package.json` | edit — add deps |
| `tests/lib/otel-pino-sink.test.ts` | new — unit test |
