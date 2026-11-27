/**
 * MHQ-1216: `morseTelemetry()` / `morseTracer()` send the Vercel AI SDK's OWN
 * OpenTelemetry spans (via `@ai-sdk/otel`'s `LegacyOpenTelemetry`) through the
 * SDK engine's exporter chain — no traced wrapper functions involved.
 *
 * Real `ai` + `@ai-sdk/otel` + `MockLanguageModelV4` (no network). Spans are
 * read from the engine's `recorder` (the test-only in-memory exporter that sits
 * beside the real BatchSpanProcessor), so these assert what reaches the
 * exporter, not what the AI SDK intended to emit.
 *
 * `ai` v7 dropped `experimental_telemetry.tracer`: the tracer reaches the AI
 * SDK as a constructor option of the telemetry integration, which is why
 * `morseTelemetry()` takes the integration class.
 */

import { LegacyOpenTelemetry, OpenTelemetry } from "@ai-sdk/otel";
import { generateText, isStepCount, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { getEngine } from "../src/_internal/otel-provider";
import { getActiveTraceState } from "../src/_internal/tracing";
import * as browserProvider from "../src/_internal/otel-provider.browser";
import * as vercelAi from "../src/vercel-ai/index";
import { morseTelemetry, morseTracer } from "../src/vercel-ai/index";
import { _resetMorseTelemetryWarning } from "../src/vercel-ai/telemetry";

const ENDPOINT = "http://127.0.0.1:1/api/v1/otlp/v1/traces";

function configureEngine(): void {
  getEngine().configure({
    endpoint: ENDPOINT,
    apiKey: "av_test", // pragma: allowlist secret
    sampleRate: 1.0,
    scheduleDelayMillis: 20,
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    maxFieldBytes: 65536,
    timeoutMillis: 500,
    redactionConfig: buildRedactionConfig({ enabled: true }),
    captureForTests: true,
  });
}

async function exportedSpans() {
  const engine = getEngine();
  await engine.flush();
  return engine.recorder!.spans;
}

function textModel(text = "hello from the mock") {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  morse._resetForTesting();
  _resetMorseTelemetryWarning();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  getEngine().resetForTesting();
  morse._resetForTesting();
  _resetMorseTelemetryWarning();
});

function morseWarnings(): string[] {
  return warnSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((m: string) => m.includes("morseTelemetry") || m.includes("AI SDK span"));
}

