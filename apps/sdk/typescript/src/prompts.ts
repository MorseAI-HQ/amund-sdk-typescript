/**
 * Hosted prompt fetch (`getPrompt`).
 *
 * Deliberately thin: one GET, typed result, typed errors. No retry, no
 * fallback. Linking the active run is done by the caller (`index.ts`, UP-09). An
 * in-memory cache exists but is OFF unless `cacheTtlSeconds` is passed. Mirrors the Python SDK's
 * `morse_ai.get_prompt`.
 */

/** Timeout for the single fetch request, in ms. */
const FETCH_TIMEOUT_MS = 5_000;

/** Base class for hosted-prompt fetch errors. */
export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 403: the API key lacks the `prompts:read` scope. */
export class PromptAccessError extends PromptError {}

/** 404: no such prompt, label or version for this organization. */
export class PromptNotFoundError extends PromptError {}

/** 429: fetch rate limit hit. `retryAfter` is in seconds (or undefined). */
export class PromptRateLimitError extends PromptError {
  readonly retryAfter: number | undefined;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

export interface GetPromptOptions {
  /** Label to resolve. Default `"production"` when neither label nor version is given. */
  label?: string;
  /** Exact version number. Mutually exclusive with `label`. */
  version?: number;
  /** A previous result's `etag`; a 304 then returns `{ notModified: true, etag }`. */
  ifNoneMatch?: string;
  /**
   * Seconds to serve a fetched prompt from a process-local LRU cache. Unset or 0
   * means no cache use at all. A stale entry is revalidated with `If-None-Match`;
   * errors always propagate. Ignored when `ifNoneMatch` is passed.
   */
  cacheTtlSeconds?: number;
  /**
   * Link the active run to the fetched prompt (name + version, `link_source: "fetch"`).
   * Default `true`; pass `false` to opt out. No active run: nothing happens.
   */
  link?: boolean;
}

/** A fetched prompt version. */
export interface Prompt {
  notModified: false;
  name: string;
  version: number;
  templateText: string;
  labels: string[];
  etag: string;
}

/** Returned on a 304: only the etag is known. */
export interface PromptNotModified {
  notModified: true;
  etag: string | undefined;
}

export type GetPromptResult = Prompt | PromptNotModified;

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** @internal Performs the GET; `endpoint` is the SDK's configured ingest URL. */
export async function fetchPrompt(
  endpoint: string,
  apiKey: string,
  name: string,
  options: GetPromptOptions,
): Promise<GetPromptResult> {
  const { label, version, ifNoneMatch } = options;
  if (label !== undefined && version !== undefined) {
    throw new TypeError("Pass either label or version, not both");
  }
  const url = new URL(endpoint);
  url.pathname = `/api/v1/prompts/${encodeURIComponent(name)}`;
  url.search =
    version !== undefined
      ? `version=${encodeURIComponent(String(version))}`
      : `label=${encodeURIComponent(label ?? "production")}`;
  url.hash = "";

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    // Network failures propagate as fetch's own TypeError / AbortError.
    resp = await globalThis.fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 304) {
    return { notModified: true, etag: resp.headers.get("ETag") ?? ifNoneMatch };
  }
  if (resp.status === 403) {
    throw new PromptAccessError(
      "This API key cannot fetch hosted prompts: it is missing the 'prompts:read' scope. " +
        "Rotate the key with that scope enabled.",
    );
  }
  if (resp.status === 404) {
    throw new PromptNotFoundError(`Prompt not found: "${name}"`);
  }
  if (resp.status === 429) {
    const retryAfter = parseRetryAfter(resp.headers.get("Retry-After"));
    throw new PromptRateLimitError(
      "Prompt fetch rate limit exceeded" +
        (retryAfter !== undefined ? `; retry after ${retryAfter}s` : ""),
      retryAfter,
    );
  }
  if (!resp.ok) {
    throw new PromptError(`Prompt fetch failed with HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    name: string;
    version: number;
    template_text: string;
    labels?: string[];
    etag?: string;
  };
  return {
    notModified: false,
    name: data.name,
    version: data.version,
    templateText: data.template_text,
    labels: data.labels ?? [],
    etag: data.etag ?? resp.headers.get("ETag") ?? "",
  };
}

// --- Optional in-memory cache (SPF-04..06). OFF unless cacheTtlSeconds > 0. ---

const DEFAULT_MAX_ENTRIES = 256;
let maxEntries = DEFAULT_MAX_ENTRIES;
let now: () => number = () => performance.now();
/** Insertion order = recency (oldest first). */
const cache = new Map<string, { prompt: Prompt; at: number }>();

/** Set the cache size limit (default 256) and evict down to it. */
export function configurePromptCache(options: { maxEntries?: number } = {}): void {
  const n = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(n) || n < 1) throw new RangeError("maxEntries must be an integer >= 1");
  maxEntries = n;
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
}

/** Empty the prompt cache. */
export function clearPromptCache(): void {
  cache.clear();
}

/** @internal Test hooks: inject the clock (ms) and peek at the cache size. */
export const _promptCacheTesting = {
  setClock(fn: (() => number) | null): void {
    now = fn ?? (() => performance.now());
  },
  size: (): number => cache.size,
  reset(): void {
    cache.clear();
    maxEntries = DEFAULT_MAX_ENTRIES;
    now = () => performance.now();
  },
};

// The key is held in process memory only; it separates entries per API key.
function cacheKey(endpoint: string, apiKey: string, name: string, o: GetPromptOptions): string {
  return JSON.stringify([
    endpoint,
    apiKey,
    name,
    o.version !== undefined ? ["version", o.version] : ["label", o.label ?? "production"],
  ]);
}

/**
 * @internal The SDK's own cached Prompt for this selector, ignoring freshness; used to
 * resolve a 304 for linking (UP-09). Only returned when its etag equals `etag`, so a
 * 304 never links a version other than the one the server just confirmed.
 */
export function peekCachedPrompt(
  endpoint: string,
  apiKey: string,
  name: string,
  options: GetPromptOptions,
  etag: string | undefined,
): Prompt | undefined {
  const entry = cache.get(cacheKey(endpoint, apiKey, name, options));
  if (!entry) return undefined;
  if (etag !== undefined && entry.prompt.etag !== etag) return undefined;
  return entry.prompt;
}

/** @internal `fetchPrompt` with the opt-in cache. */
export async function fetchPromptCached(
  endpoint: string,
  apiKey: string,
  name: string,
  options: GetPromptOptions,
): Promise<GetPromptResult> {
  const { label, version, ifNoneMatch, cacheTtlSeconds } = options;
  if (!cacheTtlSeconds || cacheTtlSeconds <= 0 || ifNoneMatch) {
    return fetchPrompt(endpoint, apiKey, name, options);
  }
  if (label !== undefined && version !== undefined) {
    throw new TypeError("Pass either label or version, not both");
  }
  const key = cacheKey(endpoint, apiKey, name, options);
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry); // most recently used
    if (now() - entry.at < cacheTtlSeconds * 1000) return entry.prompt;
  }
  const result = await fetchPrompt(endpoint, apiKey, name, {
    label,
    version,
    ifNoneMatch: entry?.prompt.etag,
  });
  let prompt: Prompt;
  if (result.notModified) {
    if (!entry) return result; // cannot happen without a sent etag; do not cache it
    prompt = entry.prompt;
  } else {
    prompt = result;
  }
  cache.delete(key);
  cache.set(key, { prompt, at: now() });
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
  return prompt;
}
