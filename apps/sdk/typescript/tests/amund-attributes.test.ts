/**
 * MHQ-1951 (founder decision 2026-11-27): every OTLP span/resource attribute the SDK
 * emits under `morse.*` is emitted under `amund.*` with the same suffix, and ONLY
 * under `amund.*` (no dual emission). `amund.harness.*` is unchanged.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import * as morse from "../src/index";
import { buildSdkResource, getEngine } from "../src/_internal/otel-provider";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { SpanType } from "../src/_internal/spans";
import { runSync, spanSync } from "../src/_internal/tracing";

afterEach(() => {
  morse._resetForTesting();
  getEngine().resetForTesting();
});

function recorder() {
  const engine = getEngine();
  engine.configure({
    endpoint: "http://127.0.0.1:1/api/v1/otlp/v1/traces",
    apiKey: "av_test", // pragma: allowlist secret
    sampleRate: 1.0,
    scheduleDelayMillis: 50,
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    maxFieldBytes: 65536,
    timeoutMillis: 1000,
    redactionConfig: buildRedactionConfig({ enabled: true }),
    captureForTests: true,
  } as never);
  return engine;
}

describe("amund.* attribute namespace", () => {
  it("emits the exact amund.* keys and no morse.* key on any span or resource", async () => {
    const engine = recorder();
    runSync(
      {
        agentName: "amund-keys",
        threadId: "t-1",
        userId: "u-1",
        userMetadata: { plan: "pro" },
        recordKeys: { order: "A-1" },
        agentVersion: "v3",
      } as never,
      () => {
        morse.setOutcome(true, "resolved");
        morse.setPrompt("router", 2);
        spanSync({ name: "llm-call", type: SpanType.LLM, metadata: { region: "eu" } }, (h) => {
          if (h?.span) h.span.input_data = { q: 1 };
        });
      },
    );
    await engine.flush();
    const spans = engine.recorder!.spans as ReadableSpan[];
    const root = spans.find((s) => s.name === "amund-keys")!;
    const child = spans.find((s) => s.name === "llm-call")!;

    const a = root.attributes;
    for (const k of [
      "amund.agent",
      "amund.thread_id",
      "amund.user_id",
      "amund.user_metadata",
      "amund.outcome.success",
      "amund.outcome.label",
      "amund.record_key.order",
      "amund.agent_version",
      "amund.prompt.name",
      "amund.prompt.version",
    ]) {
      expect(a[k], k).toBeDefined();
    }
    expect(a["amund.agent"]).toBe("amund-keys");
    expect(a["amund.outcome.label"]).toBe("resolved");
    expect(child.attributes["amund.span_type"]).toBe("llm");
    expect(child.attributes["amund.metadata.region"]).toBe('"eu"');

    for (const s of spans) {
      expect(Object.keys(s.attributes).filter((k) => k.startsWith("morse."))).toEqual([]);
      const res = (s.resource?.attributes ?? {}) as Record<string, unknown>;
      expect(Object.keys(res).filter((k) => k.startsWith("morse."))).toEqual([]);
    }
  });

  it("buildSdkResource carries amund.process.service_name and no morse.* key", () => {
    const r = buildSdkResource("svc") as unknown as { attributes: Record<string, unknown> };
    expect(r.attributes["amund.process.service_name"]).toBe("svc");
    expect(Object.keys(r.attributes).filter((k) => k.startsWith("morse."))).toEqual([]);
  });
});
