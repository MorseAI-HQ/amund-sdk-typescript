/**
 * Harness telemetry v1 (contract H2-C5, MHQ-1951): optional harness identity
 * fields on init()/run(), their validation (never throws), the JSON payload and
 * OTLP `amund.harness.*` shapes, and `computeHarnessHash()` (file_set_hash).
 *
 * The payload is validated against the vendored frozen schema
 * (tests/fixtures/harness-telemetry-v1.schema.json, see SOURCE.md) with a tiny
 * interpreter for the keywords that schema uses; no new dependency.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  _resetHarnessWarningsForTesting,
  _setNodeLoaderForTesting,
  computeHarnessHash,
  normalizeHarnessOptions,
} from "../src/_internal/harness";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { getEngine } from "../src/_internal/otel-provider";
import { runSync } from "../src/_internal/tracing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(join(HERE, "fixtures", "harness-telemetry-v1.schema.json"), "utf8"),
) as Schema;

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const ENDPOINT = "http://127.0.0.1:1/api/v1/traces/batch";
const ENV_KEYS = [
  "MORSE_API_KEY",
  "AMUND_API_KEY",
  "MORSE_LEGACY_TRANSPORT",
  "AMUND_LEGACY_TRANSPORT",
];
let savedEnv: Record<string, string | undefined> = {};
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  morse._resetForTesting();
  _resetHarnessWarningsForTesting();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  morse._resetForTesting();
  _setNodeLoaderForTesting(null);
  getEngine().resetForTesting();
  vi.restoreAllMocks();
});

function init(extra: Record<string, unknown> = {}): void {
  morse.init({ apiKey: "mhq_test_x", endpoint: ENDPOINT, ...extra } as morse.InitOptions); // pragma: allowlist secret
}

function harnessWarns(): number {
  return warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("harness")).length;
}

function trace(): Record<string, unknown> {
  const t = morse._getLastTraceForTesting() as { trace: Record<string, unknown> } | null;
  expect(t).not.toBeNull();
  return t!.trace;
}

function harnessKeys(t: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith("harness_")));
}

function run(opts: Record<string, unknown> = {}): Record<string, unknown> {
  runSync({ agentName: "h", ...opts } as never, () => undefined);
  return harnessKeys(trace());
}

/* ---- minimal JSON Schema interpreter: only the keywords the frozen schema uses ---- */
function check(schema: Schema, value: unknown, root: Schema = SCHEMA): string[] {
  if (schema.$ref) {
    const target = schema.$ref
      .replace("#/", "")
      .split("/")
      .reduce((o: Schema, k: string) => o[k] as Schema, root);
    return check(target, value, root);
  }
  const errs: string[] = [];
  if (schema.type === "string") {
    if (typeof value !== "string") return ["not a string"];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push("pattern");
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push("minLength");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push("maxLength");
    if (schema.enum && !schema.enum.includes(value)) errs.push("enum");
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") errs.push("not a boolean");
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return ["not an array"];
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push("maxItems");
    if (schema.uniqueItems && new Set(value).size !== value.length) errs.push("uniqueItems");
    for (const item of value) errs.push(...check(schema.items, item, root));
  } else if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return ["not an object"];
    const obj = value as Record<string, unknown>;
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj) errs.push(...check(sub as Schema, obj[k], root));
    }
    for (const [k, needs] of Object.entries(schema.dependentRequired ?? {})) {
      if (k in obj)
        for (const n of needs as string[]) if (!(n in obj)) errs.push(`${k} needs ${n}`);
    }
  }
  return errs;
}

/** Validate against the closed top-level schema (harness_fields + unevaluatedProperties:false). */
function validatePayload(fields: Record<string, unknown>): string[] {
  const frag = SCHEMA.$defs.harness_fields;
  const errs = check(frag, fields);
  for (const k of Object.keys(fields)) if (!(k in frag.properties)) errs.push(`unevaluated ${k}`);
  return errs;
}

