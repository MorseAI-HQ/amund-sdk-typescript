/**
 * Client-side normalisation for the attribution facts (ATTR-01/04, MHQ-1275):
 * record keys, declared agent version, and prompt references.
 *
 * The server re-validates everything with the same rules, so this module exists
 * to keep bad input off the wire and to give the developer a reason when a value
 * is dropped. It follows the SDK's non-invasive rule: every function here
 * returns "dropped" instead of throwing, and none calls a customer's
 * `toString`/`valueOf` — only plain strings and numbers are accepted, so there is
 * no customer code to run.
 */

export const MAX_RECORD_KEYS = 20;
export const MAX_PROMPT_REFS = 20;
export const MAX_AGENT_VERSION_LENGTH = 128;
export const MAX_PROMPT_NAME_LENGTH = 255;
export const MAX_RECORD_KEY_VALUE_LENGTH = 256;

const RECORD_KEY_TYPE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export interface PromptRef {
  name: string;
  version?: number;
  /** Set only when `setPrompt()` ran inside a child span; absent means "the trace". */
  span_id?: string;
  /**
   * UP-09: `"fetch"` when `getPrompt()` created the reference by linking the active run.
   * Absent for `setPrompt()` (the server reads absent as "declared").
   */
  link_source?: "fetch";
}

const warned = new Set<string>();

/** One `console.warn` per kind per process — these sit in request paths. Never includes the value (it may be an id or PII). */
function warnOnce(kind: string, message: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  try {
    console.warn(`morse: ${message} (this warning prints once per process)`);
  } catch {
    // a hostile console must not break the host
  }
}

/** Test hook — re-arm the once-per-process warnings. */
export function _resetAttributionWarningsForTesting(): void {
  warned.clear();
}

/** Accepts string or finite number; anything else (objects, null, NaN) is dropped without being stringified. */
function plainToString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return v.toString();
  return null;
}

/**
 * Normalise one record-key pair, or return null when invalid.
 * Type: lower-cased, `^[a-z0-9][a-z0-9_.-]{0,63}$`. Value: string/number, trimmed, 1–256 chars.
 */
export function normalizeRecordKey(keyType: unknown, keyValue: unknown): [string, string] | null {
  if (typeof keyType !== "string") return null;
  const type = keyType.trim().toLowerCase();
  if (!RECORD_KEY_TYPE_RE.test(type)) return null;
  const raw = plainToString(keyValue);
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length < 1 || value.length > MAX_RECORD_KEY_VALUE_LENGTH) return null;
  return [type, value];
}

/**
 * Add `pairs` to `target`, enforcing validation and the 20-key cap. Re-setting an
 * existing type replaces its value (and never counts against the cap). Returns
 * how many pairs were dropped. Never throws.
 */
export function mergeRecordKeys(
  target: Record<string, string>,
  pairs: Iterable<readonly [unknown, unknown]>,
): number {
  let dropped = 0;
  for (const [t, v] of pairs) {
    const norm = normalizeRecordKey(t, v);
    if (norm === null) {
      dropped += 1;
      continue;
    }
    const [type, value] = norm;
    if (!(type in target) && Object.keys(target).length >= MAX_RECORD_KEYS) {
      dropped += 1;
      continue;
    }
    target[type] = value;
  }
  if (dropped > 0) {
    warnOnce(
      "record_keys",
      `dropped ${dropped} invalid record key(s). A key type must match ^[a-z0-9][a-z0-9_.-]{0,63}$ ` +
        `(lower-cased for you), a value must be a string or number of 1-256 characters, ` +
        `and a trace keeps at most ${MAX_RECORD_KEYS} keys`,
    );
  }
  return dropped;
}

/** Entries of an arbitrary object without ever throwing (hostile getters, non-objects). */
export function safeEntries(input: unknown): Array<[string, unknown]> {
  if (input === null || typeof input !== "object") return [];
  const out: Array<[string, unknown]> = [];
  try {
    for (const k of Object.keys(input as object)) {
      try {
        out.push([k, (input as Record<string, unknown>)[k]]);
      } catch {
        // an unreadable value costs that key, not the rest
      }
    }
  } catch {
    // unreadable object
  }
  return out;
}

/** Trim and truncate to 128; empty or non-string yields undefined. */
export function normalizeAgentVersion(v: unknown): string | undefined {
  const raw = plainToString(v);
  if (raw === null) return undefined;
  const s = raw.trim().slice(0, MAX_AGENT_VERSION_LENGTH);
  return s.length > 0 ? s : undefined;
}

/**
 * Normalise one prompt reference. A name is required (trimmed, ≤255). A version
 * must be an integer ≥1; any other version is dropped but the name is kept, which
 * is the same rule the server applies.
 */
