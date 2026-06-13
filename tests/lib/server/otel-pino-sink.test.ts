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

  it("accepts a numeric epoch-ms time field (pino default)", () => {
    const epoch = 1749772800000;
    const rec = pinoLineToLogRecord({ level: 30, msg: "x", time: epoch });
    expect(rec.timestamp).toBe(epoch);
  });

  it("falls back to Date.now() when time is unparseable", () => {
    const before = Date.now();
    const rec = pinoLineToLogRecord({ level: 30, msg: "x", time: "not-a-date" });
    expect(rec.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("defaults a non-number level to INFO", () => {
    const rec = pinoLineToLogRecord({ level: "info", msg: "x", time: "2026-06-13T00:00:00.000Z" });
    expect(rec.severityNumber).toBe(SeverityNumber.INFO);
    expect(rec.severityText).toBe("INFO");
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