describe("H2-C5 harness telemetry: schema checker sanity", () => {
  it("accepts the frozen schema's own examples and rejects bad ones", () => {
    for (const ex of SCHEMA.examples) expect(validatePayload(ex)).toEqual([]);
    expect(validatePayload({ harness_hash: "ABC" })).not.toEqual([]);
    expect(validatePayload({ harness_channels_changed: ["prompt"] })).not.toEqual([]);
    expect(validatePayload({ harness_hash: H1, harness_channels_changed: ["x"] })).not.toEqual([]);
    expect(validatePayload({ harness_hash: H1, extra: 1 })).not.toEqual([]);
  });
});

describe("H2-C5 omission (zero overhead)", () => {
  it("adds no harness_* key and no OTLP attribute when nothing is declared", () => {
    init();
    expect(run()).toEqual({});
    expect(normalizeHarnessOptions({})).toBeUndefined();
    expect(normalizeHarnessOptions({ agentVersion: "v1" })).toBeUndefined();
    expect(harnessWarns()).toBe(0);
  });
});

describe("H2-C5 valid values", () => {
  it("serialises every field with the snake_case wire keys and validates against the schema", () => {
    init();
    const out = run({
      harnessHash: H1,
      harnessVersion: "support-bot@2026.11.26-r3",
      harnessChannelsChanged: ["prompt", "skill"],
      harnessChannelsIncomplete: false,
      harnessParentHash: H2,
      harnessRunRole: "probe",
    });
    expect(out).toEqual({
      harness_hash: H1,
      harness_version: "support-bot@2026.11.26-r3",
      harness_channels_changed: ["prompt", "skill"],
      harness_channels_incomplete: false,
      harness_parent_hash: H2,
      harness_run_role: "probe",
    });
    expect(validatePayload(out)).toEqual([]);
    expect(harnessWarns()).toBe(0);
  });

  it("keeps an empty channel list (sender asserts nothing changed)", () => {
    init();
    expect(run({ harnessHash: H1, harnessChannelsChanged: [] })).toEqual({
      harness_hash: H1,
      harness_channels_changed: [],
    });
  });

  it("accepts all eight channels and production role", () => {
    init();
    const all = [
      "prompt",
      "skill",
      "guardrail",
      "memory",
      "tool_guidance",
      "script",
      "subagent",
      "plugin",
    ];
    const out = run({ harnessHash: H1, harnessChannelsChanged: all, harnessRunRole: "production" });
    expect(out.harness_channels_changed).toEqual(all);
    expect(validatePayload(out)).toEqual([]);
  });

  it("client config applies to traces; trace-level overrides it field by field", () => {
    init({ harnessHash: H1, harnessVersion: "client", harnessRunRole: "production" });
    expect(run()).toEqual({
      harness_hash: H1,
      harness_version: "client",
      harness_run_role: "production",
    });
    expect(run({ harnessHash: H2, harnessRunRole: "probe" })).toEqual({
      harness_hash: H2,
      harness_version: "client",
      harness_run_role: "probe",
    });
  });
});

