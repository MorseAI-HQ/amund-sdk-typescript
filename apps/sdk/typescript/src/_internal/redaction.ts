/**
 * Client-side PII redaction for the TypeScript SDK.
 *
 * Phase 6f Wave B G-02. Mirrors:
 *   - `apps/sdk/python/src/morse/redaction.py` (Python SDK)
 *   - `apps/api/apps/core/redaction/patterns.py` (server-side floor)
 *
 * The eight pattern catalogue is canonical across all three implementations.
 * The parity corpus at
 *   `openspec/changes/phase-6f-g02-pii-redaction/tests/parity_corpus.json`
 * pins identical input → output behaviour on every row.
 *
 * Redaction runs default-on inside the SDK process so that sensitive strings
 * never leave the customer's runtime. Customers can:
 *   - disable the whole SDK layer (`redaction.enabled = false`),
 *   - turn off non-mandatory built-ins (`disabledPatterns`),
 *   - inject custom regexes (`extraPatterns`).
 *
 * The four mandatory keys (`api_key_prefixed`, `jwt`, `credit_card`,
 * `ssn_us`) cannot be disabled at the SDK — attempting to do so throws at
 * `init()`. Disabling everything at the SDK still leaves the server-side
 * mandatory floor in place.
 */

/* ------------------------------------------------------------------------ */
/*  Pattern catalogue                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Canonical pattern keys. The redactor walks them in this order; once a
 * substring is replaced by a `[REDACTED:...]` marker, later patterns see
 * the replacement and don't re-match digit/word fragments inside it.
 *
 * Order MUST match `apps/api/apps/core/redaction/patterns.py` and
 * `apps/sdk/python/.../redaction.py` so the parity corpus produces
 * identical output across implementations.
 */
export const PATTERN_ORDER: readonly string[] = [
  "api_key_prefixed",
  "jwt",
  "credit_card",
  "email",
  "phone_us",
  "phone_e164",
  "ssn_us",
  "ip_address",
  // Last: the value-shaped patterns above are more specific, so a JWT inside
  // `authorization: Bearer eyJ...` gets its own tag before this one runs.
  "secret_assignment",
] as const;

/** Patterns that customers cannot disable at the SDK layer. */
export const MANDATORY_PATTERNS: ReadonlySet<string> = new Set([
  "api_key_prefixed",
  "jwt",
  "credit_card",
  "ssn_us",
]);

/** Patterns that ship disabled by default (opt-in). */
export const DEFAULT_OFF_PATTERNS: ReadonlySet<string> = new Set(["ip_address"]);

/**
 * Short replacement keys. The replacement format is `[REDACTED:<short>]`.
 * `phone_us` and `phone_e164` collapse to `phone`.
 */
const SHORT_KEYS: Record<string, string> = {
  api_key_prefixed: "api_key",
  jwt: "jwt",
  credit_card: "credit_card",
  email: "email",
  phone_us: "phone",
  phone_e164: "phone",
  ssn_us: "ssn",
  ip_address: "ip",
  secret_assignment: "secret", // pragma: allowlist secret — a label, not a value
};

/**
 * Compiled regexes for each pattern. The `g` flag is required so the
 * `String.replace(regex, ...)` call walks the whole string. `i` flag is
 * applied where the canonical Python form is case-insensitive (email,
 * ip_address) for lowercase IPv6 + uppercase email parity.
 *
 * NB: the Luhn-validating credit_card pattern returns *candidate* matches;
 * `redactString` runs Luhn before deciding to replace.
 */
/**
 * Source for the `secret_assignment` pattern, exported so the diagnostics
 * channel can compile its own instance and apply it unconditionally (MHQ-973).
 *
 * Exported as a STRING, not a RegExp: a `g`-flagged RegExp carries `lastIndex`
 * state, and sharing one instance across call sites is a well-known way to get
 * intermittently-skipped matches.
 */
export const SECRET_ASSIGNMENT_SOURCE =
  // Compound keys accept `=` or `:`; bare `secret` requires `=`, because with
  // `:` it is more often a marker (`k8s-secret: mounted`) than an assignment.
  "(?:(?:password|passwd|pwd|client[-_]?secret|secret[-_]?key|" +
  "private[-_]?key|access[-_]?key|api[-_]?key|auth[-_]?token|" +
  "access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|" +
  "authorization|credentials?)[\"']?\\s*[=:]" +
  "|\\bsecret[\"']?\\s*=)" +
  "\\s*(?:bearer\\s+)?(?:\"[^\"]*\"|'[^']*'|\\S+)";