export function normalizePromptRef(
  name: unknown,
  version?: unknown,
  spanId?: string,
): PromptRef | null {
  if (typeof name !== "string") return null;
  const n = name.trim().slice(0, MAX_PROMPT_NAME_LENGTH);
  if (n.length === 0) return null;
  const ref: PromptRef = { name: n };
  const v = coercePromptVersion(version);
  if (v !== undefined) ref.version = v;
  else if (version !== undefined && version !== null) {
    warnOnce(
      "prompt_version",
      "a setPrompt() version that is not a whole number >= 1 was dropped and only the " +
        'prompt name recorded; pass the registry version number (e.g. 3 or "3")',
    );
  }
  if (spanId) ref.span_id = spanId;
  return ref;
}

/**
 * MHQ-1415: `setPrompt("triage", "3")` used to drop the version silently. A
 * whole-number string (`"3"`, `"v3"`) is now read as that version; anything
 * else that is not an integer ≥1 is still dropped (the server keeps integer
 * versions only), but with a one-time warning.
 */
export function coercePromptVersion(version: unknown): number | undefined {
  if (typeof version === "number") {
    return Number.isInteger(version) && version >= 1 ? version : undefined;
  }
  if (typeof version === "string") {
    const m = /^v?(\d{1,9})$/i.exec(version.trim());
    if (m) {
      const n = Number(m[1]);
      return n >= 1 ? n : undefined;
    }
  }
  return undefined;
}

/**
 * Append a ref unless it duplicates one already held or the 20-ref cap is reached. Returns whether it was added.
 *
 * Dedupe key is (name, version, span_id). When a `setPrompt()` ref and a `getPrompt()` link
 * collide, ONE ref is kept and it is tagged `link_source: "fetch"` whichever came first:
 * "fetch" is the stronger provenance (the SDK saw the text), so it wins over "declared".
 */
export function addPromptRef(list: PromptRef[], ref: PromptRef): boolean {
  const existing = list.find(
    (p) => p.name === ref.name && p.version === ref.version && p.span_id === ref.span_id,
  );
  if (existing) {
    if (ref.link_source === "fetch") existing.link_source = "fetch";
    return false;
  }
  if (list.length >= MAX_PROMPT_REFS) {
    warnOnce(
      "prompt_refs",
      `a trace keeps at most ${MAX_PROMPT_REFS} prompt references; further setPrompt() calls are ignored`,
    );
    return false;
  }
  list.push(ref);
  return true;
}

export function warnPromptRejected(): void {
  warnOnce(
    "prompt_name",
    "setPrompt() needs a non-empty name of at most 255 characters; the call was ignored",
  );
}

export function warnPromptSpanShared(): void {
  warnOnce(
    "prompt_span_shared",
    "several prompt references were set on one span; OTLP carries one per span, so only the last " +
      "is exported. Call setPrompt() inside separate morse.span() blocks to record each",
  );
}

/** One prompt reference as OTLP carries it (`morse.prompt.*` span attributes). */
export interface OtlpPromptRef {
  name: string;
  version?: number;
  link_source?: "fetch";
}

/**
 * OTLP carries a single `morse.prompt.name`/`.version` pair per span. Assign each
 * ref to the span it was set on (refs with no span, or whose span never finished,
 * go to the root span). When several land on one span the LAST wins (matching the
 * Python SDK); the earlier ones are
 * reported by the caller via `warnPromptSpanShared()`. The JSON path keeps them all.
 */
export function assignPromptRefsToSpans(
  refs: unknown,
  knownSpanIds: ReadonlySet<string>,
  rootSpanId: string | undefined,
): { bySpan: Map<string, OtlpPromptRef>; overflow: number } {
  const bySpan = new Map<string, OtlpPromptRef>();
  let overflow = 0;
  if (!Array.isArray(refs)) return { bySpan, overflow };
  for (const r of refs) {
    if (r === null || typeof r !== "object") continue;
    const {
      name,
      version,
      span_id: spanId,
      link_source: linkSource,
    } = r as Record<string, unknown>;
    if (typeof name !== "string" || name === "") continue;
    let target: string | undefined;
    if (typeof spanId === "string" && knownSpanIds.has(spanId)) target = spanId;
    else target = rootSpanId;
    if (target === undefined) continue;
    if (bySpan.has(target)) overflow += 1;
    const entry: OtlpPromptRef = { name };
    if (linkSource === "fetch") entry.link_source = "fetch";
    if (typeof version === "number" && Number.isInteger(version) && version >= 1) {
      entry.version = version;
    }
    bySpan.set(target, entry);
  }
  return { bySpan, overflow };
}
