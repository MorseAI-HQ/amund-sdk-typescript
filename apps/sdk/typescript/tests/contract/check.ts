/**
 * Real-agent-SDK contract check — see ./README.md for why this exists.
 *
 * Run in plain Node (`pnpm contract`), NOT vitest. That is deliberate and
 * load-bearing: every adapter resolves its target with
 * `Function("m", "return import(m)")`, and vitest's module runner cannot
 * resolve a bare specifier from an eval'd context — under vitest those
 * lookups fail for environment reasons and every assertion below would go
 * red against a perfectly healthy package. Verified 2026-08-05: the same
 * imports succeed in Node ESM and fail under vitest. Testing them there
 * would measure the test runner, not the SDK.
 *
 * Assertions are structural only — the export we patch, the class we
 * subclass, the function we replace. No API keys, no network, no model
 * calls; live end-to-end coverage is the nightly canary's job.
 */
import assert from "node:assert/strict";

import { getCallbackHandlerClass } from "../../src/langgraph/callback-handler";
import { installMorseTraceProcessor } from "../../src/openai-agents/trace-processor";
import { createTracedVercelAI } from "../../src/vercel-ai";
import {
  isClaudeAgentSDKWrapped,
  wrapClaudeAgentSDK,
} from "../../src/anthropic-agent-sdk/client-wrapper";
import {
  isClaudeAgentQueryWrapped,
  wrapClaudeAgentQuery,
} from "../../src/anthropic-agent-sdk/query-wrapper";

interface Result {
  pkg: string;
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail?: string;
}

const results: Result[] = [];

/**
 * MHQ-930: `CONTRACT_ONLY=<pkg>` narrows the run to one framework, so a nightly
 * `latest` lane that bumps a single package reports only that package. Without
 * it every lane would also re-report the three still at their pinned floor,
 * and a failure anywhere would make all four lanes red and unattributable.
 *
 * Filtered-out assertions are reported as `skip`, never dropped silently — a
 * lane that quietly ran nothing must not read the same as a lane that passed.
 */
const ONLY = process.env.CONTRACT_ONLY?.trim() || null;