const PATTERNS: Record<string, RegExp> = {
  api_key_prefixed: new RegExp(
    "\\b(?:" +
      "sk-[A-Za-z0-9_-]{20,}" +
      "|sk_(?:live|test)_[A-Za-z0-9]{20,}" +
      // WP-12 parity with the server: Stripe restricted keys and webhook
      // secrets, GitHub fine-grained PATs and Resend keys (`re_<id>_<secret>`,
      // which must carry a digit and an uppercase letter so snake_case
      // identifiers never match). `sk-ant-` / `sk-proj-` are covered by `sk-`.
      "|rk_(?:live|test)_[A-Za-z0-9]{20,}" +
      "|whsec_[A-Za-z0-9]{24,}" +
      "|github_pat_[A-Za-z0-9_]{30,}" +
      "|re_(?=[A-Za-z0-9_]{24,})(?=[A-Za-z0-9_]*\\d)(?=[A-Za-z0-9_]*[A-Z])" +
      "[A-Za-z0-9]+(?:_[A-Za-z0-9]+)?" +
      "|(?:mhq|av)_(?:pk_)?[\\s\\S]{0,48}_[A-Fa-f0-9]{64}" +
      "|mhq_[A-Za-z0-9]{20,}" +
      "|av_[A-Za-z0-9]{20,}" +
      "|ghp_[A-Za-z0-9]{36}" +
      "|gho_[A-Za-z0-9]{36}" +
      "|ghu_[A-Za-z0-9]{36}" +
      "|ghs_[A-Za-z0-9]{36}" +
      "|ghr_[A-Za-z0-9]{36}" +
      "|xox[bopsa]-[0-9A-Za-z\\-]{10,}" +
      "|(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}" +
      ")\\b",
    "g",
  ),
  jwt: new RegExp(
    "\\beyJ[A-Za-z0-9_=-]{16,}\\.eyJ[A-Za-z0-9_=-]{16,}\\.[A-Za-z0-9_=-]{16,}\\b",
    "g",
  ),
  credit_card: new RegExp("\\b(?:\\d[ -]?){12,18}\\d\\b", "g"),
  email: new RegExp("\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "gi"),
  // The leading `(?<!\d)` and trailing `(?!\d)` lookarounds prevent
  // the phone matcher from carving a 10-digit substring out of a longer
  // continuous digit run (e.g., a 16-digit credit-card-shaped number that
  // failed Luhn). Without them, `1234567890123456` would emit a
  // `[REDACTED:phone]` for digits 7-16 even though the whole run was
  // never a real phone number. The canonical Python regex needs the same
  // shim — see redaction.py.
  phone_us: new RegExp(
    "(?<!\\d)(?:\\+?1[ \\-.])?\\(?[2-9]\\d{2}\\)?[ \\-.]?\\d{3}[ \\-.]?\\d{4}(?!\\d)",
    "g",
  ),
  phone_e164: new RegExp("(?<!\\d)\\+(?:[0-9][ \\-.]?){8,14}[0-9](?!\\d)", "g"),
  ssn_us: new RegExp(
    "\\b(?!000|666|9\\d{2})\\d{3}[ \\-.](?!00)\\d{2}[ \\-.](?!0000)\\d{4}\\b",
    "g",
  ),
  ip_address: new RegExp(
    "\\b(?:" +
      "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)" +
      "(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}" +
      "|(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}" +
      ")\\b",
    "gi",
  ),
  // MHQ-973 — key-context secret assignment. Every pattern above is
  // VALUE-shaped: it recognises a credential by its own format. That cannot
  // catch `password=hunter2` — `hunter2` is an ordinary word, and only the KEY
  // marks it as a secret.
  //
  // Deliberately excludes a bare `token`: this is an LLM-observability SDK, and
  // `input_tokens=100` / `max_tokens=4096` are core telemetry. Only unambiguous
  // `*_token` compounds match. No leading `\\b` either, so `PGPASSWORD=` and
  // `MYSQL_PWD=` are caught; the `[=:]` anchor is what prevents false positives.
  secret_assignment: new RegExp(SECRET_ASSIGNMENT_SOURCE, "gi"),
};

/* ------------------------------------------------------------------------ */
/*  Configuration                                                            */
/* ------------------------------------------------------------------------ */

/** Public SDK option. Mirrors `redaction` in `init()`. */
export interface RedactionOptions {
  /** Master switch. Default: `true`. */
  enabled?: boolean;
  /** Pattern keys to selectively disable (mandatory keys rejected). */
  disabledPatterns?: string[];
  /** Customer-supplied regex strings (ECMAScript syntax). */
  extraPatterns?: string[];
}

/** Validated, frozen config fed into `redactString` / `redactValue`. */
export interface RedactionConfig {
  enabled: boolean;
  /** Keys actually applied, in stable order. */
  enabledPatterns: ReadonlySet<string>;
  /** Custom compiled regexes — applied last, with `[REDACTED:custom]`. */
  extraCompiled: readonly RegExp[];
}

/** Hard caps mirroring server-side validation. */
const EXTRA_PATTERN_CAP = 10;
const EXTRA_PATTERN_CHAR_CAP = 256;

/**
 * Validate raw user options and return a normalised config. Throws on:
 *   - disabling a mandatory pattern,
 *   - more than 10 extra patterns,
 *   - any extra pattern over 256 chars,
 *   - any extra pattern that fails to compile via `new RegExp(...)`.
 *
 * `enabled = false` short-circuits — no patterns are applied.
 */
export function buildRedactionConfig(options?: RedactionOptions): RedactionConfig {
  const opts = options ?? {};
  const enabled = opts.enabled !== false;

  if (!enabled) {
    return {
      enabled: false,
      enabledPatterns: new Set<string>(),
      extraCompiled: [],
    };
  }

  // Mandatory-pattern lock-down.
  const disabled = new Set(opts.disabledPatterns ?? []);
  for (const key of disabled) {
    if (MANDATORY_PATTERNS.has(key)) {
      throw new Error(`redaction pattern '${key}' cannot be disabled (server-side mandatory)`);
    }
  }

  // Active set: every catalogue key NOT in default-off NOT in disabled.
  const active = new Set<string>();
  for (const key of PATTERN_ORDER) {
    if (DEFAULT_OFF_PATTERNS.has(key)) continue;
    if (disabled.has(key)) continue;
    active.add(key);
  }
  // Re-add any default-off pattern the user explicitly opted in to via a
  // `disabledPatterns` membership check is the wrong direction — the only
  // way to enable `ip_address` from the SDK today is through a future
  // `enabledPatterns` option. The spec keeps it default-off; tests pass
  // an explicit `enabledPatterns` set via the lower-level `redactString`.

  // Custom regex validation.
  const extraInput = opts.extraPatterns ?? [];
  if (extraInput.length > EXTRA_PATTERN_CAP) {
    throw new Error(
      `too many redaction extra patterns: ${extraInput.length} (max ${EXTRA_PATTERN_CAP})`,
    );
  }
  const extraCompiled: RegExp[] = [];
  for (const raw of extraInput) {
    if (typeof raw !== "string") {
      throw new Error(`redaction extra pattern must be a string, got ${typeof raw}`);
    }
    if (raw.length > EXTRA_PATTERN_CHAR_CAP) {
      throw new Error(`redaction extra pattern exceeds ${EXTRA_PATTERN_CHAR_CAP} chars`);
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(raw, "g");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`redaction extra pattern failed to compile: ${JSON.stringify(raw)} — ${msg}`);
    }
    extraCompiled.push(compiled);
  }

  return {
    enabled: true,
    enabledPatterns: active,
    extraCompiled,
  };
}

