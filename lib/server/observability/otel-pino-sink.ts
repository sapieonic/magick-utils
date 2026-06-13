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

/** Pure: convert a parsed Pino log object into OTel LogRecord fields.
 *  If `time` is absent or unparseable, `timestamp` falls back to `Date.now()`.
 */
export function pinoLineToLogRecord(obj: Record<string, unknown>): MappedLogRecord {
  const level = typeof obj.level === "number" ? obj.level : 30;
  const sev = SEVERITY[level] ?? SEVERITY[30];

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
