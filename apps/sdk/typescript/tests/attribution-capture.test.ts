/**
 * Attribution capture (MHQ-1275, openspec change `attribution-capture`):
 * record keys, declared agent version, prompt references, git revision and
 * service version — SDK side of ATTR-01, ATTR-04 and ATTR-06.
 *
 * Both wires are asserted: the JSON trace dict (`getLastTrace()` / legacy
 * transport) and real OTel spans captured by the engine's in-memory recorder.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { _resetAttributionWarningsForTesting } from "../src/_internal/attribution";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { getEngine } from "../src/_internal/otel-provider";
import {
  GIT_REVISION_ENV_VARS,
  _resetDeploymentIdentityForTesting,
  _setChildProcessLoaderForTesting,
  detectDeploymentIdentity,
  getGitRevision,
  getServiceVersion,
  parseOtelResourceAttributes,
} from "../src/_internal/revision";
import {
  _resetForTesting as _resetTracing,
  runSync,
  setAgentVersionDefault,
  spanSync,
} from "../src/_internal/tracing";
import type { BatchTransport } from "../src/_internal/transport";

const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1/api/v1/traces/batch";

const ENV_KEYS = [
  "MORSE_API_KEY",
  "MORSE_ENDPOINT",
  "MORSE_DISABLED",
  "MORSE_LEGACY_TRANSPORT",
  "OTEL_RESOURCE_ATTRIBUTES",
  ...GIT_REVISION_ENV_VARS,
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  morse._resetForTesting();
  _resetDeploymentIdentityForTesting();
  _resetAttributionWarningsForTesting();
  // Never let a developer's real checkout leak a revision into assertions.
  _setChildProcessLoaderForTesting(() => null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  morse._resetForTesting();
  _resetDeploymentIdentityForTesting();
  getEngine().resetForTesting();
  vi.restoreAllMocks();
});

interface TraceDict {
  record_keys?: Record<string, string>;
  agent_version?: string;
  prompts?: Array<{ name: string; version?: number; span_id?: string }>;
  trace_id: string;
  [k: string]: unknown;
}

function lastTrace(): {
  trace: TraceDict;
  spans: Array<Record<string, unknown>>;
  resource?: Record<string, unknown>;
} {
  const t = morse._getLastTraceForTesting();
  expect(t).not.toBeNull();
  return t as unknown as ReturnType<typeof lastTrace>;
}

function initSdk(opts: { agentVersion?: string } = {}): void {
  morse.init({ apiKey: "av_x", endpoint: UNREACHABLE_ENDPOINT, ...opts }); // pragma: allowlist secret
}

/* -------------------------------------------------------------------------- */
/*  ATTR-01 — linkRecord                                                       */
/* -------------------------------------------------------------------------- */

