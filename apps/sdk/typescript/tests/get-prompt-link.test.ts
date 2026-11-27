/**
 * getPrompt links the active run (unified-prompts UP-09). `fetch` is stubbed;
 * nothing touches the network. Both wires are asserted: the JSON trace dict and
 * real OTel spans captured by the engine's in-memory recorder.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import * as morse from "../src/index";
import { getEngine } from "../src/_internal/otel-provider";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { _promptCacheTesting } from "../src/prompts";

const BASE = "https://api.morse.test";
const BODY = {
  name: "triage",
  version: 3,
  template_text: "Hello {{user}}",
  labels: ["production"],
  etag: '"abc"',
};
const ENV_KEYS = ["MORSE_API_KEY", "MORSE_ENDPOINT", "MORSE_DISABLED", "MORSE_LEGACY_TRANSPORT"];

type PromptWire = { name: string; version?: number; span_id?: string; link_source?: string };

let promptReplies: Response[];
let promptCalls: number;
let infoSpy: MockInstance<typeof console.info>;

function replyPrompt(status: number, body?: unknown, headers: Record<string, string> = {}) {
  promptReplies.push(
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  );
}

function lastPrompts(): PromptWire[] {
  const t = morse._getLastTraceForTesting() as { trace: { prompts?: PromptWire[] } } | null;
  return t?.trace.prompts ?? [];
}

function linkInfoLines(): string[] {
  return infoSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("getPrompt() linked the active run"));
}

beforeEach(() => {
  morse._resetForTesting();
  _promptCacheTesting.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MORSE_API_KEY = "mk_test_fake"; // pragma: allowlist secret
  process.env.MORSE_ENDPOINT = `${BASE}/api/v1/traces/batch`;
  promptReplies = [];
  promptCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/v1/prompts/")) {
        promptCalls += 1;
        const next = promptReplies.shift();
        if (!next) throw new Error("unexpected prompt fetch");
        return next;
      }
      return new Response("{}", { status: 200 }); // trace / telemetry sends
    }),
  );
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  morse._resetForTesting();
  _promptCacheTesting.reset();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("getPrompt links the active run (UP-09)", () => {
  it("links name@version with link_source fetch on a 200 inside a run", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    await morse.runTraced({ agentName: "a" }, async () => {
      await morse.getPrompt("triage");
      return null;
    });
    expect(lastPrompts()).toEqual([{ name: "triage", version: 3, link_source: "fetch" }]);
  });

  it("pins the reference to the span it was called in", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    let spanId: string | undefined;
    await morse.runTraced({ agentName: "a" }, async () => {
      await morse.spanAsync({ name: "classify", type: "llm" }, async (h) => {
        spanId = (h as unknown as { span_id?: string; spanId?: string } | null)?.span_id;
        await morse.getPrompt("triage");
      });
      return null;
    });
    const refs = lastPrompts();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: "triage", version: 3, link_source: "fetch" });
    expect(typeof refs[0]!.span_id).toBe("string");
    if (spanId) expect(refs[0]!.span_id).toBe(spanId);
  });

  it("is a no-op with no active run, and still returns the prompt", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    const prompt = await morse.getPrompt("triage");
    expect(prompt).toMatchObject({ notModified: false, version: 3 });
    expect(morse._getLastTraceForTesting()).toBeNull();
    expect(linkInfoLines()).toHaveLength(0);
  });

  it("does not link with link:false", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    await morse.runTraced({ agentName: "a" }, async () => {
      await morse.getPrompt("triage", { link: false });
      return null;
    });
    expect(lastPrompts()).toEqual([]);
    expect(linkInfoLines()).toHaveLength(0);
  });

  it("links the run active at CALL time on an SDK cache hit (no request)", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 }); // warm, outside any run
    await morse.runTraced({ agentName: "second-run" }, async () => {
      const again = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
      expect(again).toMatchObject({ notModified: false, version: 3 });
      return null;
    });
    expect(promptCalls).toBe(1); // second call served from cache
    expect(lastPrompts()).toEqual([{ name: "triage", version: 3, link_source: "fetch" }]);
  });

  it("links a 304 from the SDK's own cached prompt when its etag matches", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    replyPrompt(304, undefined, { ETag: '"abc"' });
    await morse.runTraced({ agentName: "a" }, async () => {
      const r = await morse.getPrompt("triage", { ifNoneMatch: '"abc"' });
      expect(r).toEqual({ notModified: true, etag: '"abc"' });
      return null;
    });
    expect(lastPrompts()).toEqual([{ name: "triage", version: 3, link_source: "fetch" }]);
  });

  it("links nothing on a 304 when the SDK holds no cached prompt", async () => {
    // @spec: UP-09
    replyPrompt(304, undefined, { ETag: '"abc"' });
    await morse.runTraced({ agentName: "a" }, async () => {
      const r = await morse.getPrompt("triage", { ifNoneMatch: '"abc"' });
      expect(r.notModified).toBe(true);
      return null;
    });
    expect(lastPrompts()).toEqual([]);
  });

  it("keeps ONE reference when setPrompt and getPrompt agree, tagged fetch (either order)", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.setPrompt("triage", 3);
      await morse.getPrompt("triage");
      return null;
    });
    expect(lastPrompts()).toEqual([{ name: "triage", version: 3, link_source: "fetch" }]);

    replyPrompt(200, BODY);
    await morse.runTraced({ agentName: "b" }, async () => {
      await morse.getPrompt("triage");
      morse.setPrompt("triage", 3);
      return null;
    });
    expect(lastPrompts()).toEqual([{ name: "triage", version: 3, link_source: "fetch" }]);
  });

  it("leaves a setPrompt-only reference without link_source", async () => {
    // @spec: UP-09
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.setPrompt("triage", 3);
      return null;
    });
    expect(lastPrompts()).toEqual([{ name: "triage", version: 3 }]);
  });

  it("logs one info line per process, naming the opt-out", async () => {
    // @spec: UP-09
    replyPrompt(200, BODY);
    replyPrompt(200, BODY);
    await morse.runTraced({ agentName: "a" }, async () => {
      await morse.getPrompt("triage");
      await morse.getPrompt("triage");
      return null;
    });
    const lines = linkInfoLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("{ link: false }");
  });

  it("never throws when linking fails; errors from the fetch itself still propagate", async () => {
    // @spec: UP-09
    morse.init({ apiKey: "mk_test_fake", endpoint: `${BASE}/api/v1/traces/batch` }); // pragma: allowlist secret
    infoSpy.mockImplementation(() => {
      throw new Error("hostile console");
    });
    replyPrompt(200, BODY);
    await morse.runTraced({ agentName: "a" }, async () => {
      await expect(morse.getPrompt("triage")).resolves.toMatchObject({ version: 3 });
      return null;
    });
    replyPrompt(404);
    await morse.runTraced({ agentName: "a" }, async () => {
      await expect(morse.getPrompt("missing")).rejects.toThrow(/not found/i);
      return null;
    });
  });
});

describe("OTLP wire (UP-09)", () => {
  function configureRecorder() {
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
    });
    return engine;
  }

  it("sets amund.prompt.link_source=fetch for linked prompts only", async () => {
    // @spec: UP-09
    morse.init({ apiKey: "mk_test_fake", endpoint: `${BASE}/api/v1/traces/batch` }); // pragma: allowlist secret
    const engine = configureRecorder(); // after init, so the recorder replaces the real exporter
    replyPrompt(200, BODY);
    replyPrompt(200, { ...BODY, name: "router", version: 5, etag: '"r"' });
    await morse.runTraced({ agentName: "otlp-link" }, async () => {
      await morse.getPrompt("triage"); // trace-level -> root, fetch
      await morse.spanAsync({ name: "declared-step", type: "llm" }, async () => {
        morse.setPrompt("summarizer", 2); // declared, no link_source
      });
      await morse.spanAsync({ name: "route", type: "llm" }, async () => {
        await morse.getPrompt("router"); // span-level, fetch
      });
      return null;
    });
    await engine.flush();
    const byName = new Map<string, ReadableSpan>();
    for (const s of engine.recorder!.spans) byName.set(s.name, s);
    const root = byName.get("otlp-link")!;
    expect(root.attributes["amund.prompt.name"]).toBe("triage");
    expect(root.attributes["amund.prompt.version"]).toBe(3);
    expect(root.attributes["amund.prompt.link_source"]).toBe("fetch");
    const declared = byName.get("declared-step")!;
    expect(declared.attributes["amund.prompt.name"]).toBe("summarizer");
    expect(declared.attributes["amund.prompt.link_source"]).toBeUndefined();
    const route = byName.get("route")!;
    expect(route.attributes["amund.prompt.name"]).toBe("router");
    expect(route.attributes["amund.prompt.link_source"]).toBe("fetch");
  });
});
