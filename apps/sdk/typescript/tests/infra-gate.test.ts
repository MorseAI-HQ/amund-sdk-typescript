/**
 * INFRACAP-03/04 — the tracer gate that the community pg / mysql2
 * instrumentations run behind. Tested against a stub provider so it covers the
 * `startSpan` / `startActiveSpan` shapes those packages use without needing a
 * live Postgres or MySQL.
 */

import { trace, type Span, type Tracer, type TracerProvider } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { INFRA_CAPS, gateTracerProvider } from "../src/_internal/infra-shared";
import { runSync } from "../src/_internal/tracing";

function stubProvider(): { provider: TracerProvider; started: string[] } {
  const started: string[] = [];
  const tracer = {
    startSpan(name: string): Span {
      started.push(name);
      return trace.wrapSpanContext({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
      });
    },
    startActiveSpan(name: string, ...rest: unknown[]) {
      started.push(name);
      const fn = rest[rest.length - 1] as (s: Span) => unknown;
      return fn(
        trace.wrapSpanContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
      );
    },
  } as unknown as Tracer;
  return { provider: { getTracer: () => tracer }, started };
}

describe("gateTracerProvider", () => {
  it("creates no span outside a Morse trace (no orphan root)", () => {
    // @spec: INFRACAP-03
    const { provider, started } = stubProvider();
    const tracer = gateTracerProvider(provider, "db").getTracer("pg");
    const span = tracer.startSpan("SELECT");
    expect(span.isRecording()).toBe(false);
    span.setAttribute("db.query.text", "x"); // must not throw
    span.end();
    expect(tracer.startActiveSpan("SELECT", (s) => s.isRecording())).toBe(false);
    expect(started).toEqual([]);
  });

  it("passes spans through inside a trace, in every startActiveSpan overload", () => {
    // @spec: INFRACAP-03
    const { provider, started } = stubProvider();
    const tracer = gateTracerProvider(provider, "db").getTracer("pg");
    runSync({ agentName: "gate" }, () => {
      tracer.startSpan("a");
      tracer.startActiveSpan("b", () => undefined);
      tracer.startActiveSpan("c", {}, () => undefined);
    });
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("stops creating spans at the cap", () => {
    // @spec: INFRACAP-04
    const original = INFRA_CAPS.db;
    INFRA_CAPS.db = 2;
    try {
      const { provider, started } = stubProvider();
      const tracer = gateTracerProvider(provider, "db").getTracer("mysql2");
      runSync({ agentName: "gate" }, () => {
        for (let i = 0; i < 5; i++) tracer.startSpan(`q${i}`);
      });
      expect(started).toEqual(["q0", "q1"]);
    } finally {
      INFRA_CAPS.db = original;
    }
  });
});
