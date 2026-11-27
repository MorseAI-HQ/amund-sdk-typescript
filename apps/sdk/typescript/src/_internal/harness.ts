/**
 * Harness identity fields (harness-telemetry v1, contract H2-C5, MHQ-1951).
 *
 * An instrumented agent may declare which "harness" (prompts, skills, guardrails,
 * memory, tool guidance, scripts, subagents, plugins) a run executed under:
 *
 *   harnessHash, harnessVersion, harnessChannelsChanged, harnessChannelsIncomplete,
 *   harnessParentHash, harnessRunRole
 *
 * They are accepted on `init()` (client default) and on `run()` (per trace, wins
 * field by field). They travel as `harness_*` keys on the JSON trace payload and
 * as `amund.harness.*` attributes on the OTLP root span. There is no
 * `morse.harness.*` alias.
 *
 * Validation never throws into the host app:
 *   - an invalid scalar is dropped, with one warning per kind per process;
 *   - in `harnessChannelsChanged` unknown items are dropped one by one, the valid
 *     ones are kept (deduplicated, first occurrence wins) and
 *     `harnessChannelsIncomplete` is set true (a lower-bound marker);
 *   - `channels_changed`, `channels_incomplete` and `parent_hash` need a valid
 *     `harness_hash` on the MERGED view (client + trace) and are dropped without one.
 *
 * Absent means "unknown", never "unchanged": when nothing is declared the helpers
 * here return `undefined` and the trace payload is byte-identical to before.
 *
 * `computeHarnessHash()` implements `file_set_hash` from
 * harness-tree-manifest-v1 (`x-amund-hash-rules`). Node builtins are fetched at
 * run time (same technique as `revision.ts`), never statically imported, so this
 * module is safe to bundle for browsers and edge runtimes.
 */

/** The eight observation channels of harness-telemetry v1. */
export type HarnessChannel =
  | "prompt"
  | "skill"
  | "guardrail"
  | "memory"
  | "tool_guidance"
  | "script"
  | "subagent"
  | "plugin";

export type HarnessRunRole = "production" | "probe";

/** The camelCase options accepted on `init()` and `run()`. All optional. */
export interface HarnessOptions {
  /** SHA-256 of the canonical harness: 64 lowercase hex characters, no prefix. */
  harnessHash?: string;
  /** Display label (semver, short SHA, release name), 1-128 characters. Never an identity. */
  harnessVersion?: string;
  /** Channels whose content differs from `harnessParentHash`. Needs `harnessHash`. */
  harnessChannelsChanged?: HarnessChannel[];
  /** True when something outside the eight channels changed, or a channel value was dropped. Needs `harnessHash`. */
  harnessChannelsIncomplete?: boolean;
  /** The `harnessHash` this harness derives from, 64 lowercase hex. Needs `harnessHash`. */
  harnessParentHash?: string;
  /** `probe` runs never count toward a verdict. Absent means production. */
  harnessRunRole?: HarnessRunRole;
}

/** Wire shape (JSON payload keys; the OTLP attributes mirror these). */
export interface HarnessWireFields {
  harness_hash?: string;
  harness_version?: string;
  harness_channels_changed?: HarnessChannel[];
  harness_channels_incomplete?: boolean;
  harness_parent_hash?: string;
  harness_run_role?: HarnessRunRole;
}

export const HARNESS_CHANNELS: readonly HarnessChannel[] = [
  "prompt",
  "skill",
  "guardrail",
  "memory",
  "tool_guidance",
  "script",
  "subagent",
  "plugin",
];

const CHANNEL_SET: ReadonlySet<string> = new Set(HARNESS_CHANNELS);
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_VERSION_LENGTH = 128;

/** The six option keys; used to skip all work when none is present. */
const OPTION_KEYS = [
  "harnessHash",
  "harnessVersion",
  "harnessChannelsChanged",
  "harnessChannelsIncomplete",
  "harnessParentHash",
  "harnessRunRole",
] as const;

