// Global test setup. jest-dom matchers are only meaningful in jsdom files, but
// importing here is harmless under node and keeps DOM tests from each needing it.
import "@testing-library/jest-dom/vitest";

// Silence the application logger during tests. The logger reads LOG_LEVEL once at
// module-load time, and setupFiles run before any test module (and therefore
// before the logger is imported), so this keeps request/worker log lines out of
// the test output without affecting behavior. Override per-file if a test needs
// to assert on logging.
process.env.LOG_LEVEL = "silent";
