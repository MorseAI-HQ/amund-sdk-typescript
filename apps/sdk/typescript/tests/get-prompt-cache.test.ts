/**
 * getPrompt opt-in cache (SPF-04..06). `fetch` is stubbed and the clock is
 * injected; nothing touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { _promptCacheTesting } from "../src/prompts";

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
let t = 0;

function reply(status: number, body?: unknown, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  );
}

function sentHeaders(call: number): Record<string, string> {
  return (fetchMock.mock.calls[call] as [string, RequestInit])[1].headers as Record<string, string>;
}

beforeEach(() => {
  morse._resetForTesting();
  _promptCacheTesting.reset();
  t = 0;
  _promptCacheTesting.setClock(() => t);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MORSE_API_KEY = "mk_test_fake"; // pragma: allowlist secret
  process.env.MORSE_ENDPOINT = `${BASE}/api/v1/traces/batch`;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  morse._resetForTesting();
  _promptCacheTesting.reset();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("getPrompt cache", () => {
  it("is off by default: two calls, two requests, cache untouched", async () => {
    // @spec: SPF-04
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    await morse.getPrompt("triage");
    await morse.getPrompt("triage");
    await morse.getPrompt("triage", { cacheTtlSeconds: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(_promptCacheTesting.size()).toBe(0);
  });

  it("serves a hit within the TTL with one request", async () => {
    // @spec: SPF-04
    reply(200, BODY);
    const a = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    t += 1000;
    const b = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("bypasses the cache when the caller passes ifNoneMatch", async () => {
    // @spec: SPF-04
    reply(304, undefined, { ETag: '"abc"' });
    const p = await morse.getPrompt("triage", { ifNoneMatch: '"abc"', cacheTtlSeconds: 60 });
    expect(p.notModified).toBe(true);
    expect(_promptCacheTesting.size()).toBe(0);
  });

  it("revalidates a stale entry and refreshes it on 304", async () => {
    // @spec: SPF-05
    reply(200, BODY);
    const first = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    t += 61_000;
    reply(304, undefined, { ETag: '"abc"' });
    const second = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(sentHeaders(1)["If-None-Match"]).toBe('"abc"');
    expect(second).toEqual(first);
    expect(second.notModified).toBe(false);
    t += 30_000; // fresh again: the 304 refreshed the timestamp
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale entry on 200", async () => {
    // @spec: SPF-05
    reply(200, BODY);
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    t += 61_000;
    reply(200, { ...BODY, version: 4, etag: '"def"' });
    const p = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(p.notModified === false && p.version).toBe(4);
    const again = await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(again.notModified === false && again.version).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [500, morse.PromptError],
    [403, morse.PromptAccessError],
  ])("never masks a %i with stale data", async (status, errClass) => {
    // @spec: SPF-05
    reply(200, BODY);
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    t += 61_000;
    reply(status);
    await expect(morse.getPrompt("triage", { cacheTtlSeconds: 60 })).rejects.toBeInstanceOf(
      errClass,
    );
  });

  it("evicts the least recently used entry at maxEntries", async () => {
    // @spec: SPF-06
    morse.configurePromptCache({ maxEntries: 2 });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    const get = (n: string) => morse.getPrompt(n, { cacheTtlSeconds: 60 });
    await get("a");
    await get("b");
    await get("a"); // a is now most recent
    await get("c"); // evicts b
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await get("a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await get("b");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("clearPromptCache empties the cache", async () => {
    // @spec: SPF-06
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    morse.clearPromptCache();
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share entries between API keys", async () => {
    // @spec: SPF-04, SPF-06
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    morse._resetForTesting();
    process.env.MORSE_API_KEY = "mk_test_other"; // pragma: allowlist secret
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps label and version selectors separate", async () => {
    // @spec: SPF-04
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    await morse.getPrompt("triage", { cacheTtlSeconds: 60 });
    await morse.getPrompt("triage", { version: 3, cacheTtlSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