async function check(pkg: string, name: string, fn: () => Promise<void> | void): Promise<void> {
  if (ONLY && pkg !== ONLY) {
    results.push({ pkg, name, status: "skip", detail: `filtered out by CONTRACT_ONLY=${ONLY}` });
    return;
  }
  try {
    await fn();
    results.push({ pkg, name, status: "pass" });
  } catch (err) {
    results.push({
      pkg,
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A known, tracked gap: reported every run, but does not fail the build.
 *
 * Currently unused — MHQ-936 closed the only one by fixing the adapter rather
 * than waiting for an upstream export that was never coming. Kept because
 * `engineering/SDK_VERSION_SUPPORT.md` rule 4 ("known gaps are declared, not
 * hidden") names this helper as the mechanism, and the next real gap should
 * reach for it instead of quietly deleting an assertion.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above
async function knownGap(pkg: string, name: string, fn: () => Promise<void> | void): Promise<void> {
  if (ONLY && pkg !== ONLY) {
    results.push({ pkg, name, status: "skip", detail: `filtered out by CONTRACT_ONLY=${ONLY}` });
    return;
  }
  try {
    await fn();
    // It started passing — the gap closed. That is a real event: go delete
    // the knownGap() wrapper and the stale docs it refers to.
    results.push({
      pkg,
      name,
      status: "fail",
      detail:
        "This known gap now PASSES — promote it to check() and update the docs it references.",
    });
  } catch (err) {
    results.push({
      pkg,
      name,
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function version(pkg: string): Promise<string> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);

  // Fast path. Fails for packages whose `exports` map does not expose
  // ./package.json — which is most of them now, including
  // @anthropic-ai/claude-agent-sdk and @openai/agents.
  try {
    return require(`${pkg}/package.json`).version as string;
  } catch {
    /* fall through */
  }

  // Fallback: resolve the package entry point, then walk up to the nearest
  // package.json whose `name` matches. Reading the version matters — a lane
  // reporting "pkg@unknown <-- under test" proves nothing to whoever reads it.
  try {
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const { readFileSync } = await import("node:fs");

    let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
    for (let i = 0; i < 10; i++) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (meta.name === pkg) return meta.version as string;
      } catch {
        /* keep walking */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }

  return "unknown";
}

/* -------------------------------------------------------------------- */
/*  @openai/agents                                                       */
/* -------------------------------------------------------------------- */

await check("@openai/agents", "addTraceProcessor export still resolves", async () => {
  const { installed, processor } = await installMorseTraceProcessor();
  assert.equal(
    installed,
    true,
    "installMorseTraceProcessor() returned installed:false — the module resolved but " +
      "addTraceProcessor was missing, or the module did not resolve. Either way the " +
      "OpenAI Agents adapter emits nothing and swallows the reason.",
  );
  await processor?.shutdown();
});

await check("@openai/agents", "Runner.prototype.run is patchable", async () => {
  const mod = (await import("@openai/agents")) as unknown as {
    Runner?: { prototype?: { run?: unknown } };
  };
  assert.equal(typeof mod.Runner, "function", "Runner export is gone");
  assert.equal(
    typeof mod.Runner?.prototype?.run,
    "function",
    "Runner.prototype.run is gone — findRunnerPrototypeCarrier() will return null",
  );
});

/* -------------------------------------------------------------------- */
/*  @langchain/core                                                      */
/* -------------------------------------------------------------------- */

await check("@langchain/core", "real BaseCallbackHandler is in the prototype chain", async () => {
  const { BaseCallbackHandler } = await import("@langchain/core/callbacks/base");
  const HandlerClass = await getCallbackHandlerClass();
  assert.ok(
    new HandlerClass() instanceof BaseCallbackHandler,
    "getCallbackHandlerClass() fell back to the duck-typed class — `instanceof " +
      "BaseCallbackHandler` checks in user code will now fail",
  );
});

/* -------------------------------------------------------------------- */
/*  ai (Vercel AI SDK) — MHQ-758 regression guard                        */
/* -------------------------------------------------------------------- */

await check("ai", "wrapped functions still exist on the real module", async () => {
  const mod = (await import("ai")) as unknown as Record<string, unknown>;
  for (const fn of ["streamText", "generateText", "generateObject"]) {
    assert.equal(typeof mod[fn], "function", `ai.${fn} is missing — the adapter wraps it`);
  }
});

await check("ai", "createTracedVercelAI returns real traced replacements", async () => {
  const mod = (await import("ai")) as unknown as Record<string, unknown>;
  const traced = await createTracedVercelAI();
  assert.equal(typeof traced.generateText, "function");
  assert.notEqual(
    traced.generateText,
    mod.generateText,
    "traced.generateText IS the original — the adapter is a pass-through emitting nothing",
  );
});

/* -------------------------------------------------------------------- */
/*  @anthropic-ai/sdk — the low-level Messages adapter                   */
/* -------------------------------------------------------------------- */

await check(
  "@anthropic-ai/sdk",
  "a Messages class with prototype.create is reachable",
  async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as Record<string, unknown>;
    const Default = mod.default as Record<string, unknown> | undefined;

    // Same three strategies as findMessagesPrototypeCarrier() in
    // src/anthropic/index.ts. If none hit, auto-detect's prototype patch
    // silently does nothing and only explicitly-wrapped clients emit spans.
    const candidates = [
      (mod.Anthropic as Record<string, unknown> | undefined)?.Messages,
      Default?.Messages,
      mod.Messages,
      (Default as { resources?: { Messages?: unknown } } | undefined)?.resources?.Messages,
    ];
    const found = candidates.some(
      (c) =>
        typeof c === "function" &&
        typeof (c as { prototype?: { create?: unknown } }).prototype?.create === "function",
    );
    assert.ok(found, "no Messages class with prototype.create — the global patch path is dead");
  },
);

/* -------------------------------------------------------------------- */
/*  openai — the low-level chat.completions adapter                      */
/* -------------------------------------------------------------------- */

await check(
  "openai",
  "client.chat.completions.create is the shape the adapter proxies",
  async () => {
    const mod = (await import("openai")) as unknown as { default?: new (o: unknown) => unknown };
    const OpenAI = (mod.default ?? mod) as new (o: unknown) => {
      chat?: { completions?: { create?: unknown } };
    };
    // Constructed with a dummy key — no network, no request is ever made.
    const client = new OpenAI({ apiKey: "contract-check-not-a-real-key" }); // pragma: allowlist secret
    assert.equal(
      typeof client.chat?.completions?.create,
      "function",
      "client.chat.completions.create is gone — wrapOpenAI() proxies exactly this path",
    );
  },
);

/* -------------------------------------------------------------------- */
/*  @anthropic-ai/claude-agent-sdk                                       */
/* -------------------------------------------------------------------- */

await check("@anthropic-ai/claude-agent-sdk", "top-level query entry point exists", async () => {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as Record<
    string,
    unknown
  >;
  assert.equal(typeof mod.query, "function", "the `query` export is gone");
});

await check("@anthropic-ai/claude-agent-sdk", "instance path wraps a client-shaped object", () => {
  const client = { query: () => (async function* () {})() };
  assert.equal(isClaudeAgentSDKWrapped(wrapClaudeAgentSDK(client)), true);
});

// MHQ-936 closed the knownGap that used to live here. It asserted the package
// exported `ClaudeSDKClient` — it never did, at any version, because that is
// the Python package's API. Rather than wait for an export that was never
// coming, the adapter was rebuilt around `query`, so the contract is now a
// hard check on what the package actually has.
await check(
  "@anthropic-ai/claude-agent-sdk",
  "wrapClaudeAgentQuery binds to the real query",
  async () => {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
      query: (p: { prompt: unknown; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
    };
    const traced = wrapClaudeAgentQuery(mod.query as never);

    assert.notEqual(
      traced,
      mod.query,
      "wrapClaudeAgentQuery returned the original — nothing traced",
    );
    assert.equal(isClaudeAgentQueryWrapped(traced), true, "wrapped marker missing");
    assert.equal(
      isClaudeAgentQueryWrapped(mod.query),
      false,
      "the real export was mutated — it is read-only and must never be assigned to",
    );
  },
);

/* -------------------------------------------------------------------- */
/*  Report                                                               */
/* -------------------------------------------------------------------- */

const versions = Object.fromEntries(
  await Promise.all(
    [
      "@openai/agents",
      "@langchain/core",
      "ai",
      "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/sdk",
      "openai",
    ].map(async (p) => [p, await version(p)] as const),
  ),
);

console.log(`\nAgent-SDK contract check${ONLY ? ` — only ${ONLY}` : ""}\n`);
for (const [pkg, v] of Object.entries(versions)) {
  console.log(`  ${pkg}@${v}${ONLY && pkg === ONLY ? "   <-- under test" : ""}`);
}
console.log("");

const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" } as const;
for (const r of results) {
  if (r.status === "skip") continue; // summarised below, not worth a line each
  console.log(`  [${icon[r.status]}] ${r.pkg} — ${r.name}`);
  if (r.detail) console.log(`         ${r.detail}`);
}

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");
const skipped = results.filter((r) => r.status === "skip");
const passed = results.filter((r) => r.status === "pass");

console.log(
  `\n${passed.length} passed, ${warned.length} known gap(s), ${failed.length} failed` +
    (skipped.length ? `, ${skipped.length} skipped (CONTRACT_ONLY=${ONLY})` : "") +
    "\n",
);

// A filtered run that asserted nothing is a broken lane, not a green one —
// most likely CONTRACT_ONLY names a package with no assertions (typo, or a
// framework that was renamed). Fail loudly rather than reporting "0 failed".
if (ONLY && passed.length + warned.length + failed.length === 0) {
  console.error(
    `CONTRACT_ONLY=${ONLY} matched no assertions. Check the spelling against the\n` +
      `package names in this file — a lane that runs nothing must not report success.\n`,
  );
  process.exit(1);
}

if (failed.length > 0) {
  console.error(
    "A structural assumption an adapter depends on no longer holds in the installed\n" +
      "version. Fix the adapter or move the supported floor — do not delete the assertion.\n",
  );
  process.exit(1);
}
