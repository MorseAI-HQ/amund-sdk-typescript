/**
 * HTTP auto-capture for the TypeScript SDK (INFRACAP-06) — parity with the
 * Python SDK's `infra_capture.py` httpx/requests capture.
 *
 * Mechanism: `diagnostics_channel`, not monkey-patching. Node publishes
 * `http.client.*` for `http`/`https` requests and undici publishes
 * `undici:request:*` for `fetch()` (the built-in and a userland `undici`
 * alike). Subscribing needs no dependency, works the same in ESM and CJS, and
 * cannot change a request's behaviour — unlike wrapping `ClientRequest`, where
 * adding an `error` listener would silently swallow an error the application
 * meant to crash on.
 *
 * Redaction is the same as Python's: the span name is `METHOD host`. The path,
 * query string, headers and bodies are never read. LLM provider hosts are
 * excluded (the adapters already record those as `llm` spans), as is the Morse
 * ingest host so the SDK's own telemetry does not trace itself.
 *
 * Spans are detached (see `tracing.ts::startDetachedSpan`): a request starts in
 * one callback and finishes in another, so it must not sit on the span stack.
 */

import { subscribe, unsubscribe } from "node:diagnostics_channel";

import { getEndpoint, getHttpExcludeHosts, PROD_API_HOSTS } from "./env";
import { admitInfraCall, errorLabel } from "./infra-shared";
import { getActiveTraceState, startDetachedSpan, type DetachedSpan } from "./tracing";

// Same list, and same reasons, as Python's `_DEFAULT_EXCLUDED_HOSTS`.
const DEFAULT_EXCLUDED_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.cohere.ai",
  "api.mistral.ai",
  "router.huggingface.co",
  "api-inference.huggingface.co",
];

let excluded = new Set<string>();
const pending = new WeakMap<object, DetachedSpan>();
let subscribed: Array<[string, (message: unknown) => void]> = [];

function hostOf(urlLike: unknown): string | null {
  try {
    const text = String(urlLike);
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isExcluded(host: string): boolean {
  for (const h of excluded) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  return false;
}

/** 5xx, 408 and 429 mean the dependency failed; an ordinary 4xx is the caller's bug. */
function isDependencyFailure(code: number): boolean {
  return code >= 500 || code === 408 || code === 429;
}

function open(method: unknown, host: string | null): DetachedSpan | null {
  // Untraced calls (the common case) stop here, before any string work.
  if (getActiveTraceState() === null) return null;
  if (!host || isExcluded(host)) return null;
  if (!admitInfraCall("http")) return null;
  const verb = typeof method === "string" && method ? method.toUpperCase() : "GET";
  return startDetachedSpan({ name: `${verb} ${host}`, type: "http" });
}

function close(request: object, statusCode?: unknown, error?: unknown): void {
  const det = pending.get(request);
  if (det === undefined) return;
  pending.delete(request);
  try {
    if (typeof statusCode === "number") {
      det.span.metadata = { ...det.span.metadata, "http.status_code": statusCode };
      if (isDependencyFailure(statusCode)) {
        det.end(`HTTP ${statusCode}`);
        return;
      }
    }
    det.end(error === undefined ? undefined : errorLabel(error));
  } catch {
    // Capture must never disturb the request.
  }
}

/* --- node:http / node:https ------------------------------------------- */

type NodeRequest = { host?: string; method?: string };

const onNodeStart = (message: unknown): void => {
  try {
    if (getActiveTraceState() === null) return;
    const request = (message as { request?: NodeRequest }).request;
    if (!request) return;
    const host = typeof request.host === "string" ? request.host.toLowerCase() : null;
    const det = open(request.method, host);
    if (det) pending.set(request, det);
  } catch {
    // ignore
  }
};

const onNodeFinish = (message: unknown): void => {
  const { request, response } = message as {
    request?: object;
    response?: { statusCode?: number };
  };
  if (request) close(request, response?.statusCode);
};

const onNodeError = (message: unknown): void => {
  const { request, error } = message as { request?: object; error?: unknown };
  if (request) close(request, undefined, error ?? new Error("request failed"));
};

/* --- undici (fetch) --------------------------------------------------- */

type UndiciRequest = { origin?: unknown; method?: string };

const onUndiciCreate = (message: unknown): void => {
  try {
    if (getActiveTraceState() === null) return;
    const request = (message as { request?: UndiciRequest }).request;
    if (!request) return;
    const det = open(request.method, hostOf(request.origin));
    if (det) pending.set(request, det);
  } catch {
    // ignore
  }
};

const onUndiciHeaders = (message: unknown): void => {
  const { request, response } = message as {
    request?: object;
    response?: { statusCode?: number };
  };
  if (request) close(request, response?.statusCode);
};

const onUndiciError = (message: unknown): void => {
  const { request, error } = message as { request?: object; error?: unknown };
  if (request) close(request, undefined, error ?? new Error("request failed"));
};

const CHANNELS: Array<[string, (message: unknown) => void]> = [
  ["http.client.request.start", onNodeStart],
  ["http.client.response.finish", onNodeFinish],
  ["http.client.request.error", onNodeError],
  ["undici:request:create", onUndiciCreate],
  ["undici:request:headers", onUndiciHeaders],
  ["undici:request:error", onUndiciError],
];

/**
 * Start recording HTTP client calls made inside an active trace. Idempotent
 * (a second call replaces the exclusion set and subscribes once).
 *
 * @param endpoint The Morse ingest URL in use, so it is never traced. Every
 *   production API host (`api.amundai.com`, `api.morseai.dev`) and
 *   `MORSE_ENDPOINT` are always excluded as well.
 */
export function enableHttpCapture(
  opts: { endpoint?: string; extraExcludedHosts?: string[] } = {},
): void {
  disableHttpCapture();
  excluded = new Set([...DEFAULT_EXCLUDED_HOSTS, ...PROD_API_HOSTS]);
  for (const url of [getEndpoint(), opts.endpoint]) {
    const host = url ? hostOf(url) : null;
    if (host) excluded.add(host);
  }
  for (const h of [...getHttpExcludeHosts(), ...(opts.extraExcludedHosts ?? [])]) {
    excluded.add(h.trim().toLowerCase());
  }
  for (const [name, handler] of CHANNELS) {
    subscribe(name, handler);
    subscribed.push([name, handler]);
  }
}

/** Stop recording and forget exclusions. Primarily for tests. */
export function disableHttpCapture(): void {
  for (const [name, handler] of subscribed) {
    try {
      unsubscribe(name, handler);
    } catch {
      // ignore
    }
  }
  subscribed = [];
}

/** Exclude one more host at runtime. */
export function addExcludedHttpHost(host: string): void {
  if (host.trim()) excluded.add(host.trim().toLowerCase());
}

/** @internal test hook */
export function _isHttpCaptureActiveForTesting(): boolean {
  return subscribed.length > 0;
}
