/**
 * HTTP endpoint classifier — maps known vector-store URLs to `memory_type`.
 *
 * Pure functions only. Never throws — returns `undefined` on any error.
 *
 * Mirrors the Python SDK's `morse_ai/instrumentation/http_classifier.py`
 * exactly: same patterns, same `memory_type` vocabulary ("retrieval" | "store").
 * Keep the two files in sync — a new vector-store pattern added to one SDK
 * must be added to the other in the same change.
 */

export type MemoryType = "retrieval" | "store";

/** Each entry: [hostPattern, pathPattern, memoryType]. */
const VECTOR_STORE_PATTERNS_RAW: ReadonlyArray<readonly [string, string, MemoryType]> = [
  [String.raw`.*\.pinecone\.io`, String.raw`/query`, "retrieval"],
  [String.raw`.*\.pinecone\.io`, String.raw`/vectors/upsert`, "store"],
  [String.raw`.*\.weaviate\.network`, String.raw`/v1/graphql`, "retrieval"],
  [String.raw`.*\.weaviate\.network`, String.raw`/v1/objects`, "store"],
  // Chroma v4 (chromadb < 0.5)
  [String.raw`localhost|127\.0\.0\.1`, String.raw`/api/v1/collections/.*/query`, "retrieval"],
  // Chroma 0.5+
  [
    String.raw`localhost|127\.0\.0\.1`,
    String.raw`/api/v2/tenants/.*/collections/.*/query`,
    "retrieval",
  ],
  // Qdrant (cloud or local)
  [String.raw`.*\.qdrant\.io|localhost`, String.raw`/collections/.*/points/search`, "retrieval"],
  [String.raw`.*\.qdrant\.io|localhost`, String.raw`/collections/.*/points`, "store"],
];

/** Compiled once at module load. Patterns are anchored to match the whole string (Python's `fullmatch`). */
const COMPILED_PATTERNS: ReadonlyArray<readonly [RegExp, RegExp, MemoryType]> =
  VECTOR_STORE_PATTERNS_RAW.map(
    ([host, path, memoryType]) =>
      [new RegExp(`^(?:${host})$`), new RegExp(`^(?:${path})$`), memoryType] as const,
  );

/**
 * Return `memory_type` ("retrieval" or "store") if the URL matches a known
 * vector store, or `undefined` when no pattern matches or an error occurs.
 *
 * @param host Hostname (and optional port) of the HTTP request, e.g. "api.pinecone.io".
 * @param path URL path component, e.g. "/query".
 */
export function classifyHttpCall(host: string, path: string): MemoryType | undefined {
  try {
    for (const [hostPat, pathPat, memoryType] of COMPILED_PATTERNS) {
      if (hostPat.test(host) && pathPat.test(path)) {
        return memoryType;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Integration note (left for follow-up wiring — not implemented in this gap):
//
// The TS SDK has exactly one precedent for global outbound-HTTP interception
// today: `wrapFetch()` in `src/vercel-ai/index.ts`, which patches
// `globalThis.fetch` to inject a `traceparent` header while a trace is
// active. There is no shared/general fetch-interception hook point yet (a
// sibling MHQ-482 gap may introduce one in `src/_internal/auto-detect.ts` —
// check there before adding a second ad-hoc patch site).
//
// When that hook exists, call `classifyHttpCall(url.hostname, url.pathname)`
// from within it and attach the result as a `memory_type` span attribute,
// matching how Python's callers are expected to use `classify_http_span`
// (also not yet wired into a span-creation path as of this port — see
// apps/sdk/python/src/morse_ai/instrumentation/http_classifier.py).
// ---------------------------------------------------------------------------
