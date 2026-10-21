/**
 * getPrompt — thin hosted-prompt fetch (openspec prompt-registry-sdk-fetch).
 * `fetch` is stubbed; nothing touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";

const BASE = "https://api.morse.test";
const BODY = {
  name: "triage",
  version: 3,
  template_text: "Hello {{user}}",
  labels: ["production"],
  etag: '"abc"',
};

const ENV_KEYS = ["MORSE_API_KEY", "MORSE_ENDPOINT", "MORSE_DISABLED"];

let fetchMock: ReturnType<typeof vi.fn>;

function lastCall(): { url: URL; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: new URL(url), init };
}

function reply(status: number, body?: unknown, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  );
}

beforeEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MORSE_API_KEY = "mk_test_fake"; // pragma: allowlist secret
  process.env.MORSE_ENDPOINT = `${BASE}/api/v1/traces/batch`;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("getPrompt", () => {
  it("defaults to label=production with bearer auth", async () => {
    // @spec: SPF-01
    reply(200, BODY);
    const p = await morse.getPrompt("triage");
    const { url, init } = lastCall();
    expect(url.origin + url.pathname).toBe(`${BASE}/api/v1/prompts/triage`);
    expect(url.search).toBe("?label=production");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mk_test_fake");
    expect(p).toEqual({
      notModified: false,
      name: "triage",
      version: 3,
      templateText: "Hello {{user}}",
      labels: ["production"],
      etag: '"abc"',
    });
  });

  it("selects by label", async () => {
    // @spec: SPF-01
    reply(200, BODY);
    await morse.getPrompt("triage", { label: "staging" });
    expect(lastCall().url.search).toBe("?label=staging");
  });

  it("selects by version without a label", async () => {
    // @spec: SPF-01
    reply(200, BODY);
    await morse.getPrompt("triage", { version: 3 });
    expect(lastCall().url.search).toBe("?version=3");
  });

  it("throws TypeError for both selectors before any request", async () => {
    // @spec: SPF-01
    await expect(morse.getPrompt("triage", { label: "x", version: 1 })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("URL-encodes the name", async () => {
    // @spec: SPF-01
    reply(200, BODY);
    await morse.getPrompt("team/triage v2?");
    expect(lastCall().url.pathname).toBe("/api/v1/prompts/team%2Ftriage%20v2%3F");
  });

  it("sends If-None-Match and returns notModified on 304", async () => {
    // @spec: SPF-02
    reply(304, undefined, { ETag: '"abc"' });
    const p = await morse.getPrompt("triage", { ifNoneMatch: '"abc"' });
    expect((lastCall().init.headers as Record<string, string>)["If-None-Match"]).toBe('"abc"');
    expect(p).toEqual({ notModified: true, etag: '"abc"' });
  });

  it("sends no If-None-Match by default", async () => {
    // @spec: SPF-02
    reply(200, BODY);
    await morse.getPrompt("triage");
    expect(lastCall().init.headers as Record<string, string>).not.toHaveProperty("If-None-Match");
  });

  it("403 throws PromptAccessError naming the scope", async () => {
    // @spec: SPF-03
    reply(403);
    const err = await morse.getPrompt("triage").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(morse.PromptAccessError);
    expect((err as Error).message).toContain("prompts:read");
  });

  it("404 throws PromptNotFoundError", async () => {
    // @spec: SPF-03
    reply(404);
    await expect(morse.getPrompt("nope")).rejects.toBeInstanceOf(morse.PromptNotFoundError);
  });

  it("429 throws PromptRateLimitError with retryAfter and does not retry", async () => {
    // @spec: SPF-03
    reply(429, { error: { code: "RATE_001" } }, { "Retry-After": "7" });
    const err = await morse.getPrompt("triage").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(morse.PromptRateLimitError);
    expect((err as InstanceType<typeof morse.PromptRateLimitError>).retryAfter).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("typed errors share the PromptError base", () => {
    // @spec: SPF-03
    expect(new morse.PromptAccessError("x")).toBeInstanceOf(morse.PromptError);
    expect(new morse.PromptNotFoundError("x")).toBeInstanceOf(morse.PromptError);
    expect(new morse.PromptRateLimitError("x", 1)).toBeInstanceOf(morse.PromptError);
  });

  it("network errors propagate unchanged, without retry", async () => {
    // @spec: SPF-03
    const boom = new TypeError("fetch failed");
    fetchMock.mockRejectedValueOnce(boom);
    await expect(morse.getPrompt("triage")).rejects.toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws PromptError when the SDK is not initialized", async () => {
    // @spec: SPF-03
    delete process.env.MORSE_API_KEY;
    await expect(morse.getPrompt("triage")).rejects.toBeInstanceOf(morse.PromptError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
