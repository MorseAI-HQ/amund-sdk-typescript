/**
 * Phase 6f Wave B G-02 — TypeScript SDK PII redaction.
 *
 * Coverage:
 *   - Pattern hits / misses for each catalogue key (mirrors Python SDK).
 *   - Config validation: mandatory-pattern lock, regex compile, caps.
 *   - JSON walker preserves non-string types, redacts string leaves.
 *   - Custom patterns produce `[REDACTED:custom]`.
 *   - Opt-out (`redaction.enabled = false`) emits raw strings client-side.
 *   - `init()` throws on disabling a mandatory pattern (no Client built).
 *   - Parity corpus: byte-equal output to server + Python SDK for every row.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as morse from "../src/index";
import {
  buildRedactionConfig,
  MANDATORY_PATTERNS,
  PATTERN_ORDER,
  redactString,
  redactValue,
} from "../src/_internal/redaction";
import { type BatchTransport } from "../src/_internal/transport";

const here = dirname(fileURLToPath(import.meta.url));
const PARITY_CORPUS_PATH = resolve(
  here,
  "./fixtures/parity_corpus.json",
);

interface ParityRow {
  id: string;
  input: string;
  expected_output: string;
  enabled_patterns: string[];
}

interface ParityCorpus {
  rows: ParityRow[];
}

/* ------------------------------------------------------------------------ */
/*  Test transport                                                           */
/* ------------------------------------------------------------------------ */

interface MockTransport {
  events: Array<Record<string, unknown>>;
}

function installMockTransport(): MockTransport {
  const state: MockTransport = { events: [] };
  const factory = (): BatchTransport => {
    return {
      track(event: Record<string, unknown>): boolean {
        state.events.push(event);
        return true;
      },
      flush(): Promise<void> {
        return Promise.resolve();
      },
      shutdown(): Promise<void> {
        return Promise.resolve();
      },
    } as unknown as BatchTransport;
  };
  morse._setTransportFactoryForTesting(factory);
  return state;
}

beforeEach(() => {
  morse._resetForTesting();
});