describe("H2-C5 invalid values are dropped, never thrown", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["uppercase hash", { harnessHash: "A".repeat(64) }, {}],
    ["short hash", { harnessHash: "abc" }, {}],
    ["prefixed hash", { harnessHash: `sha256:${H1}` }, {}],
    ["non-string hash", { harnessHash: 12345 }, {}],
    ["empty version", { harnessVersion: "" }, {}],
    ["129-char version", { harnessVersion: "v".repeat(129) }, {}],
    ["non-string version", { harnessVersion: 3 }, {}],
    ["bad run role", { harnessRunRole: "staging" }, {}],
    ["bad parent hash", { harnessHash: H1, harnessParentHash: "nope" }, { harness_hash: H1 }],
    [
      "non-boolean incomplete",
      { harnessHash: H1, harnessChannelsIncomplete: "yes" },
      { harness_hash: H1 },
    ],
    [
      "non-array channels",
      { harnessHash: H1, harnessChannelsChanged: "prompt" },
      { harness_hash: H1 },
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`drops ${name} with a warning`, () => {
      init();
      expect(() => run(input)).not.toThrow();
      expect(run(input)).toEqual(expected);
      expect(warn).toHaveBeenCalled();
    });
  }

  it("drops only unknown channel items, keeps valid ones, dedupes, sets incomplete", () => {
    init();
    const out = run({
      harnessHash: H1,
      harnessChannelsChanged: ["skill", "bogus", "prompt", "skill", 7, null, "Prompt"],
    });
    expect(out.harness_channels_changed).toEqual(["skill", "prompt"]);
    expect(out.harness_channels_incomplete).toBe(true);
    expect(validatePayload(out)).toEqual([]);
    expect(harnessWarns()).toBe(1);
  });

  it("dedupe alone does not set incomplete", () => {
    init();
    const out = run({ harnessHash: H1, harnessChannelsChanged: ["prompt", "prompt"] });
    expect(out).toEqual({ harness_hash: H1, harness_channels_changed: ["prompt"] });
  });

  it("drops channels_changed / channels_incomplete / parent_hash when there is no valid hash", () => {
    init();
    const out = run({
      harnessHash: "bad",
      harnessVersion: "keep-me",
      harnessChannelsChanged: ["prompt", "nope"],
      harnessChannelsIncomplete: true,
      harnessParentHash: H2,
    });
    expect(out).toEqual({ harness_version: "keep-me" });
  });

  it("applies the hash requirement on the merged view (client hash + trace channels)", () => {
    init({ harnessHash: H1 });
    expect(run({ harnessChannelsChanged: ["memory"], harnessParentHash: H2 })).toEqual({
      harness_hash: H1,
      harness_channels_changed: ["memory"],
      harness_parent_hash: H2,
    });
  });

  it("survives hostile input objects", () => {
    init();
    const hostile = {
      get harnessHash(): string {
        throw new Error("boom");
      },
      harnessVersion: "ok",
    };
    // Pass the object itself (no spread): the SDK must survive the throwing getter.
    const direct = (): void => runSync(hostile as never, () => undefined);
    expect(direct).not.toThrow();
    expect(normalizeHarnessOptions(hostile)).toEqual({ harness_version: "ok" });
    const bad = { apiKey: "mhq_test_x", endpoint: ENDPOINT, harnessHash: {} }; // pragma: allowlist secret
    expect(() => morse.init(bad as never)).not.toThrow();
  });
});