describe("linkRecord()", () => {
  // @spec: ATTR-01
  it("accumulates keys on the active trace and lower-cases the type", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.linkRecord("Zendesk_Ticket", "4812");
      morse.linkRecord("github_pr", 1123);
      return null;
    });
    expect(lastTrace().trace.record_keys).toEqual({ zendesk_ticket: "4812", github_pr: "1123" });
  });

  // @spec: ATTR-01
  it("trims the value and replaces a repeated type instead of duplicating it", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.linkRecord("order", "  A-1  ");
      morse.linkRecord("order", "A-2");
      return null;
    });
    expect(lastTrace().trace.record_keys).toEqual({ order: "A-2" });
  });

  // @spec: ATTR-01
  it("drops invalid pairs without throwing and keeps the valid ones", async () => {
    initSdk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = {
      toString() {
        throw new Error("customer toString must never run");
      },
    };
    await morse.runTraced({ agentName: "a" }, async () => {
      expect(() => {
        morse.linkRecord("bad key!", "x"); // space and bang
        morse.linkRecord("-leading-dash", "x");
        morse.linkRecord("a".repeat(65), "x"); // 65 chars
        morse.linkRecord("ok_empty", "   "); // empty after trim
        morse.linkRecord("too_long", "v".repeat(257));
        morse.linkRecord("nan", Number.NaN);
        morse.linkRecord("obj", hostile as unknown as string);
        morse.linkRecord(undefined as unknown as string, "x");
        morse.linkRecord("kept", "yes");
        morse.linkRecord("edge_256", "v".repeat(256));
        morse.linkRecord("a".repeat(64), "edge_type_64");
      }).not.toThrow();
      return null;
    });
    const keys = lastTrace().trace.record_keys!;
    expect(Object.keys(keys).sort()).toEqual(["a".repeat(64), "edge_256", "kept"].sort());
    // One warning for the whole batch of bad input, and it must not echo values.
    const warnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("record key"));
    expect(warnings).toHaveLength(1);
  });

  // @spec: ATTR-01
  it("keeps at most 20 keys per trace but still lets an existing type be updated", async () => {
    initSdk();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await morse.runTraced({ agentName: "a" }, async () => {
      for (let i = 0; i < 25; i++) morse.linkRecord(`k${i}`, i);
      morse.linkRecord("k0", "updated"); // existing type: allowed at the cap
      return null;
    });
    const keys = lastTrace().trace.record_keys!;
    expect(Object.keys(keys)).toHaveLength(20);
    expect(keys.k0).toBe("updated");
    expect(keys.k19).toBe("19");
    expect(keys.k20).toBeUndefined();
  });

  // @spec: ATTR-01
  it("is a silent no-op outside a trace", () => {
    initSdk();
    expect(() => morse.linkRecord("order", "A-1")).not.toThrow();
    expect(morse._getActiveTraceStateForTesting()).toBeNull();
  });

  // @spec: ATTR-01
  it("seeds from RunOptions.recordKeys and merges with later linkRecord calls", async () => {
    initSdk();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await morse.runTraced(
      { agentName: "a", recordKeys: { Order: "A-1", "bad key": "x", num: 7 } },
      async () => {
        morse.linkRecord("zendesk_ticket", "4812");
        return null;
      },
    );
    expect(lastTrace().trace.record_keys).toEqual({
      order: "A-1",
      num: "7",
      zendesk_ticket: "4812",
    });
  });

  // @spec: ATTR-01
  it("tolerates a non-object recordKeys from untyped callers", async () => {
    initSdk();
    await expect(
      morse.runTraced(
        { agentName: "a", recordKeys: "nope" as unknown as Record<string, string> },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
    expect(lastTrace().trace.record_keys).toBeUndefined();
  });

  // @spec: ATTR-01
  it("omits record_keys from the wire when none were set", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => null);
    expect("record_keys" in lastTrace().trace).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  ATTR-04 — agent version                                                    */
/* -------------------------------------------------------------------------- */

describe("agent version", () => {
  // @spec: ATTR-04
  it("uses the init() default when the run does not override it", async () => {
    initSdk({ agentVersion: "2026.10.1" });
    await morse.runTraced({ agentName: "a" }, async () => null);
    expect(lastTrace().trace.agent_version).toBe("2026.10.1");
  });

  // @spec: ATTR-04
  it("lets RunOptions.agentVersion override the init() default", async () => {
    initSdk({ agentVersion: "2026.10.1" });
    await morse.runTraced({ agentName: "a", agentVersion: "canary" }, async () => null);
    expect(lastTrace().trace.agent_version).toBe("canary");
  });

  // @spec: ATTR-04
  it("falls back to the init() default when the per-run value is blank", async () => {
    initSdk({ agentVersion: "base" });
    await morse.runTraced({ agentName: "a", agentVersion: "   " }, async () => null);
    expect(lastTrace().trace.agent_version).toBe("base");
  });

  // @spec: ATTR-04
  it("truncates to 128 characters and trims", async () => {
    initSdk();
    await morse.runTraced(
      { agentName: "a", agentVersion: `  ${"v".repeat(200)}` },
      async () => null,
    );
    expect(lastTrace().trace.agent_version).toBe("v".repeat(128));
  });

  // @spec: ATTR-04
  it("is absent from the wire when never declared", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => null);
    expect("agent_version" in lastTrace().trace).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  ATTR-04 — setPrompt                                                        */
/* -------------------------------------------------------------------------- */

describe("setPrompt()", () => {
  // @spec: ATTR-04
  it("records a name-only reference at trace level (no span id)", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.setPrompt("triage");
      return null;
    });
    expect(lastTrace().trace.prompts).toEqual([{ name: "triage" }]);
  });

  // @spec: ATTR-04
  it("records the version when it is an integer >= 1", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.setPrompt("triage", 7);
      return null;
    });
    expect(lastTrace().trace.prompts).toEqual([{ name: "triage", version: 7 }]);
  });

  // @spec: ATTR-04
  it("drops a non-integer or non-positive version but keeps the name", async () => {
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.setPrompt("p1", 0);
      morse.setPrompt("p2", 1.5);
      morse.setPrompt("p3", -2);
      morse.setPrompt("p4", "3" as unknown as number);
      return null;
    });
    expect(lastTrace().trace.prompts).toEqual([
      { name: "p1" },
      { name: "p2" },
      { name: "p3" },
      { name: "p4" },
    ]);
  });

  // @spec: ATTR-04
  it("pins the reference to the current span when called inside one", async () => {
    initSdk();
    let innerSpanId = "";
    await morse.runTraced({ agentName: "a" }, async () => {
      await morse.spanAsync({ name: "classify", type: "llm" }, async (h) => {
        innerSpanId = h!.span.span_id;
        morse.setPrompt("classifier", 3);
        return null;
      });
      return null;
    });
    expect(innerSpanId).not.toBe("");
    expect(lastTrace().trace.prompts).toEqual([
      { name: "classifier", version: 3, span_id: innerSpanId },
    ]);
  });

  // @spec: ATTR-04
  it("ignores an empty or non-string name, truncates a long one, and never throws", async () => {
    initSdk();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await morse.runTraced({ agentName: "a" }, async () => {
      expect(() => {
        morse.setPrompt("");
        morse.setPrompt("   ");
        morse.setPrompt(undefined as unknown as string);
        morse.setPrompt("n".repeat(300));
      }).not.toThrow();
      return null;
    });
    expect(lastTrace().trace.prompts).toEqual([{ name: "n".repeat(255) }]);
  });

  // @spec: ATTR-04
  it("de-duplicates identical references and caps a trace at 20", async () => {
    initSdk();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await morse.runTraced({ agentName: "a" }, async () => {
      morse.setPrompt("same", 1);
      morse.setPrompt("same", 1);
      for (let i = 0; i < 30; i++) morse.setPrompt(`p${i}`);
      return null;
    });
    const prompts = lastTrace().trace.prompts!;
    expect(prompts).toHaveLength(20);
    expect(prompts.filter((p) => p.name === "same")).toHaveLength(1);
  });

  // @spec: ATTR-04
  it("is a silent no-op outside a trace", () => {
    initSdk();
    expect(() => morse.setPrompt("triage", 1)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  JSON wire (ATTR-01/04/06)                                                  */
/* -------------------------------------------------------------------------- */

describe("JSON wire shape", () => {
  // @spec: ATTR-01
  it("sends record_keys, agent_version and prompts on the trace through the legacy transport", async () => {
    process.env.MORSE_LEGACY_TRANSPORT = "1";
    process.env.MORSE_GIT_REVISION = "abc123";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.version=2.4.1";
    const events: unknown[] = [];
    morse._setTransportFactoryForTesting(
      () =>
        ({
          track(e: unknown) {
            events.push(e);
            return true;
          },
          flush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        }) as unknown as BatchTransport,
    );
    initSdk({ agentVersion: "v9" });
    await morse.runTraced({ agentName: "wire", recordKeys: { order: "A-1" } }, async () => {
      morse.linkRecord("zendesk_ticket", "4812");
      morse.setPrompt("triage", 7);
      return null;
    });

    expect(events).toHaveLength(1);
    const entry = (events[0] as { traces: Array<Record<string, unknown>> }).traces[0]!;
    expect(entry.trace).toMatchObject({
      agent: "wire",
      record_keys: { order: "A-1", zendesk_ticket: "4812" },
      agent_version: "v9",
      prompts: [{ name: "triage", version: 7 }],
    });
    expect(entry.resource).toEqual({ "git.revision": "abc123", "service.version": "2.4.1" });
  });

  // @spec: ATTR-06
  it("omits the resource entirely when nothing is detected and no framework or source is set", async () => {
    initSdk();
    await morse.runTraced({ agentName: "plain" }, async () => null);
    expect(lastTrace().resource).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  OTLP wire (ATTR-01/04/06)                                                  */
/* -------------------------------------------------------------------------- */

describe("OTLP wire shape", () => {
  function configureRecorder(identity: { gitRevision?: string; serviceVersion?: string } = {}) {
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
      ...identity,
    });
    return engine;
  }

  async function exported(
    engine: ReturnType<typeof configureRecorder>,
    traceId: string,
  ): Promise<Map<string, ReadableSpan>> {
    await engine.flush();
    const byName = new Map<string, ReadableSpan>();
    for (const s of engine.recorder!.spans) {
      if (s.spanContext().traceId === traceId) byName.set(s.name, s);
    }
    return byName;
  }

  // @spec: ATTR-01
  it("puts record keys and agent version on the root span only", async () => {
    const engine = configureRecorder();
    runSync({ agentName: "otlp-root", recordKeys: { Order: "A-1" }, agentVersion: "v3" }, () => {
      morse.linkRecord("github_pr", 1123);
      spanSync({ name: "child", type: "tool" }, () => undefined);
    });
    const traceId = lastTrace().trace.trace_id;
    const spans = await exported(engine, traceId);
    const root = spans.get("otlp-root")!;
    const child = spans.get("child")!;
    expect(root.attributes["morse.record_key.order"]).toBe("A-1");
    expect(root.attributes["morse.record_key.github_pr"]).toBe("1123");
    expect(root.attributes["morse.agent_version"]).toBe("v3");
    expect(child.attributes["morse.agent_version"]).toBeUndefined();
    expect(Object.keys(child.attributes).some((k) => k.startsWith("morse.record_key."))).toBe(
      false,
    );
  });

  // @spec: ATTR-04
  it("puts a prompt reference on the span setPrompt ran in, and trace-level ones on the root", async () => {
    const engine = configureRecorder();
    runSync({ agentName: "otlp-prompts" }, () => {
      morse.setPrompt("router", 2); // top level -> root
      spanSync({ name: "classify", type: "llm" }, () => {
        morse.setPrompt("classifier", 5);
      });
      spanSync({ name: "summarize", type: "llm" }, () => {
        morse.setPrompt("summarizer"); // no version
      });
    });
    const spans = await exported(engine, lastTrace().trace.trace_id);
    expect(spans.get("otlp-prompts")!.attributes["morse.prompt.name"]).toBe("router");
    expect(spans.get("otlp-prompts")!.attributes["morse.prompt.version"]).toBe(2);
    expect(spans.get("classify")!.attributes["morse.prompt.name"]).toBe("classifier");
    expect(spans.get("classify")!.attributes["morse.prompt.version"]).toBe(5);
    expect(spans.get("summarize")!.attributes["morse.prompt.name"]).toBe("summarizer");
    expect(spans.get("summarize")!.attributes["morse.prompt.version"]).toBeUndefined();
  });

  // @spec: ATTR-04
  it("exports the LAST reference when several land on one span (matches the Python SDK), and keeps all on the JSON dict", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = configureRecorder();
    runSync({ agentName: "otlp-shared" }, () => {
      spanSync({ name: "multi", type: "llm" }, () => {
        morse.setPrompt("first", 1);
        morse.setPrompt("second", 2);
      });
    });
    const trace = lastTrace().trace;
    expect(trace.prompts).toHaveLength(2); // JSON path loses nothing
    const spans = await exported(engine, trace.trace_id);
    expect(spans.get("multi")!.attributes["morse.prompt.name"]).toBe("second");
    expect(spans.get("multi")!.attributes["morse.prompt.version"]).toBe(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("one per span"))).toBe(true);
  });

  // @spec: ATTR-04
  it("falls back to the root span when the span a prompt was set in never finished", async () => {
    const engine = configureRecorder();
    runSync({ agentName: "otlp-orphan" }, () => {
      // startSpan without end(): the span is never recorded, its ref must not vanish.
      morse.startSpan({ name: "leaked", type: "llm" });
      morse.setPrompt("orphaned", 4);
    });
    const spans = await exported(engine, lastTrace().trace.trace_id);
    expect(spans.get("otlp-orphan")!.attributes["morse.prompt.name"]).toBe("orphaned");
  });

  // @spec: ATTR-06
  it("stamps git.revision and service.version on the OTel resource when known", async () => {
    const engine = configureRecorder({ gitRevision: "abc123", serviceVersion: "2.4.1" });
    runSync({ agentName: "otlp-resource" }, () => undefined);
    const spans = await exported(engine, lastTrace().trace.trace_id);
    const attrs = spans.get("otlp-resource")!.resource.attributes;
    expect(attrs["git.revision"]).toBe("abc123");
    expect(attrs["service.version"]).toBe("2.4.1");
    expect(attrs["service.name"]).toBeUndefined(); // MHQ-1100 invariant holds
  });

  // @spec: ATTR-06
  it("leaves the resource free of both attributes when nothing was detected", async () => {
    const engine = configureRecorder();
    runSync({ agentName: "otlp-bare" }, () => undefined);
    const spans = await exported(engine, lastTrace().trace.trace_id);
    const attrs = spans.get("otlp-bare")!.resource.attributes;
    expect(attrs["git.revision"]).toBeUndefined();
    expect(attrs["service.version"]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  ATTR-06 — git revision and service version detection                       */
/* -------------------------------------------------------------------------- */

describe("git revision detection", () => {
  const SHA = "abcdef1234abcdef1234abcdef1234abcdef1234"; // pragma: allowlist secret (a fake commit sha)

  // @spec: ATTR-06
  it("honours the documented env precedence, first match wins", () => {
    expect([...GIT_REVISION_ENV_VARS]).toEqual([
      "MORSE_GIT_REVISION",
      "GITHUB_SHA",
      "CI_COMMIT_SHA",
      "RAILWAY_GIT_COMMIT_SHA",
      "VERCEL_GIT_COMMIT_SHA",
      "RENDER_GIT_COMMIT",
      "SOURCE_VERSION",
    ]);
    // Set them all, then peel the winner off one at a time.
    for (const k of GIT_REVISION_ENV_VARS) process.env[k] = `rev-from-${k}`;
    for (const k of GIT_REVISION_ENV_VARS) {
      expect(detectDeploymentIdentity().gitRevision).toBe(`rev-from-${k}`);
      delete process.env[k];
    }
    expect(detectDeploymentIdentity().gitRevision).toBeUndefined();
  });

  // @spec: ATTR-06
  it("accepts MORSE_GIT_REVISION alone (a Docker build with no git binary)", () => {
    process.env.MORSE_GIT_REVISION = "abc123";
    expect(detectDeploymentIdentity().gitRevision).toBe("abc123");
    expect(getGitRevision()).toBe("abc123");
  });

  // @spec: ATTR-06
  it("falls through to SOURCE_VERSION when only the last env var is set", () => {
    process.env.SOURCE_VERSION = "heroku-sha";
    expect(detectDeploymentIdentity().gitRevision).toBe("heroku-sha");
  });

  // @spec: ATTR-06
  it("skips blank env values, trims, and truncates to 40 characters like the server", () => {
    process.env.MORSE_GIT_REVISION = "   ";
    process.env.GITHUB_SHA = `  ${"f".repeat(64)}  `;
    expect(detectDeploymentIdentity().gitRevision).toBe("f".repeat(40));
  });

  // @spec: ATTR-06
  it("runs `git rev-parse HEAD` last, with a short timeout and ignored stdio", () => {
    const execFileSync = vi.fn(() => `${SHA}\n`);
    _setChildProcessLoaderForTesting(() => ({ execFileSync }));
    expect(detectDeploymentIdentity().gitRevision).toBe(SHA);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileSync.mock.calls[0] as unknown as [
      string,
      string[],
      { timeout: number; stdio: unknown[] },
    ];
    expect(file).toBe("git");
    expect(args).toEqual(["rev-parse", "HEAD"]);
    expect(options.timeout).toBeLessThanOrEqual(500);
    expect(options.stdio[0]).toBe("ignore");
    expect(options.stdio[2]).toBe("ignore");
  });

  // @spec: ATTR-06
  it("never spawns git when an env var already answered", () => {
    const execFileSync = vi.fn(() => SHA);
    _setChildProcessLoaderForTesting(() => ({ execFileSync }));
    process.env.GITHUB_SHA = "from-ci";
    expect(detectDeploymentIdentity().gitRevision).toBe("from-ci");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  // @spec: ATTR-06
  it("caches the git result for the process: a second init() does not spawn again", () => {
    const execFileSync = vi.fn(() => SHA);
    _setChildProcessLoaderForTesting(() => ({ execFileSync }));
    detectDeploymentIdentity();
    detectDeploymentIdentity();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  // @spec: ATTR-06
  it("caches a failed lookup too, so a non-git directory costs one attempt", () => {
    const execFileSync = vi.fn(() => {
      throw new Error("not a git repository");
    });
    _setChildProcessLoaderForTesting(() => ({ execFileSync }));
    expect(detectDeploymentIdentity().gitRevision).toBeUndefined();
    detectDeploymentIdentity();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  // @spec: ATTR-06
  it("does not throw and reports no revision when child_process is unavailable", () => {
    _setChildProcessLoaderForTesting(() => null);
    expect(() => detectDeploymentIdentity()).not.toThrow();
    expect(getGitRevision()).toBeUndefined();
  });

  // @spec: ATTR-06
  it("does not throw when loading child_process itself throws", () => {
    _setChildProcessLoaderForTesting(() => {
      throw new Error("Module not found: child_process");
    });
    expect(() => detectDeploymentIdentity()).not.toThrow();
    expect(getGitRevision()).toBeUndefined();
  });

  // @spec: ATTR-06
  it("rejects git output that is not an object id", () => {
    _setChildProcessLoaderForTesting(() => ({
      execFileSync: () => "warning: something printed a banner\n",
    }));
    expect(detectDeploymentIdentity().gitRevision).toBeUndefined();
  });

  // @spec: ATTR-06
  it("works against the real loader inside this repository checkout (smoke)", () => {
    _resetDeploymentIdentityForTesting(); // restores the real child_process loader
    const found = detectDeploymentIdentity().gitRevision;
    // Either a real sha (checkout) or undefined (no git) — never an exception or garbage.
    if (found !== undefined) expect(found).toMatch(/^[0-9a-f]{7,40}$/i);
  });

  // @spec: ATTR-06
  it("init() wires the detected revision and service version onto the JSON resource", async () => {
    process.env.MORSE_GIT_REVISION = "deadbeef";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=prod,service.version=2.4.1";
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => null);
    expect(lastTrace().resource).toEqual({
      "git.revision": "deadbeef",
      "service.version": "2.4.1",
    });
  });

  // @spec: ATTR-06
  it("keeps child_process out of the bundle graph: no static import or require literal", () => {
    const src = readFileSync(join(__dirname, "../src/_internal/revision.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\bfrom\s*["'](node:)?child_process["']/);
    expect(code).not.toMatch(/\brequire\(\s*["'](node:)?child_process["']\s*\)/);
    expect(code).not.toMatch(/\bimport\(\s*["'](node:)?child_process["']\s*\)/);
  });
});

describe("service.version from OTEL_RESOURCE_ATTRIBUTES", () => {
  // @spec: ATTR-06
  it("parses comma-separated k=v pairs and percent-decodes values", () => {
    expect(
      parseOtelResourceAttributes("a=1, service.version=2.4.1%2Bbuild%2012 ,b=x=y,novalue,=nokey"),
    ).toEqual({ a: "1", "service.version": "2.4.1+build 12", b: "x=y" });
  });

  // @spec: ATTR-06
  it("keeps a value verbatim when it is not valid percent-encoding", () => {
    expect(parseOtelResourceAttributes("service.version=100%")).toEqual({
      "service.version": "100%",
    });
  });

  // @spec: ATTR-06
  it("surfaces service.version only, truncated to 128, and is empty when unset", () => {
    expect(detectDeploymentIdentity().serviceVersion).toBeUndefined();
    process.env.OTEL_RESOURCE_ATTRIBUTES = `team=a,service.version=${"9".repeat(200)}`;
    expect(detectDeploymentIdentity().serviceVersion).toBe("9".repeat(128));
    expect(getServiceVersion()).toBe("9".repeat(128));
  });

  // @spec: ATTR-06
  it("ignores an OTEL_RESOURCE_ATTRIBUTES without service.version", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=prod";
    expect(detectDeploymentIdentity().serviceVersion).toBeUndefined();
  });
});

describe("module-level state hygiene", () => {
  // @spec: ATTR-04
  it("_resetForTesting clears the init() agent version default", async () => {
    setAgentVersionDefault("stale");
    _resetTracing();
    initSdk();
    await morse.runTraced({ agentName: "a" }, async () => null);
    expect("agent_version" in lastTrace().trace).toBe(false);
  });
});
