/**
 * Tests for MHQ-482 DB auto-capture (`_internal/db-capture.ts` +
 * `_internal/db-capture-sqlite.ts`) — TypeScript parity port of the Python
 * SDK's `test_infra_capture.py` DB coverage.
 *
 * Uses `better-sqlite3` (installed as a devDependency here; NOT a runtime
 * dependency of the published package) as the driver under test for the
 * real end-to-end span-shape + nesting assertions, mirroring
 * `test_infra_capture.py`'s choice of stdlib `sqlite3` for the same reason
 * (synchronous, no external DB server, exercises the same registration
 * path `pg`/`mysql2` would). `pg`/`mysql2` coverage here is
 * construction/registration-only (no live Postgres/MySQL server is spun
 * up in this suite — see the PR report for why a full DB round-trip is
 * out of scope for this pass).
 *
 * Import ordering note: `@opentelemetry/instrumentation`'s hook-based
 * patching only intercepts a driver module the FIRST time it's
 * `require()`d after the instrumentation is registered — a module already
 * cached from an earlier `require()` is untouched (it only logs a
 * "module already loaded" warning). So `better-sqlite3` is deliberately
 * NOT statically imported at this file's top level; it's loaded via a
 * dynamic `require()` inside `beforeAll`, AFTER `registerDbInstrumentation()`
 * has run, so the very first real load goes through the patched path.
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildRedactionConfig } from "../src/_internal/redaction";
import {
  buildDbInstrumentations,
  disableDbCapture,
  maybeEnableDbCaptureFromEnv,
  registerDbInstrumentation,
  _getRegisteredInstrumentationsForTesting,
} from "../src/_internal/db-capture";
import { getEngine, type OtelEngine } from "../src/_internal/otel-provider";
import { INFRA_CAPS } from "../src/_internal/infra-shared";
import { runSync, spanSync, type TraceState } from "../src/_internal/tracing";

const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1/api/v1/otlp/v1/traces";

function configureEngine(): OtelEngine {
  const engine = getEngine();
  engine.configure({
    endpoint: UNREACHABLE_ENDPOINT,
    apiKey: "av_test", // pragma: allowlist secret
    sampleRate: 1.0,
    scheduleDelayMillis: 20,
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    maxFieldBytes: 65536,
    timeoutMillis: 1000,
    redactionConfig: buildRedactionConfig({ enabled: true }),
    captureForTests: true,
  });
  return engine;
}

/* -------------------------------------------------------------------------- */
/*  Construction / registration — never throws, driver-presence-agnostic     */
/* -------------------------------------------------------------------------- */

describe("registration", () => {
  afterEach(() => {
    disableDbCapture();
    getEngine().resetForTesting();
  });

  it("buildDbInstrumentations() constructs one instrumentation per driver without throwing", () => {
    const instrumentations = buildDbInstrumentations();
    expect(instrumentations.length).toBe(3);
  });

  it("registerDbInstrumentation() is a no-op (returns false) before the engine is configured", () => {
    expect(() => registerDbInstrumentation()).not.toThrow();
    expect(registerDbInstrumentation()).toBe(false);
    expect(_getRegisteredInstrumentationsForTesting()).toBeNull();
  });

  it("registerDbInstrumentation() succeeds once the engine is configured", () => {
    configureEngine();
    expect(registerDbInstrumentation()).toBe(true);
    expect(_getRegisteredInstrumentationsForTesting()?.length).toBe(3);
  });

  it("registerDbInstrumentation() is idempotent — a second call replaces, not duplicates", () => {
    configureEngine();
    registerDbInstrumentation();
    const first = _getRegisteredInstrumentationsForTesting();
    registerDbInstrumentation();
    const second = _getRegisteredInstrumentationsForTesting();
    expect(second).not.toBe(first);
    expect(second?.length).toBe(3);
  });

  it("disableDbCapture() unregisters cleanly and is idempotent", () => {
    configureEngine();
    registerDbInstrumentation();
    expect(() => disableDbCapture()).not.toThrow();
    expect(_getRegisteredInstrumentationsForTesting()).toBeNull();
    expect(() => disableDbCapture()).not.toThrow(); // second call — no-op
  });
});

/* -------------------------------------------------------------------------- */
/*  Env-driven opt-in (mirrors Python's maybe_enable_from_env)               */
/* -------------------------------------------------------------------------- */

