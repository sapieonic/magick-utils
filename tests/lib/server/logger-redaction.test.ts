// What the logger must never print.
//
// This app carries a Firebase `idToken` AND a `refreshToken` on session objects,
// tenant contexts and job documents, and those objects get logged wholesale in
// error paths. The refresh token is the one that matters: it does not expire, so
// a single leaked line is a standing credential rather than an hour's worth —
// which is also why `deleteJobsOlderThan` is described as a security control.
// These assertions exist so nobody trims the list while tidying it.

import { describe, expect, it } from "vitest";
import pino from "pino";

import { REDACT_PATHS } from "@/lib/server/logger";

/** A logger wired exactly like the real one, writing to a buffer a test can read. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk));
    },
  };
  const logger = pino(
    { level: "info", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
    stream as never,
  );
  return { logger, lines };
}

describe("REDACT_PATHS", () => {
  it("is exactly this list — any change here is a deliberate one", () => {
    // A trimmed or reordered list still logs happily; nothing fails at runtime
    // and nothing looks wrong in review. This is the only thing that notices.
    expect(REDACT_PATHS).toEqual([
      "idToken",
      "*.idToken",
      "refreshToken",
      "*.refreshToken",
      "headers.authorization",
      'headers["x-api-key"]',
      "req.headers.authorization",
      'req.headers["x-api-key"]',
    ]);
  });

  it("censors a credential logged at the top level", () => {
    const { logger, lines } = captureLogger();
    logger.info({ idToken: "id-secret", refreshToken: "refresh-secret" }, "hello");
    expect(lines[0].idToken).toBe("[REDACTED]");
    expect(lines[0].refreshToken).toBe("[REDACTED]");
  });

  it("censors a credential nested one level down, which is how contexts and jobs are logged", () => {
    const { logger, lines } = captureLogger();
    logger.info({ ctx: { tenantId: "t1", idToken: "id-secret", refreshToken: "refresh-secret" } }, "ctx");
    logger.info({ job: { jobId: "j1", idToken: "id-secret", refreshToken: "refresh-secret" } }, "job");
    logger.info({ session: { idToken: "id-secret", refreshToken: "refresh-secret" } }, "session");

    for (const line of lines) {
      const [payload] = Object.values(line).filter(
        (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
      );
      expect(payload.idToken).toBe("[REDACTED]");
      expect(payload.refreshToken).toBe("[REDACTED]");
    }
  });

  it("censors bearer and api-key headers, both bare and under req", () => {
    const { logger, lines } = captureLogger();
    logger.info({ headers: { authorization: "Bearer id-secret", "x-api-key": "k" } }, "headers");
    logger.info({ req: { headers: { authorization: "Bearer id-secret", "x-api-key": "k" } } }, "req");

    const headers = lines[0].headers as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["x-api-key"]).toBe("[REDACTED]");
    const req = lines[1].req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe("[REDACTED]");
    expect(req.headers["x-api-key"]).toBe("[REDACTED]");
  });

  it("leaves everything else readable", () => {
    // Redaction is only worth anything if the surrounding line still diagnoses
    // the problem it was written for.
    const { logger, lines } = captureLogger();
    logger.info({ ctx: { tenantId: "t1", accountId: "a1", idToken: "id-secret" }, jobId: "j1" }, "fine");
    expect(lines[0].jobId).toBe("j1");
    expect(lines[0].ctx).toMatchObject({ tenantId: "t1", accountId: "a1" });
  });
});