/* ------------------------------------------------------------------------ */
/*  Logging: one line per kind per process, never includes the value         */
/* ------------------------------------------------------------------------ */

const warned = new Set<string>();

function warnOnce(kind: string, message: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  try {
    console.warn(`amund: ${message} (this warning prints once per process)`);
  } catch {
    // a hostile console must not break the host
  }
}

/** Test hook: re-arm the once-per-process warnings. */
export function _resetHarnessWarningsForTesting(): void {
  warned.clear();
}

/* ------------------------------------------------------------------------ */
/*  Normalisation                                                            */
/* ------------------------------------------------------------------------ */

function readKey(input: object, key: string): unknown {
  try {
    return (input as Record<string, unknown>)[key];
  } catch {
    return undefined; // hostile getter costs that field only
  }
}

function dropScalar(field: string, expected: string): void {
  warnOnce(`scalar:${field}`, `dropped invalid ${field}; expected ${expected}`);
}

/**
 * Validate the camelCase options of ONE layer (client or trace). Returns the
 * valid wire fields, or `undefined` when the layer declares nothing, which is
 * the zero-overhead path. Dependency rules are NOT applied here (they run on
 * the merged view, see `mergeHarness`). Never throws.
 */
export function normalizeHarnessOptions(input: unknown): HarnessWireFields | undefined {
  try {
    if (input === null || typeof input !== "object") return undefined;
    let any = false;
    for (const k of OPTION_KEYS) {
      if (readKey(input, k) !== undefined) {
        any = true;
        break;
      }
    }
    if (!any) return undefined;

    const out: HarnessWireFields = {};

    const hash = readKey(input, "harnessHash");
    if (hash !== undefined) {
      if (typeof hash === "string" && SHA256_RE.test(hash)) out.harness_hash = hash;
      else dropScalar("harnessHash", "64 lowercase hex characters");
    }

    const version = readKey(input, "harnessVersion");
    if (version !== undefined) {
      if (
        typeof version === "string" &&
        version.length >= 1 &&
        version.length <= MAX_VERSION_LENGTH
      ) {
        out.harness_version = version;
      } else {
        dropScalar("harnessVersion", `a string of 1-${MAX_VERSION_LENGTH} characters`);
      }
    }

    const parent = readKey(input, "harnessParentHash");
    if (parent !== undefined) {
      if (typeof parent === "string" && SHA256_RE.test(parent)) out.harness_parent_hash = parent;
      else dropScalar("harnessParentHash", "64 lowercase hex characters");
    }

    const role = readKey(input, "harnessRunRole");
    if (role !== undefined) {
      if (role === "production" || role === "probe") out.harness_run_role = role;
      else dropScalar("harnessRunRole", '"production" or "probe"');
    }

    let incomplete = false;
    const incompleteIn = readKey(input, "harnessChannelsIncomplete");
    if (incompleteIn !== undefined) {
      if (typeof incompleteIn === "boolean") {
        out.harness_channels_incomplete = incompleteIn;
        incomplete = incompleteIn;
      } else {
        dropScalar("harnessChannelsIncomplete", "a boolean");
      }
    }

    const channelsIn = readKey(input, "harnessChannelsChanged");
    if (channelsIn !== undefined) {
      if (!Array.isArray(channelsIn)) {
        dropScalar("harnessChannelsChanged", "an array of channel names");
      } else {
        const kept: HarnessChannel[] = [];
        let droppedItem = false;
        for (let i = 0; i < channelsIn.length; i++) {
          const item: unknown = channelsIn[i];
          if (typeof item === "string" && CHANNEL_SET.has(item)) {
            if (!kept.includes(item as HarnessChannel)) kept.push(item as HarnessChannel);
          } else {
            droppedItem = true;
          }
        }
        if (droppedItem) {
          warnOnce(
            "channel_item",
            `dropped unrecognised harnessChannelsChanged item(s); valid items are kept and ` +
              `harnessChannelsIncomplete is set. Valid channels: ${HARNESS_CHANNELS.join(", ")}`,
          );
          out.harness_channels_incomplete = true;
          incomplete = true;
        }
        out.harness_channels_changed = kept;
      }
    }
    void incomplete;

    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined; // the SDK never throws into the host because of harness fields
  }
}