describe("morseTelemetry() with an initialised engine", () => {
  it("returns enabled settings carrying the integration, functionId and record flags", () => {
    configureEngine();
    const settings = morseTelemetry({
      integration: LegacyOpenTelemetry,
      functionId: "support-agent",
      recordInputs: false,
      recordOutputs: true,
    });
    expect(settings).toMatchObject({
      isEnabled: true,
      functionId: "support-agent",
      recordInputs: false,
      recordOutputs: true,
    });
    expect("integrations" in settings && settings.integrations).toHaveLength(1);
    expect(morseWarnings()).toHaveLength(0);
  });

  it("omits optional keys it was not given", () => {
    configureEngine();
    const settings = morseTelemetry({ integration: LegacyOpenTelemetry });
    expect(Object.keys(settings).sort()).toEqual(["integrations", "isEnabled"]);
  });

  it("delivers ai.generateText and ai.generateText.doGenerate spans to the exporter", async () => {
    configureEngine();
    const result = await generateText({
      model: textModel(),
      prompt: "say hi",
      telemetry: morseTelemetry({
        integration: LegacyOpenTelemetry,
        functionId: "support-agent",
        threadId: "thread-42",
        userId: "user-7",
        metadata: { tier: "pro", attempt: 2, beta: true },
      }),
    });
    expect(result.text).toBe("hello from the mock");

    const spans = await exportedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain("ai.generateText");
    expect(names).toContain("ai.generateText.doGenerate");

    const root = spans.find((s) => s.name === "ai.generateText")!;
    const llm = spans.find((s) => s.name === "ai.generateText.doGenerate")!;
    expect(root.attributes["ai.telemetry.functionId"]).toBe("support-agent");
    expect(root.attributes["ai.telemetry.metadata.thread_id"]).toBe("thread-42");
    expect(root.attributes["ai.telemetry.metadata.user_id"]).toBe("user-7");
    expect(root.attributes["ai.telemetry.metadata.tier"]).toBe("pro");
    expect(root.attributes["ai.telemetry.metadata.attempt"]).toBe(2);
    expect(root.attributes["ai.telemetry.metadata.beta"]).toBe(true);
    expect(llm.attributes["ai.telemetry.metadata.thread_id"]).toBe("thread-42");

    // The step span nests under the operation span: same trace, correct parent.
    expect(llm.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(llm.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    // Usage is on the LLM span for the server mapper to type it.
    expect(
      llm.attributes["ai.usage.inputTokens"] ?? llm.attributes["gen_ai.usage.input_tokens"],
    ).toBe(11);
  });

  it("names a parentless span's agent from functionId (the SDK resource carries no service.name)", async () => {
    configureEngine();
    await generateText({
      model: textModel(),
      prompt: "x",
      telemetry: morseTelemetry({ integration: LegacyOpenTelemetry, functionId: "billing-bot" }),
    });
    const spans = await exportedSpans();
    const root = spans.find((s) => s.name === "ai.generateText")!;
    const child = spans.find((s) => s.name === "ai.generateText.doGenerate")!;
    expect(root.attributes["amund.agent"]).toBe("billing-bot");
    expect(child.attributes["amund.agent"]).toBeUndefined();
    expect(root.resource.attributes["service.name"]).toBeUndefined();
  });

  it("nests tool spans under the operation and shares a trace with an enclosing morse.run()", async () => {
    // init() builds the real engine; point it at the same capture-enabled config.
    morse.init({ apiKey: "av_test", endpoint: "http://127.0.0.1:1/api/v1/traces/batch" }); // pragma: allowlist secret
    configureEngine();
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "lookup",
              input: JSON.stringify({ q: "x" }),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        },
        {
          content: [{ type: "text" as const, text: "done" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 6, noCache: 6, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
      ],
    });

    let morseTraceId: string | undefined;
    await morse.runTraced({ agentName: "outer-agent" }, async () => {
      morseTraceId = getActiveTraceState()?.traceId;
      await generateText({
        model,
        prompt: "use the tool",
        tools: {
          lookup: tool({
            description: "lookup",
            inputSchema: jsonSchema<{ q: string }>({
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            }),
            execute: async () => "found",
          }),
        },
        stopWhen: isStepCount(2),
        telemetry: morseTelemetry({ integration: LegacyOpenTelemetry, functionId: "tooly" }),
      });
    });

    const spans = await exportedSpans();
    const root = spans.find((s) => s.name === "ai.generateText")!;
    const toolSpan = spans.find((s) => s.name === "ai.toolCall")!;
    expect(toolSpan).toBeDefined();
    expect(toolSpan.attributes["ai.toolCall.name"]).toBe("lookup");
    expect(toolSpan.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(morseTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanContext().traceId).toBe(morseTraceId);
    // Inside a Morse run the Morse root owns the agent name.
    expect(root.attributes["amund.agent"]).toBeUndefined();
  });

  it("works with the GenAI-convention OpenTelemetry integration too", async () => {
    configureEngine();
    await generateText({
      model: textModel(),
      prompt: "x",
      telemetry: morseTelemetry({ integration: OpenTelemetry, functionId: "genai-agent" }),
    });
    const names = (await exportedSpans()).map((s) => s.name);
    expect(names.some((n) => n.startsWith("invoke_agent"))).toBe(true);
    expect(names.some((n) => n.startsWith("chat"))).toBe(true);
  });

  it("records nothing for a trace the ratio sampler drops", async () => {
    getEngine().configure({
      endpoint: ENDPOINT,
      apiKey: "av_test", // pragma: allowlist secret
      sampleRate: 0,
      scheduleDelayMillis: 20,
      maxQueueSize: 64,
      maxExportBatchSize: 64,
      maxFieldBytes: 65536,
      timeoutMillis: 500,
      redactionConfig: buildRedactionConfig({ enabled: true }),
      captureForTests: true,
    });
    await generateText({
      model: textModel(),
      prompt: "x",
      telemetry: morseTelemetry({ integration: LegacyOpenTelemetry }),
    });
    expect(await exportedSpans()).toHaveLength(0);
  });
});

describe("morseTelemetry() when Morse is not ready", () => {
  it("returns { isEnabled: false } and warns exactly once, never throwing", () => {
    // engine never configured
    const first = morseTelemetry({ integration: LegacyOpenTelemetry, functionId: "a" });
    const second = morseTelemetry({ integration: LegacyOpenTelemetry, functionId: "b" });
    expect(first).toEqual({ isEnabled: false });
    expect(second).toEqual({ isEnabled: false });
    const warnings = morseWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("morse.init");
    expect(warnings[0]).toContain("once per process");
  });

  it("lets the AI SDK call proceed untouched and records nothing", async () => {
    const result = await generateText({
      model: textModel("still works"),
      prompt: "x",
      telemetry: morseTelemetry({ integration: LegacyOpenTelemetry }),
    });
    expect(result.text).toBe("still works");
  });

  it("disables telemetry (and says why) when no integration class is passed", () => {
    configureEngine();
    const settings = morseTelemetry({} as never);
    expect(settings).toEqual({ isEnabled: false });
    expect(morseWarnings()[0]).toContain("@ai-sdk/otel");
  });
});

describe("morseTracer()", () => {
  it("is safe to create before init and starts recording once the engine exists", async () => {
    const tracer = morseTracer({ metadata: { k: "v" } });
    tracer.startSpan("before-init").end();
    expect(morseWarnings()).toHaveLength(1);

    configureEngine();
    const span = tracer.startSpan("after-init");
    span.end();
    const spans = await exportedSpans();
    const recorded = spans.find((s) => s.name === "after-init")!;
    expect(recorded.attributes["ai.telemetry.metadata.k"]).toBe("v");
  });

  it("survives a second configure(): it resolves the live provider per span", async () => {
    configureEngine();
    const tracer = morseTracer();
    configureEngine(); // tears down the first provider
    tracer.startSpan("post-reinit").end();
    expect((await exportedSpans()).map((s) => s.name)).toContain("post-reinit");
  });
});

describe("module shape", () => {
  it("exports the helpers from the vercel-ai entry point alongside createTracedVercelAI", () => {
    expect(typeof vercelAi.morseTelemetry).toBe("function");
    expect(typeof vercelAi.morseTracer).toBe("function");
    expect(typeof vercelAi.createTracedVercelAI).toBe("function");
  });

  it("the browser engine exposes getTracer() => null, so morseTelemetry() disables itself there", () => {
    expect(browserProvider.getEngine().getTracer()).toBeNull();
  });
});