/* ------------------------------------------------------------------------ */
/*  Luhn check                                                               */
/* ------------------------------------------------------------------------ */

/** Standard mod-10 Luhn check on the digits of `s` (ignores spaces/dashes). */
function luhnValid(s: string): boolean {
  let sum = 0;
  let alt = false;
  let digits = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s.charCodeAt(i);
    if (ch < 48 || ch > 57) continue; // skip non-digits (spaces, dashes)
    let n = ch - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
    digits++;
  }
  if (digits < 13 || digits > 19) return false;
  return sum % 10 === 0;
}

/* ------------------------------------------------------------------------ */
/*  String redactor                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Internal: compute the active enabled set when callers pass an explicit
 * `enabledPatterns` (parity-corpus tests do this) vs. defaults.
 */
function resolveEnabled(
  config: RedactionConfig,
  override?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (override !== undefined) return override;
  return config.enabledPatterns;
}

// MHQ-1412: identifiers are not PII. A UUID or a long hex id (trace/span ids,
// vector-store document ids) often contains a 10+ digit run, which the phone
// and card patterns carved out of the middle (`bc41d39b-...-0c[REDACTED:phone]`),
// corrupting ids that exist to be joined on. Id-shaped tokens are set aside
// while the digit-run patterns run and restored afterwards. A hex id must
// contain at least one letter, so an all-digit run (a card number) is never
// shielded; API-key/JWT/secret patterns always see the full text. Mirrors
// `apps/sdk/python/src/morse_ai/_internal/redaction.py` and the server.
const ID_SHIELDED_PATTERNS: ReadonlySet<string> = new Set([
  "credit_card",
  "phone_us",
  "phone_e164",
  "ssn_us",
]);
const ID_TOKEN = new RegExp(
  "(?<![\\w@.])(?:" +
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" +
    "|(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*[0-9])[0-9a-fA-F]{16,64}" +
    ")(?![0-9A-Za-z])(?![\\w.+\\-]*@)(?!\\.[A-Za-z]{2,})",
  "g",
);
const ID_PLACEHOLDER_RE = /\uE000morse-id-(\d+)\uE000/g;