describe("H2-C5 OTLP attributes", () => {
  function recorder() {
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
  async function rootAttrs(
    engine: ReturnType<typeof recorder>,
  ): Promise<ReadableSpan["attributes"]> {
    const traceId = (trace() as { trace_id: string }).trace_id;
    await engine.flush();
    const root = engine.recorder!.spans.find(
      (s) => s.spanContext().traceId === traceId && s.name === "otlp-h",
    );
    expect(root).toBeDefined();
    return root!.attributes;
  }

  it("emits amund.harness.* with the right types and no morse.harness.*", async () => {
    const engine = recorder();
    runSync(
      {
        agentName: "otlp-h",
        harnessHash: H1,
        harnessVersion: "v9",
        harnessChannelsChanged: ["prompt", "guardrail"],
        harnessChannelsIncomplete: true,
        harnessParentHash: H2,
        harnessRunRole: "probe",
      } as never,
      () => undefined,
    );
    const a = await rootAttrs(engine);
    expect(a["amund.harness.hash"]).toBe(H1);
    expect(a["amund.harness.version"]).toBe("v9");
    expect(a["amund.harness.channels_changed"]).toEqual(["prompt", "guardrail"]);
    expect(a["amund.harness.channels_incomplete"]).toBe(true);
    expect(a["amund.harness.parent_hash"]).toBe(H2);
    expect(a["amund.harness.run_role"]).toBe("probe");
    expect(Object.keys(a).filter((k) => k.startsWith("morse.harness"))).toEqual([]);
  });

  it("emits nothing when omitted", async () => {
    const engine = recorder();
    runSync({ agentName: "otlp-h" } as never, () => undefined);
    const a = await rootAttrs(engine);
    expect(Object.keys(a).filter((k) => k.includes("harness"))).toEqual([]);
  });
});

describe("H2-C5 computeHarnessHash (file_set_hash)", () => {
  // Pinned vectors from amund-core schemas/test_harness2_contracts.py
  const FILE_SET_VECTOR = "6cfb940903f0610c8f4107a0051496e6a3066cc43e511718cfeadbd007da9457"; // pragma: allowlist secret
  const EMPTY_SET_VECTOR = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // pragma: allowlist secret
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-hash-"));
    const files: Record<string, Buffer> = {
      "prompts/system.md": Buffer.from("You are a support agent.\n"),
      "skills/refund/SKILL.md": Buffer.from("# Refund\r\nSteps\n"), // CRLF kept: raw bytes
      "scripts/check.py": Buffer.alloc(0),
    };
    for (const [p, data] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), data);
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reproduces FILE_SET_VECTOR from files and from the directory tree", () => {
    const files = ["prompts/system.md", "skills/refund/SKILL.md", "scripts/check.py"];
    expect(computeHarnessHash(files, { root: dir })).toBe(FILE_SET_VECTOR);
    expect(computeHarnessHash([...files].reverse(), { root: dir })).toBe(FILE_SET_VECTOR);
    expect(computeHarnessHash(["prompts", "skills", "scripts"], { root: dir })).toBe(
      FILE_SET_VECTOR,
    );
    expect(
      computeHarnessHash(["prompts", "prompts/system.md", "skills", "scripts"], { root: dir }),
    ).toBe(FILE_SET_VECTOR);
    expect(computeHarnessHash(["."], { root: dir })).toBe(FILE_SET_VECTOR);
  });

  it("hashes the empty set to sha256 of the empty string", () => {
    expect(computeHarnessHash([], { root: dir })).toBe(EMPTY_SET_VECTOR);
    mkdirSync(join(dir, "emptydir"));
    expect(computeHarnessHash(["emptydir"], { root: dir })).toBe(EMPTY_SET_VECTOR);
  });

  it("is byte exact: LF instead of CRLF changes the hash", () => {
    writeFileSync(join(dir, "skills/refund/SKILL.md"), "# Refund\nSteps\n");
    expect(computeHarnessHash(["."], { root: dir })).not.toBe(FILE_SET_VECTOR);
  });

  it("sorts by UTF-8 bytes, not JS string order (astral vs BMP code point)", () => {
    // U+FF5E (EF BD 9E) sorts BEFORE U+1F600 (F0 9F 98 80) in UTF-8, but AFTER in
    // UTF-16 code-unit order (0xFF5E > 0xD83D), so a naive sort() gets it wrong.
    const a = "～.txt";
    const b = "\u{1F600}.txt";
    writeFileSync(join(dir, a), "a");
    writeFileSync(join(dir, b), "b");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const base = [
      ["prompts/system.md", "You are a support agent.\n"],
      ["skills/refund/SKILL.md", "# Refund\r\nSteps\n"],
      ["scripts/check.py", ""],
      [a, "a"],
      [b, "b"],
    ] as const;
    const sorted = [...base].sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
    expect(sorted.findIndex((e) => e[0] === a)).toBeLessThan(sorted.findIndex((e) => e[0] === b));
    const expected = sha(sorted.map(([p, d]) => `${p}\t${sha(d)}\n`).join(""));
    expect(computeHarnessHash(["."], { root: dir })).toBe(expected);
  });

  it("NFC-normalises paths", () => {
    const nfd = "é.txt";
    const nfc = "é.txt";
    writeFileSync(join(dir, nfd), "x");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const lines = [
      ["prompts/system.md", "You are a support agent.\n"],
      ["skills/refund/SKILL.md", "# Refund\r\nSteps\n"],
      ["scripts/check.py", ""],
      [nfc, "x"],
    ]
      .sort((x, y) => Buffer.compare(Buffer.from(x[0]!), Buffer.from(y[0]!)))
      .map(([p, d]) => `${p}\t${sha(d!)}\n`);
    expect(computeHarnessHash(["."], { root: dir })).toBe(sha(lines.join("")));
  });

  it("returns undefined (never throws) for a missing path or a path outside root", () => {
    expect(computeHarnessHash(["nope.md"], { root: dir })).toBeUndefined();
    expect(computeHarnessHash(["../outside"], { root: dir })).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("returns undefined with a warning where fs is unavailable (browser/edge)", () => {
    _setNodeLoaderForTesting(() => null);
    expect(computeHarnessHash(["prompts"], { root: dir })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is exported from the package entry point", () => {
    expect(typeof morse.computeHarnessHash).toBe("function");
  });
});
