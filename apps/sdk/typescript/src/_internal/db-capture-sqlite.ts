/**
 * Custom `better-sqlite3` OTel instrumentation (MHQ-482).
 *
 * There is no `@opentelemetry/instrumentation-better-sqlite3` (or any
 * community equivalent) on npm — verified against the npm registry while
 * building this module: `@opentelemetry/instrumentation-sqlite3` doesn't
 * exist either, and the OTel JS contrib repo's package list has no sqlite
 * entry at all. `better-sqlite3` is a common lightweight/embedded driver
 * (used heavily in tests, scripts, and small services — mirrors the
 * Python SDK's stdlib `sqlite3` coverage in `infra_capture.py`), so rather
 * than drop sqlite coverage entirely, this is a small hand-rolled
 * `InstrumentationBase` subclass following the exact same
 * `InstrumentationNodeModuleDefinition` hook-based patching pattern the
 * community `pg`/`mysql2` packages use (see `./db-capture.ts`) — it only
 * patches when a host app actually `require()`s `better-sqlite3`, and is a
 * transparent no-op otherwise.
 *
 * Span attribute naming mirrors the same stable OTel semantic-convention
 * keys `@opentelemetry/instrumentation-pg` / `-mysql2` emit
 * (`db.system.name`, `db.query.text`, `db.namespace`) — see `./db-capture.ts`'s
 * module docstring for why no translation layer is needed.
 *
 * better-sqlite3 is fully synchronous, so there's no async/callback
 * variant to cover (unlike `pg`/`mysql2`).
 */

import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  isWrapped,
  type InstrumentationConfig,
} from "@opentelemetry/instrumentation";
import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace as traceApi,
} from "@opentelemetry/api";

const SEMCONV_DB_SYSTEM_NAME = "db.system.name";
const SEMCONV_DB_QUERY_TEXT = "db.query.text";
const DB_SYSTEM_NAME_SQLITE = "sqlite";

// Mirrors the Python SDK's `infra_capture.py::_MAX_STATEMENT_LEN` — a
// giant IN (...) clause shouldn't bloat the span; truncated with the same
// marker style `otel-provider.ts::capBytes` uses elsewhere in this SDK.
const MAX_STATEMENT_CHARS = 2048;
const TRUNCATION_MARKER = "…[truncated]";

function sqlVerb(sql: unknown): string {
  try {
    const first = String(sql).trim().split(/\s+/, 1)[0];
    return first ? first.toUpperCase() : "QUERY";
  } catch {
    return "QUERY";
  }
}

function safeStatement(sql: unknown): string | undefined {
  let text: string;
  try {
    text = String(sql).trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  if (text.length > MAX_STATEMENT_CHARS) {
    return text.slice(0, MAX_STATEMENT_CHARS) + " " + TRUNCATION_MARKER;
  }
  return text;
}

// `Statement`/`Database` instances from better-sqlite3 — kept loosely typed
// (the package is an optional peer the SDK never imports types from).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

const SYNC_STATEMENT_METHODS = ["run", "get", "all", "iterate"] as const;

export class BetterSqlite3Instrumentation extends InstrumentationBase<InstrumentationConfig> {
  constructor(config: InstrumentationConfig = {}) {
    super("@morsehq/instrumentation-better-sqlite3", "0.1.0", config);
  }

  protected init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        "better-sqlite3",
        [">=7.0.0 <14"],
        (moduleExports: AnyRecord) => this._patch(moduleExports),
        (moduleExports: AnyRecord) => this._unpatch(moduleExports),
      ),
    ];
  }

  private _withSpan<T>(sql: unknown, fn: () => T): T {
    const span = this.tracer.startSpan(sqlVerb(sql), { kind: SpanKind.CLIENT });
    const stmt = safeStatement(sql);
    span.setAttribute(SEMCONV_DB_SYSTEM_NAME, DB_SYSTEM_NAME_SQLITE);
    if (stmt) span.setAttribute(SEMCONV_DB_QUERY_TEXT, stmt);
    return otelContext.with(traceApi.setSpan(otelContext.active(), span), () => {
      try {
        const result = fn();
        span.end();
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        span.end();
        throw err;
      }
    });
  }

  /** Wrap one already-`prepare()`d statement's sync execution methods. */
  private _wrapStatementInstance(stmt: AnyRecord): AnyRecord {
    const sql = stmt?.source;
    for (const method of SYNC_STATEMENT_METHODS) {
      const original = stmt[method];
      if (typeof original !== "function") continue;
      const bound = original.bind(stmt);
      // Own-property override (not a prototype patch) — each `prepare()`
      // call returns a distinct Statement instance, so this never leaks
      // across statements or requires finding/patching a shared class.
      stmt[method] = (...args: unknown[]) => this._withSpan(sql, () => bound(...args));
    }
    return stmt;
  }

  private _patch(moduleExports: AnyRecord): AnyRecord {
    const DatabaseCtor = moduleExports as AnyRecord;
    const proto = DatabaseCtor?.prototype;
    if (!proto) return moduleExports;

    if (isWrapped(proto.prepare)) this._unwrap(proto, "prepare");
    this._wrap(proto, "prepare", (original: (...a: unknown[]) => AnyRecord) => {
      const wrapStatement = (stmt: AnyRecord): AnyRecord => this._wrapStatementInstance(stmt);
      return function (this: unknown, ...args: unknown[]): AnyRecord {
        const stmt = original.apply(this, args);
        return wrapStatement(stmt);
      };
    });

    if (isWrapped(proto.exec)) this._unwrap(proto, "exec");
    this._wrap(proto, "exec", (original: (...a: unknown[]) => unknown) => {
      const withSpan = <T>(sql: unknown, fn: () => T): T => this._withSpan(sql, fn);
      return function (this: unknown, ...args: unknown[]): unknown {
        return withSpan(args[0], () => original.apply(this, args));
      };
    });

    return moduleExports;
  }

  private _unpatch(moduleExports: AnyRecord): void {
    const proto = moduleExports?.prototype;
    if (!proto) return;
    if (isWrapped(proto.prepare)) this._unwrap(proto, "prepare");
    if (isWrapped(proto.exec)) this._unwrap(proto, "exec");
  }
}