function shieldIds(s: string, out: string[]): string {
  if (s.includes("\uE000")) return s;
  ID_TOKEN.lastIndex = 0;
  return s.replace(ID_TOKEN, (m) => {
    out.push(m);
    return `\uE000morse-id-${out.length - 1}\uE000`;
  });
}

function unshieldIds(s: string, ids: readonly string[]): string {
  ID_PLACEHOLDER_RE.lastIndex = 0;
  return s.replace(ID_PLACEHOLDER_RE, (_m, i: string) => ids[Number(i)] ?? _m);
}

/**
 * Core redactor: walk patterns in canonical order, replace matches.
 *
 * `enabledOverride` allows tests (and the parity corpus) to specify an
 * exact enabled set, bypassing the config's default-on/off decisions.
 *
 * Customers calling through the SDK never see the override path — they
 * always pass through `RedactionConfig.enabledPatterns`.
 */
export function redactString(
  s: string,
  config: RedactionConfig,
  enabledOverride?: ReadonlySet<string>,
): string {
  if (!config.enabled && enabledOverride === undefined) {
    return s;
  }
  if (s.length === 0) return s;

  const enabled = resolveEnabled(config, enabledOverride);
  let out = s;

  for (const key of PATTERN_ORDER) {
    if (!enabled.has(key)) continue;
    const re = PATTERNS[key];
    if (re === undefined) continue;
    // Reset `lastIndex` defensively (shared global regex state).
    re.lastIndex = 0;
    const replacement = `[REDACTED:${SHORT_KEYS[key]}]`;
    // Only the digit-run patterns are kept off identifiers (MHQ-1412).
    const protectedIds: string[] = [];
    let text = ID_SHIELDED_PATTERNS.has(key) ? shieldIds(out, protectedIds) : out;
    if (key === "credit_card") {
      text = text.replace(re, (m) => (luhnValid(m) ? replacement : m));
    } else {
      text = text.replace(re, replacement);
    }
    out = protectedIds.length > 0 ? unshieldIds(text, protectedIds) : text;
  }

  // Custom patterns last.
  for (const re of config.extraCompiled) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED:custom]");
  }

  return out;
}

/* ------------------------------------------------------------------------ */
/*  JSON walker                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Maximum nesting depth walked. Matches the server
 * (`apps.core.redaction.services.MAX_JSON_DEPTH`) and the ingest limit: a
 * top-level value is depth 0 and a string inside 64 nested containers is depth
 * 64, which is still walked.
 */
export const MAX_DEPTH = 64;
/** Replaces a node nested deeper than `MAX_DEPTH` (same marker as the server). */
export const DEPTH_MARKER = "[REDACTED:depth]";

/**
 * Recursively redact string leaves inside an arbitrary JSON-like value.
 * Booleans, numbers, nulls, undefined are passed through untouched.
 * Recursion is bounded at `MAX_DEPTH` to defend against pathological
 * payloads — anything nested deeper becomes `DEPTH_MARKER` (fail closed, like
 * the server) instead of being passed through unredacted.
 *
 * Arrays return new arrays; plain objects return new shallow-cloned
 * objects; non-plain objects (Date, Map, etc.) are returned as-is so we
 * don't accidentally serialise customer-internal types.
 */
export function redactValue(value: unknown, config: RedactionConfig, depth = 0): unknown {
  if (!config.enabled) return value;
  if (depth > MAX_DEPTH) return DEPTH_MARKER;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, config);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, config, depth + 1));
  }

  // Only walk plain objects (prototype is Object.prototype or null).
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactValue(v, config, depth + 1);
      }
      return out;
    }
  }

  return value;
}
