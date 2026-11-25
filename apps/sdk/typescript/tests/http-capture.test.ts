/**
 * INFRACAP-01..04/06 — HTTP auto-capture for the TypeScript SDK.
 *
 * Real requests against a local server: `fetch` goes through undici's
 * diagnostics channels, `http.get` through Node's, and both must produce the
 * same redacted span as Python's httpx/requests capture.
 */

import http from "node:http";
import { channel } from "node:diagnostics_channel";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  addExcludedHttpHost,
  disableHttpCapture,
  enableHttpCapture,
  _isHttpCaptureActiveForTesting,
} from "../src/_internal/http-capture";
import { maybeEnableInfraCaptureFromEnv } from "../src/_internal/infra-capture";
import { INFRA_CAPS } from "../src/_internal/infra-shared";
import type { SpanData } from "../src/_internal/spans";
import { runAsync, type TraceState } from "../src/_internal/tracing";

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/boom")) res.statusCode = 503;
    else if (url.startsWith("/missing")) res.statusCode = 404;
    else if (url.startsWith("/slow-down")) res.statusCode = 429;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  enableHttpCapture();
});

afterEach(() => {
  disableHttpCapture();
  for (const k of [
    "MORSE_CAPTURE_HTTP",
    "MORSE_CAPTURE_INFRA",
    "MORSE_CAPTURE_HTTP_EXCLUDE_HOSTS",
  ]) {
    delete process.env[k];
  }
});

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

async function inTrace(fn: () => Promise<void>): Promise<SpanData[]> {
  let state!: TraceState;
  await runAsync({ agentName: "http-agent" }, async (handle) => {
    state = handle._state;
    await fn();
  });
  return state.completedSpans.filter((s) => s.type === "http");
}

describe("HTTP capture", () => {
  it("fetch inside a trace records `METHOD host` with the status, and nothing else", async () => {
    // @spec: INFRACAP-06
    const spans = await inTrace(async () => {
      const res = await fetch(`${base}/users/42?token=sk-canary-secret`, {
        method: "POST",
        headers: { authorization: "Bearer sk-canary-header" },
        body: "canary-body",
      });
      await res.text();
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("POST 127.0.0.1");
    expect(spans[0]!.metadata).toEqual({ "http.status_code": 200 });
    const wire = JSON.stringify(spans);
    for (const secret of ["sk-canary", "canary-body", "/users/42", "token="]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("node http.get inside a trace records the same shape", async () => {
    // @spec: INFRACAP-06
    const spans = await inTrace(async () => {
      await get(`${base}/orders?email=canary@example.com`);
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("GET 127.0.0.1");
    expect(JSON.stringify(spans)).not.toContain("canary");
  });

  it("is on by default through maybeEnableInfraCaptureFromEnv()", async () => {
    // @spec: INFRACAP-01
    disableHttpCapture();
    maybeEnableInfraCaptureFromEnv();
    expect(_isHttpCaptureActiveForTesting()).toBe(true);
    const spans = await inTrace(async () => {
      await (await fetch(`${base}/x`)).text();
    });
    expect(spans).toHaveLength(1);
  });

  it.each([
    ["MORSE_CAPTURE_HTTP", "0"],
    ["MORSE_CAPTURE_INFRA", "off"],
  ])("%s=%s switches it off", (name, value) => {
    // @spec: INFRACAP-02
    disableHttpCapture();
    process.env[name] = value;
    maybeEnableInfraCaptureFromEnv();
    expect(_isHttpCaptureActiveForTesting()).toBe(false);
  });

  it("records nothing outside a trace and leaves the request working", async () => {
    // @spec: INFRACAP-03
    const res = await fetch(`${base}/x`);
    expect(res.status).toBe(200);
    expect(await get(`${base}/x`)).toBe(200);
    // Nothing to assert on: there is no trace to hold a span. The point is that
    // neither call threw and both returned their real response.
  });

  it("marks 5xx, 408 and 429 failed but a plain 4xx completed", async () => {
    // @spec: INFRACAP-06
    const spans = await inTrace(async () => {
      await (await fetch(`${base}/boom`)).text();
      await (await fetch(`${base}/slow-down`)).text();
      await (await fetch(`${base}/missing`)).text();
    });
    expect(spans.map((s) => [s.metadata?.["http.status_code"], s.status])).toEqual([
      [503, "failed"],
      [429, "failed"],
      [404, "completed"],
    ]);
  });

  it("a connection error closes the span as failed", async () => {
    // @spec: INFRACAP-06
    const spans = await inTrace(async () => {
      await get("http://127.0.0.1:1/x").catch(() => undefined);
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
  });

  it("skips excluded hosts: runtime, env and LLM providers", async () => {
    // @spec: INFRACAP-06
    addExcludedHttpHost("127.0.0.1");
    expect(
      await inTrace(async () => {
        await get(`${base}/x`);
      }),
    ).toHaveLength(0);

    disableHttpCapture();
    process.env.MORSE_CAPTURE_HTTP_EXCLUDE_HOSTS = "Example.test, 127.0.0.1";
    enableHttpCapture();
    expect(
      await inTrace(async () => {
        await get(`${base}/x`);
      }),
    ).toHaveLength(0);

    disableHttpCapture();
    delete process.env.MORSE_CAPTURE_HTTP_EXCLUDE_HOSTS;
    enableHttpCapture();
    const spans = await inTrace(async () => {
      // An LLM provider is already an `llm` span from the adapter; recording it
      // as http as well would double-count. Published on the real channel the
      // way undici does, so no network is needed.
      channel("undici:request:create").publish({
        request: { origin: "https://api.openai.com", method: "POST", path: "/v1/chat" },
      });
      channel("undici:request:create").publish({
        request: { origin: "https://eu.api.anthropic.com", method: "POST", path: "/v1/m" },
      });
    });
    expect(spans).toHaveLength(0);
  });

  it("never traces the Morse ingest host", async () => {
    // @spec: INFRACAP-06
    disableHttpCapture();
    enableHttpCapture({ endpoint: `${base}/api/v1/traces/batch` });
    const spans = await inTrace(async () => {
      await get(`${base}/api/v1/traces/batch`);
    });
    expect(spans).toHaveLength(0);
  });

  it("never traces a production API host: the default and the api.morseai.dev alias", async () => {
    // @spec: INFRACAP-06
    disableHttpCapture();
    delete process.env.MORSE_ENDPOINT;
    enableHttpCapture();
    const spans = await inTrace(async () => {
      for (const origin of ["https://api.amundai.com", "https://api.morseai.dev"]) {
        channel("undici:request:create").publish({
          request: { origin, method: "POST", path: "/api/v1/traces/batch" },
        });
      }
    });
    expect(spans).toHaveLength(0);
  });

  it("caps http spans per trace and folds the rest into one summary span", async () => {
    // @spec: INFRACAP-04
    const original = INFRA_CAPS.http;
    INFRA_CAPS.http = 3;
    try {
      const spans = await inTrace(async () => {
        for (let i = 0; i < 7; i++) await (await fetch(`${base}/x`)).text();
      });
      const summaries = spans.filter((s) => s.metadata?.["infra.suppressed_count"] !== undefined);
      expect(spans).toHaveLength(4);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.metadata!["infra.suppressed_count"]).toBe(4);
    } finally {
      INFRA_CAPS.http = original;
    }
  });
});