/** Fields that only make sense next to a harness hash (`dependentRequired`). */
const NEEDS_HASH: ReadonlyArray<keyof HarnessWireFields> = [
  "harness_channels_changed",
  "harness_channels_incomplete",
  "harness_parent_hash",
];

/**
 * Merge the client default with the per-trace layer (trace wins field by field),
 * then enforce `dependentRequired` on the merged view. Returns `undefined` when
 * nothing survives. Never throws.
 */
export function mergeHarness(
  client: HarnessWireFields | undefined,
  trace: HarnessWireFields | undefined,
): HarnessWireFields | undefined {
  if (client === undefined && trace === undefined) return undefined;
  try {
    const merged: HarnessWireFields = { ...client, ...trace };
    if (merged.harness_hash === undefined) {
      let dropped = false;
      for (const k of NEEDS_HASH) {
        if (merged[k] !== undefined) {
          delete merged[k];
          dropped = true;
        }
      }
      if (dropped) {
        warnOnce(
          "needs_hash",
          "dropped harnessChannelsChanged / harnessChannelsIncomplete / harnessParentHash " +
            "because no valid harnessHash was set",
        );
      }
    }
    if (merged.harness_channels_changed)
      merged.harness_channels_changed = [...merged.harness_channels_changed];
    return Object.keys(merged).length > 0 ? merged : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------ */
/*  Process-level client default, written by init()                          */
/* ------------------------------------------------------------------------ */

let _clientHarness: HarnessWireFields | undefined;

/** Called from `init()`. Validates once; the per-trace path only merges. */
export function setHarnessDefault(opts: unknown): void {
  _clientHarness = normalizeHarnessOptions(opts);
}

export function getHarnessDefault(): HarnessWireFields | undefined {
  return _clientHarness;
}

export function _resetHarnessForTesting(): void {
  _clientHarness = undefined;
}

/** Resolve the fields for one trace: client default + the `run()` options. */
export function resolveTraceHarness(runOpts: unknown): HarnessWireFields | undefined {
  const traceLayer = normalizeHarnessOptions(runOpts);
  if (traceLayer === undefined && _clientHarness === undefined) return undefined;
  return mergeHarness(_clientHarness, traceLayer);
}

/* ------------------------------------------------------------------------ */
/*  computeHarnessHash: file_set_hash (x-amund-hash-rules)                   */
/* ------------------------------------------------------------------------ */

export interface ComputeHarnessHashOptions {
  /**
   * Directory the hashed paths are relative to. Defaults to `process.cwd()`.
   * Relative `paths` are resolved against it; every hashed file must live under it.
   */
  root?: string;
}

interface FsLike {
  readFileSync(p: string): Uint8Array;
  readdirSync(
    p: string,
    o: { withFileTypes: true },
  ): Array<{
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  lstatSync(p: string): { isFile(): boolean; isDirectory(): boolean };
}
interface PathLike {
  sep: string;
  resolve(...p: string[]): string;
  relative(a: string, b: string): string;
  join(...p: string[]): string;
}
interface HashLike {
  update(d: string | Uint8Array): HashLike;
  digest(enc: "hex"): string;
}
interface CryptoLike {
  createHash(alg: string): HashLike;
}

function loadBuiltin<T>(name: string): T | null {
  try {
    if (typeof process === "undefined" || !process.versions?.node) return null;
    try {
      const getBuiltin = (process as unknown as { getBuiltinModule?: (m: string) => unknown })
        .getBuiltinModule;
      if (typeof getBuiltin === "function") {
        const mod = getBuiltin.call(process, name) as T | undefined;
        if (mod) return mod;
      }
    } catch {
      // fall through
    }
    // Run-time-eval'd so no bundler sees a `require("node:...")` literal.
    const dynamicRequire = Function("m", "return require(m)") as (m: string) => unknown;
    return (dynamicRequire(name) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

let loadNode: () => { fs: FsLike; path: PathLike; crypto: CryptoLike } | null = () => {
  const fs = loadBuiltin<FsLike>("node:fs");
  const path = loadBuiltin<PathLike>("node:path");
  const crypto = loadBuiltin<CryptoLike>("node:crypto");
  return fs && path && crypto ? { fs, path, crypto } : null;
};

/** Test hook: `() => null` simulates a browser / edge runtime without `fs`. */
export function _setNodeLoaderForTesting(
  loader: (() => { fs: FsLike; path: PathLike; crypto: CryptoLike } | null) | null,
): void {
  loadNode =
    loader ??
    (() => {
      const fs = loadBuiltin<FsLike>("node:fs");
      const path = loadBuiltin<PathLike>("node:path");
      const crypto = loadBuiltin<CryptoLike>("node:crypto");
      return fs && path && crypto ? { fs, path, crypto } : null;
    });
}

/**
 * `file_set_hash` over the files named by `paths` (files, or directories that
 * are walked recursively over regular files; symlinks and special files are
 * skipped). Lowercase hex SHA-256, or `undefined` (with one warning) when it
 * cannot be computed: no `fs` (browser/edge), an unreadable or missing path, a
 * path outside `root`. Never throws.
 *
 * Rules (harness-tree-manifest-v1 `x-amund-hash-rules.file_set_hash`):
 * raw bytes (no line-ending or encoding normalisation); paths relative to
 * `root`, forward slashes, Unicode NFC; one `"<path>\t<sha256hex>\n"` line per
 * file, sorted by the UTF-8 bytes of the path (not JS string order); the result
 * is the sha256 of the concatenated lines. An empty set hashes the empty string.
 */
export function computeHarnessHash(
  paths: readonly string[],
  opts: ComputeHarnessHashOptions = {},
): string | undefined {
  try {
    const node = loadNode();
    if (node === null) {
      warnOnce(
        "hash_runtime",
        "computeHarnessHash() needs Node's fs and crypto; unavailable in this runtime, returning undefined",
      );
      return undefined;
    }
    const { fs, path, crypto } = node;
    const root = path.resolve(opts.root ?? process.cwd());
    const files = new Map<string, string>(); // relative NFC path -> absolute path

    const add = (abs: string): void => {
      const rel = path.relative(root, abs);
      const segments = rel.split(path.sep).join("/").normalize("NFC").split("/");
      if (rel === "" || segments.includes("..") || segments[0] === "" || /^[a-zA-Z]:/.test(rel)) {
        throw new Error("path outside root");
      }
      files.set(segments.join("/"), abs);
    };
    const walk = (abs: string): void => {
      const st = fs.lstatSync(abs);
      if (st.isFile()) {
        add(abs);
      } else if (st.isDirectory()) {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
          const child = path.join(abs, entry.name);
          if (entry.isFile()) add(child);
          else if (entry.isDirectory()) walk(child);
        }
      }
    };

    for (const p of paths) walk(path.resolve(root, p));

    const lines = [...files.entries()].map(([rel, abs]) => {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      return { key: Buffer.from(rel, "utf8"), line: `${rel}\t${digest}\n` };
    });
    lines.sort((a, b) => Buffer.compare(a.key, b.key));
    const h = crypto.createHash("sha256");
    h.update(lines.map((l) => l.line).join(""));
    return h.digest("hex");
  } catch {
    warnOnce(
      "hash_failed",
      "computeHarnessHash() could not read one of the given paths (missing, unreadable or outside root); returning undefined",
    );
    return undefined;
  }
}