afterEach(() => {
  morse._resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Pattern hit / miss matrix                                                */
/* ------------------------------------------------------------------------ */

describe("redactString — pattern hits", () => {
  const config = buildRedactionConfig();

  it("redacts an OpenAI sk- key", () => {
    // @spec: PHASE-6F-G02
    const out = redactString("key=sk-proj-AbCdEf1234567890ghIjKlMnOpQrStUv done", config);
    expect(out).toBe("key=[REDACTED:api_key] done");
  });

  it("redacts a Stripe sk_live_ key", () => {
    // @spec: PHASE-6F-G02
    // MHQ-973 changed this expectation. `api_key_prefixed` still fires first and
    // tags the key, but `secret_assignment` then consumes the whole
    // `secret=<value>` assignment, so the leading `secret=` disappears too. The
    // credential is no less redacted — the label is broader, and the key name
    // goes with it. Server and Python SDK produce byte-identical output.
    const out = redactString("secret=sk_live_51AbCdEfGhIjKlMnOpQrStUvWx end", config);
    expect(out).toBe("[REDACTED:secret] end");
  });

  it("redacts a bare Stripe sk_live_ key with no assignment context", () => {
    // @spec: PHASE-6F-G02
    // The companion to the case above: with no `key=` around it, the value-shaped
    // pattern is the only one that can fire, and it still does.
    const out = redactString("token is sk_live_51AbCdEfGhIjKlMnOpQrStUvWx end", config);
    expect(out).toBe("token is [REDACTED:api_key] end");
  });

  it("redacts an Morse av_ key", () => {
    // @spec: PHASE-6F-G02
    const out = redactString("av_fe9a2ea712345678abcdef0987654321", config);
    expect(out).toBe("[REDACTED:api_key]");
  });

  it("redacts a GitHub PAT", () => {
    // @spec: PHASE-6F-G02
    const out = redactString("ghp_1234567890abcdef1234567890abcdef1234", config);
    expect(out).toBe("[REDACTED:api_key]");
  });

  it("redacts an AWS access key id", () => {
    // @spec: PHASE-6F-G02
    const out = redactString("AKIAIOSFODNN7EXAMPLE in env", config);
    expect(out).toBe("[REDACTED:api_key] in env");
  });

  it("redacts a Slack bot token", () => {
    // @spec: PHASE-6F-G02
    const out = redactString("xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx", config);
    expect(out).toBe("[REDACTED:api_key]");
  });

  it("redacts a JWT-shaped string", () => {
    // @spec: PHASE-6F-G02
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.xCJVoSi1q19SPSk7kKb6kYP8yU3yz7sLcG5bbqJyU2Q";
    expect(redactString(`Bearer ${jwt}`, config)).toBe("Bearer [REDACTED:jwt]");
  });

  it("redacts a Visa card that passes Luhn", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("Card 4111 1111 1111 1111 today", config)).toBe(
      "Card [REDACTED:credit_card] today",
    );
  });

  it("redacts an Amex card that passes Luhn", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("Charged 378282246310005", config)).toBe("Charged [REDACTED:credit_card]");
  });

  it("redacts an email", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("ping jane@example.com pls", config)).toBe("ping [REDACTED:email] pls");
  });

  it("redacts a US phone (dashed)", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("call 555-867-5309 back", config)).toBe("call [REDACTED:phone] back");
  });

  it("redacts a US phone (parens)", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("(415) 555-2671 line", config)).toBe("[REDACTED:phone] line");
  });

  it("redacts an E.164 international phone", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("intl +44 20 7946 0958 line", config)).toBe("intl [REDACTED:phone] line");
  });

  it("redacts a US SSN", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("ssn 123-45-6789 done", config)).toBe("ssn [REDACTED:ssn] done");
  });

  it("does NOT match invalid SSN prefixes (000, 666, 9XX)", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("000-12-3456", config)).toBe("000-12-3456");
    expect(redactString("666-12-3456", config)).toBe("666-12-3456");
    expect(redactString("912-34-5678", config)).toBe("912-34-5678");
  });

  it("does NOT match a 16-digit number that fails Luhn", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("digits 1234567890123456 fail", config)).toBe(
      "digits 1234567890123456 fail",
    );
  });

  it("does NOT match short api-key-shaped strings", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("sk-abc tiny", config)).toBe("sk-abc tiny");
  });

  it("does NOT touch clean text", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("Hello world!", config)).toBe("Hello world!");
  });

  it("returns empty string unchanged", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("", config)).toBe("");
  });

  it("ip_address is OFF by default", () => {
    // @spec: PHASE-6F-G02
    expect(redactString("from 192.168.1.42", config)).toBe("from 192.168.1.42");
  });

  it("ip_address redacts IPv4 when explicitly enabled via override", () => {
    // @spec: PHASE-6F-G02
    const enabled = new Set([...PATTERN_ORDER]);
    expect(redactString("from 192.168.1.42", config, enabled)).toBe("from [REDACTED:ip]");
  });
});

/* ------------------------------------------------------------------------ */
/*  Config validation                                                        */
/* ------------------------------------------------------------------------ */

describe("buildRedactionConfig — validation", () => {
  it("opt-out short-circuits all built-ins", () => {
    // @spec: PHASE-6F-G02
    const cfg = buildRedactionConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledPatterns.size).toBe(0);
    expect(redactString("sk_live_51AbCdEfGhIjKlMnOpQrStUvWx", cfg)).toBe(
      "sk_live_51AbCdEfGhIjKlMnOpQrStUvWx",
    );
  });

  it("rejects disabling a mandatory pattern (api_key_prefixed)", () => {
    // @spec: PHASE-6F-G02
    expect(() => buildRedactionConfig({ disabledPatterns: ["api_key_prefixed"] })).toThrow(
      /api_key_prefixed/,
    );
  });

  it("rejects disabling jwt", () => {
    // @spec: PHASE-6F-G02
    expect(() => buildRedactionConfig({ disabledPatterns: ["jwt"] })).toThrow(/jwt/);
  });

  it("rejects disabling credit_card", () => {
    // @spec: PHASE-6F-G02
    expect(() => buildRedactionConfig({ disabledPatterns: ["credit_card"] })).toThrow(
      /credit_card/,
    );
  });

  it("rejects disabling ssn_us", () => {
    // @spec: PHASE-6F-G02
    expect(() => buildRedactionConfig({ disabledPatterns: ["ssn_us"] })).toThrow(/ssn_us/);
  });

  it("allows disabling email (non-mandatory)", () => {
    // @spec: PHASE-6F-G02
    const cfg = buildRedactionConfig({ disabledPatterns: ["email"] });
    expect(cfg.enabledPatterns.has("email")).toBe(false);
    expect(redactString("hi jane@example.com", cfg)).toBe("hi jane@example.com");
  });

  it("rejects more than 10 extra patterns", () => {
    // @spec: PHASE-6F-G02
    const eleven = Array.from({ length: 11 }, (_, i) => `X${i}`);
    expect(() => buildRedactionConfig({ extraPatterns: eleven })).toThrow(
      /too many redaction extra patterns/,
    );
  });

  it("rejects an extra pattern over 256 chars", () => {
    // @spec: PHASE-6F-G02
    const big = "a".repeat(257);
    expect(() => buildRedactionConfig({ extraPatterns: [big] })).toThrow(/256 chars/);
  });

  it("rejects an uncompilable extra regex", () => {
    // @spec: PHASE-6F-G02
    expect(() => buildRedactionConfig({ extraPatterns: ["["] })).toThrow(/failed to compile/);
  });

  it("applies a valid extra regex", () => {
    // @spec: PHASE-6F-G02
    const cfg = buildRedactionConfig({ extraPatterns: ["INTERNAL-\\w+"] });
    expect(redactString("hit INTERNAL-ABC done", cfg)).toBe("hit [REDACTED:custom] done");
  });

  it("MANDATORY_PATTERNS exposes the four locked keys", () => {
    // @spec: PHASE-6F-G02
    expect(MANDATORY_PATTERNS.has("api_key_prefixed")).toBe(true);
    expect(MANDATORY_PATTERNS.has("jwt")).toBe(true);
    expect(MANDATORY_PATTERNS.has("credit_card")).toBe(true);
    expect(MANDATORY_PATTERNS.has("ssn_us")).toBe(true);
    expect(MANDATORY_PATTERNS.size).toBe(4);
  });
});