describe("maybeEnableDbCaptureFromEnv", () => {
  afterEach(() => {
    disableDbCapture();
    getEngine().resetForTesting();
    delete process.env.MORSE_CAPTURE_DB;
    delete process.env.MORSE_CAPTURE_INFRA;
  });

  it("is ON by default when no MORSE_CAPTURE_* flag is set", () => {
    // @spec: INFRACAP-01
    configureEngine();
    maybeEnableDbCaptureFromEnv();
    expect(_getRegisteredInstrumentationsForTesting()?.length).toBe(3);
  });

  it.each(["0", "false", "no", "off"])("MORSE_CAPTURE_DB=%s opts out", (value) => {
    // @spec: INFRACAP-02
    configureEngine();
    process.env.MORSE_CAPTURE_DB = value;
    maybeEnableDbCaptureFromEnv();
    expect(_getRegisteredInstrumentationsForTesting()).toBeNull();
  });

  it("MORSE_CAPTURE_INFRA=0 opts out", () => {
    // @spec: INFRACAP-02
    configureEngine();
    process.env.MORSE_CAPTURE_INFRA = "0";
    maybeEnableDbCaptureFromEnv();
    expect(_getRegisteredInstrumentationsForTesting()).toBeNull();
  });

  it("a specific MORSE_CAPTURE_DB=1 wins over MORSE_CAPTURE_INFRA=0", () => {
    // @spec: INFRACAP-02
    configureEngine();
    process.env.MORSE_CAPTURE_INFRA = "0";
    process.env.MORSE_CAPTURE_DB = "1";
    maybeEnableDbCaptureFromEnv();
    expect(_getRegisteredInstrumentationsForTesting()?.length).toBe(3);
  });

  it("an unrecognised value falls back to the default (on)", () => {
    // @spec: INFRACAP-02
    configureEngine();
    process.env.MORSE_CAPTURE_INFRA = "maybe";
    maybeEnableDbCaptureFromEnv();
    expect(_getRegisteredInstrumentationsForTesting()?.length).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  Real span shape + correlation — better-sqlite3 end to end                */
/* -------------------------------------------------------------------------- */

describe("better-sqlite3 end-to-end", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Database: any;
  let engine: OtelEngine;

  beforeAll(() => {
    engine = configureEngine();
    registerDbInstrumentation();
    // First-ever require of the module in this process — see the file
    // header for why this must happen AFTER registration, not as a
    // static top-level import.
    const req = createRequire(import.meta.url);
    Database = req("better-sqlite3");
  });

  afterEach(async () => {
    // Flush before clearing so a straggling in-flight batch export from
    // THIS test can't land in the recorder after it's been cleared,
    // contaminating the next test's assertions.
    await engine.flush();
    engine.recorder?.clear();
  });

  it("Database.exec() and prepare().run()/get()/all() each emit a db span", async () => {
    // @spec: INFRACAP-01
    runSync({ agentName: "all-methods" }, () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t (id INTEGER, name TEXT)");
      const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
      insert.run(1, "a");
      const select = db.prepare("SELECT * FROM t WHERE id = ?");
      select.get(1);
      select.all(1);
      db.close();
    });

    await engine.flush();
    const names = engine.recorder!.spans.map((s) => s.name);
    expect(names).toContain("CREATE");
    expect(names).toContain("INSERT");
    expect(names).toContain("SELECT");
  });

  it("span attributes carry db.system.name=sqlite and the parameterized db.query.text", async () => {
    runSync({ agentName: "shape" }, () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE u (id INTEGER, email TEXT)");
      const stmt = db.prepare("SELECT * FROM u WHERE email = ?");
      stmt.get("secret@example.com");
      db.close();
    });

    await engine.flush();
    const select = engine.recorder!.spans.find((s) => s.name === "SELECT");
    expect(select).toBeDefined();
    expect(select!.attributes["db.system.name"]).toBe("sqlite");
    expect(select!.attributes["db.query.text"]).toBe("SELECT * FROM u WHERE email = ?");
    // Bound parameter value must never appear in the captured span — PII-safe
    // by construction, same guarantee the Python SDK's test asserts.
    expect(JSON.stringify(select!.attributes)).not.toContain("secret@example.com");
  });

  it("registering instrumentation does not change query results (non-invasive)", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE z (a INTEGER)");
    db.prepare("INSERT INTO z VALUES (?)").run(1);
    db.prepare("INSERT INTO z VALUES (?)").run(2);
    const rows = db.prepare("SELECT a FROM z ORDER BY a").all() as Array<{ a: number }>;
    db.close();
    expect(rows.map((r) => r.a)).toEqual([1, 2]);
    await engine.flush();
  });

  describe("correlation with morse.span()/run()", () => {
    it("a query inside morse.span() carries the span's trace id and nests as a child", async () => {
      let sqlSpanIdHex: string | undefined;
      let dbTraceIdSeen: string | undefined;

      runSync({ agentName: "db-agent" }, () => {
        spanSync({ name: "do-query", type: "custom" }, (handle) => {
          sqlSpanIdHex = handle?.span.span_id;
          dbTraceIdSeen = handle?.span.trace_id;
          const db = new Database(":memory:");
          db.exec("CREATE TABLE w (a INTEGER)");
          db.close();
        });
      });

      await engine.flush();
      const created = engine.recorder!.spans.find((s) => s.name === "CREATE");
      expect(created).toBeDefined();
      expect(dbTraceIdSeen).toBeDefined();
      expect(created!.spanContext().traceId).toBe(dbTraceIdSeen);
      // Nests under the morse.span() block's synthetic OTel parent — same
      // 16-hex truncation convention `otel-provider.ts::withOtelSpanContext`
      // documents.
      expect(created!.parentSpanContext?.spanId).toBe(sqlSpanIdHex!.slice(0, 16));
    });

    it("a query inside morse.run() (no child span()) nests under the root span", async () => {
      let rootSpanIdHex: string | undefined;
      let traceIdSeen: string | undefined;

      runSync({ agentName: "root-db-agent" }, (handle) => {
        rootSpanIdHex = handle._state.spanStack[0]!.span_id;
        traceIdSeen = handle._state.traceId;
        const db = new Database(":memory:");
        db.exec("CREATE TABLE x (a INTEGER)");
        db.close();
      });

      await engine.flush();
      const created = engine.recorder!.spans.find((s) => s.name === "CREATE");
      expect(created).toBeDefined();
      expect(created!.spanContext().traceId).toBe(traceIdSeen);
      expect(created!.parentSpanContext?.spanId).toBe(rootSpanIdHex!.slice(0, 16));
    });

    it("two sibling morse.span() blocks produce DB spans under different parents", async () => {
      const spanIds: string[] = [];
      runSync({ agentName: "sibling-agent" }, () => {
        spanSync({ name: "first", type: "custom" }, (handle) => {
          spanIds.push(handle!.span.span_id);
          const db = new Database(":memory:");
          db.exec("CREATE TABLE a1 (x INTEGER)");
          db.close();
        });
        spanSync({ name: "second", type: "custom" }, (handle) => {
          spanIds.push(handle!.span.span_id);
          const db = new Database(":memory:");
          db.exec("CREATE TABLE a2 (x INTEGER)");
          db.close();
        });
      });

      await engine.flush();
      const created = engine.recorder!.spans.filter((s) => s.name === "CREATE");
      expect(created.length).toBe(2);
      const parents = created.map((s) => s.parentSpanContext?.spanId).sort();
      expect(new Set(parents).size).toBe(2);
      expect(parents).toEqual([spanIds[0]!.slice(0, 16), spanIds[1]!.slice(0, 16)].sort());
    });

    it("a query outside any morse.run()/span() records NO span (no orphan root)", async () => {
      // @spec: INFRACAP-03
      const db = new Database(":memory:");
      db.exec("CREATE TABLE y (a INTEGER)");
      expect(db.prepare("SELECT 41 + 1 AS n").get()).toEqual({ n: 42 });
      db.close();

      await engine.flush();
      expect(engine.recorder!.spans.filter((s) => s.name === "CREATE")).toHaveLength(0);
      expect(engine.recorder!.spans).toHaveLength(0);
    });

    it("past the per-trace cap, calls fold into ONE summary span with the suppressed count", async () => {
      // @spec: INFRACAP-04
      const original = INFRA_CAPS.db;
      INFRA_CAPS.db = 5;
      let state: TraceState | null = null;
      try {
        runSync({ agentName: "n-plus-one" }, (handle) => {
          state = handle._state;
          const db = new Database(":memory:");
          db.exec("CREATE TABLE q (a INTEGER)");
          const stmt = db.prepare("SELECT a FROM q");
          for (let i = 0; i < 12; i++) stmt.all();
          db.close();
        });
      } finally {
        INFRA_CAPS.db = original;
      }
      await engine.flush();
      // 5 query spans reached the exporter...
      const dbSpans = engine.recorder!.spans.filter(
        (s) => s.attributes["db.system.name"] === "sqlite",
      );
      expect(dbSpans).toHaveLength(5);
      // ...and the rest are one summary span on the Morse trace.
      const summaries = state!.completedSpans.filter(
        (s) => s.metadata?.["infra.suppressed_count"] !== undefined,
      );
      expect(summaries).toHaveLength(1);
      // 1 exec + 1 prepare-less + 12 stmt.all() = 13 calls, 5 kept.
      expect(summaries[0]!.metadata!["infra.suppressed_count"]).toBe(8);
      expect(summaries[0]!.type).toBe("db");
    });

    it("an inline literal in the SQL never reaches the exported span", async () => {
      // @spec: INFRACAP-05
      runSync({ agentName: "inline-literal" }, () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE lit (email TEXT, id INTEGER)");
        db.prepare(
          "SELECT * FROM lit WHERE email = 'canary@example.com' AND id = 4111111111111111",
        ).all();
        db.close();
      });
      await engine.flush();
      const select = engine.recorder!.spans.find((s) => s.name === "SELECT");
      expect(select!.attributes["db.query.text"]).toBe(
        "SELECT * FROM lit WHERE email = ? AND id = ?",
      );
      expect(JSON.stringify(engine.recorder!.spans.map((s) => s.attributes))).not.toContain(
        "canary",
      );
    });
  });

  it("disableDbCapture() restores the driver to unpatched behavior", async () => {
    disableDbCapture();
    try {
      const marker = randomUUID().replace(/-/g, "_");
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE t_${marker} (a INTEGER)`);
      db.close();

      await engine.flush();
      const names = engine.recorder!.spans.map((s) => s.name);
      expect(names).not.toContain("CREATE");
    } finally {
      // Restore for any later test in this describe block.
      registerDbInstrumentation();
    }
  });
});