/* ------------------------------------------------------------------------ */
/*  JSON walker                                                              */
/* ------------------------------------------------------------------------ */

describe("redactValue — JSON walker", () => {
  const config = buildRedactionConfig();

  it("redacts string leaves and preserves primitives", () => {
    // @spec: PHASE-6F-G02
    const out = redactValue(
      {
        prompt: "use sk-proj-AbCdEf1234567890ghIjKlMnOpQrStUv now",
        cost: 1.42,
        ok: true,
        nullable: null,
      },
      config,
    );
    expect(out).toEqual({
      prompt: "use [REDACTED:api_key] now",
      cost: 1.42,
      ok: true,
      nullable: null,
    });
  });

  it("recurses through arrays", () => {
    // @spec: PHASE-6F-G02
    const out = redactValue(["clean", "ping jane@example.com", 42], config);
    expect(out).toEqual(["clean", "ping [REDACTED:email]", 42]);
  });

  it("recurses through nested objects", () => {
    // @spec: PHASE-6F-G02
    const out = redactValue(
      {
        a: { b: { c: "send to jane@example.com please" } },
      },
      config,
    );
    expect(out).toEqual({
      a: { b: { c: "send to [REDACTED:email] please" } },
    });
  });

  it("bounds recursion depth at 10", () => {
    // @spec: PHASE-6F-G02
    // Build a 12-deep nest holding an email at the bottom.
    type Nest = { next?: Nest; leaf?: string };
    const root: Nest = {};
    let cur: Nest = root;
    for (let i = 0; i < 11; i++) {
      cur.next = {};
      cur = cur.next;
    }
    cur.leaf = "ping jane@example.com";

    const out = redactValue(root, config) as Nest;
    // Walk down — at depth 10 the leaf should remain unredacted.
    let walker: Nest = out;
    for (let i = 0; i < 11; i++) {
      walker = walker.next as Nest;
    }
    expect(walker.leaf).toBe("ping jane@example.com");
  });

  it("returns input unchanged when redaction is disabled", () => {
    // @spec: PHASE-6F-G02
    const cfg = buildRedactionConfig({ enabled: false });
    const obj = { msg: "send sk_live_51AbCdEfGhIjKlMnOpQrStUvWx" };
    expect(redactValue(obj, cfg)).toBe(obj);
  });
});

/* ------------------------------------------------------------------------ */
/*  init() validation propagation                                            */
/* ------------------------------------------------------------------------ */

describe("init() — redaction validation", () => {
  it("throws when disabling jwt; no client constructed", () => {
    // @spec: PHASE-6F-G02
    expect(() =>
      morse.init({
        apiKey: "av_test_123",
        redaction: { disabledPatterns: ["jwt"] },
      }),
    ).toThrow(/jwt/);
    // No singleton → flush is a silent no-op (returns undefined).
    return morse.flush();
  });

  it("throws on uncompilable extra pattern", () => {
    // @spec: PHASE-6F-G02
    expect(() =>
      morse.init({
        apiKey: "av_test_123",
        redaction: { extraPatterns: ["["] },
      }),
    ).toThrow(/failed to compile/);
  });

  it("track() with default redaction redacts api keys before transport", () => {
    // @spec: PHASE-6F-G02
    const transport = installMockTransport();
    morse.init({ apiKey: "av_test_123" });
    morse.track({
      agentId: "lead-qual",
      runData: {
        input: "use sk-proj-AbCdEf1234567890ghIjKlMnOpQrStUv now",
        ok: true,
      },
    });
    expect(transport.events).toHaveLength(1);
    const event = transport.events[0] as Record<string, unknown>;
    expect(event.input).toBe("use [REDACTED:api_key] now");
    expect(event.ok).toBe(true);
  });

  it("track() with redaction.enabled=false emits raw values (server still applies floor)", () => {
    // @spec: PHASE-6F-G02
    const transport = installMockTransport();
    morse.init({
      apiKey: "av_test_123",
      redaction: { enabled: false },
    });
    morse.track({
      agentId: "lead-qual",
      runData: {
        input: "use sk-proj-AbCdEf1234567890ghIjKlMnOpQrStUv now",
      },
    });
    expect(transport.events).toHaveLength(1);
    const event = transport.events[0] as Record<string, unknown>;
    expect(event.input).toBe("use sk-proj-AbCdEf1234567890ghIjKlMnOpQrStUv now");
  });

  it("track() with custom extra pattern emits [REDACTED:custom]", () => {
    // @spec: PHASE-6F-G02
    // The custom regex `INTERNAL-[\w-]+` greedily eats ABC-42 (since \w
    // alone stops at the dash, we widen the class to match the spec
    // scenario's intent of the whole token redacting to `[REDACTED:custom]`).
    const transport = installMockTransport();
    morse.init({
      apiKey: "av_test_123",
      redaction: { extraPatterns: ["INTERNAL-[\\w-]+"] },
    });
    morse.track({
      agentId: "lead-qual",
      runData: { msg: "INTERNAL-ABC-42 done" },
    });
    const event = transport.events[0] as Record<string, unknown>;
    expect(event.msg).toBe("[REDACTED:custom] done");
  });
});

/* ------------------------------------------------------------------------ */
/*  Parity corpus                                                            */
/* ------------------------------------------------------------------------ */

describe("parity corpus", () => {
  const corpus: ParityCorpus = JSON.parse(readFileSync(PARITY_CORPUS_PATH, "utf8"));

  for (const row of corpus.rows) {
    it(`row ${row.id}`, () => {
      // @spec: PHASE-6F-G02
      const config = buildRedactionConfig();
      const enabled = row.enabled_patterns.length === 0 ? undefined : new Set(row.enabled_patterns);
      const out = redactString(row.input, config, enabled);
      expect(out).toBe(row.expected_output);
    });
  }
});

// MHQ-1412 — identifiers are not PII (dogfood 2026-10-18, groups A/D/F).
describe("identifiers survive the digit-run patterns", () => {
  const config = buildRedactionConfig();
  const ids = [
    '{"id": "bc41d39b-d298-4de5-83ba-0c4576313225"}',
    '{"duplicate_of_span_id": "40128888-8888-1881-286c-7f355e8c7903"}',
    "trace_id=50df6d43791e4443b23f7f4576313225",
    "span 4c4155551234abcd",
  ];
  for (const text of ids) {
    it(`keeps ${text}`, () => {
      expect(redactString(text, config)).toBe(text);
    });
  }

  const pii: Array<[string, string]> = [
    [
      "call 415-555-1234 re 2d16e332-1935-4a18-8568-ddf9431a1c3c",
      "call [REDACTED:phone] re 2d16e332-1935-4a18-8568-ddf9431a1c3c",
    ],
    ["card 4111111111111111", "card [REDACTED:credit_card]"],
    ["ssn 123-45-6789", "ssn [REDACTED:ssn]"],
    ["deadbeefdeadbeef12@example.com", "[REDACTED:email]"],
    ["ghp_1234567890abcdef1234567890abcdef1234", "[REDACTED:api_key]"], // pragma: allowlist secret
  ];
  for (const [input, expected] of pii) {
    it(`still redacts ${input}`, () => {
      expect(redactString(input, config)).toBe(expected);
    });
  }
});
