/**
 * Agent-name resolution + process service-name capture (MHQ-1100).
 *
 * Morse ingest treats a real OTel `service.name` as the agent name, so the
 * SDK must never let an environment-derived `service.name`
 * (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`) reach the resource as
 * identity. The agent name travels as the root-span attribute `morse.agent`;
 * the process name is preserved as `morse.process.service_name`.
 *
 * Mirror of the Python SDK's resolver. Tiers, first non-empty wins:
 *   1. explicit name from customer code
 *   2. framework-native name the integration knows
 *   3. env service name (`OTEL_SERVICE_NAME` / `service.name` in
 *      `OTEL_RESOURCE_ATTRIBUTES`)
 *   4. entry-script basename without extension (`process.argv[1]`), skipping
 *      generic names
 *   5. `"default-agent"`
 *
 * Hardcoded placeholder defaults inside integrations count as NOT explicit:
 * integrations pass `undefined` for the explicit tier in that case.
 */

export const DEFAULT_AGENT_NAME = "default-agent";

// AID-01: also framework launcher scripts (Next.js `start-server`), which name no app.
const GENERIC_SCRIPT_NAMES: ReadonlySet<string> = new Set([
  "node",
  "index",
  "main",
  "server",
  "start-server",
  "next",
  "next-server",
  "ts-node",
  "tsx",
]);

/**
 * AID-02/AID-03: names frameworks give their own plumbing. Never an agent identity,
 * and adapters record these as chain spans, not agent spans. Mirrors the API denylist
 * (`apps/api/apps/agents/framework_nodes.py`).
 */
const FRAMEWORK_NODE_NAMES: ReadonlySet<string> = new Set([
  "chain",
  "__start__",
  "__end__",
  "tools",
  "agent",
  "route",
  "model",
  "langgraph",
  "langchain",
  "runnablesequence",
  "runnablelambda",
  "runnableparallel",
  "runnablepassthrough",
  "chatprompttemplate",
  "prompttemplate",
  "stroutputparser",
  "jsonoutputparser",
  "toolnode",
]);

export function isFrameworkNodeName(name: unknown): boolean {
  const n = clean(name);
  if (!n) return false;
  const bare = n.replace(/\s*\[(langchain|langgraph)\]\s*$/i, "").toLowerCase();
  return FRAMEWORK_NODE_NAMES.has(bare) || /^\[(langchain|langgraph)\]$/i.test(n);
}

/** `MORSE_AGENT_IDENTITY=legacy` restores pre-0.8 naming (AID-09). Read per call. */
export function isLegacyIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return clean(env?.MORSE_AGENT_IDENTITY)?.toLowerCase() === "legacy";
}

export type IdentitySource = "run" | "framework" | "service_name" | "entry_script" | "default";

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `service.name` from `OTEL_SERVICE_NAME`, else `OTEL_RESOURCE_ATTRIBUTES`. */
export function readEnvServiceName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = clean(env.OTEL_SERVICE_NAME);
  if (direct) return direct;
  const attrs = clean(env.OTEL_RESOURCE_ATTRIBUTES);
  if (!attrs) return undefined;
  for (const pair of attrs.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== "service.name") continue;
    let v = pair.slice(eq + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep raw value
    }
    const c = clean(v);
    if (c) return c;
  }
  return undefined;
}

/** Entry script basename without extension, or undefined if generic/empty. */
export function entryScriptName(argv: readonly string[] = process.argv): string | undefined {
  const script = clean(argv[1]);
  if (!script) return undefined;
  const base = script.split(/[\\/]/).pop() ?? "";
  const name = clean(base.replace(/\.[^./\\]+$/, ""));
  if (!name || GENERIC_SCRIPT_NAMES.has(name.toLowerCase())) return undefined;
  return name;
}

export interface ResolveAgentNameOptions {
  /** Name passed by customer code. */
  explicit?: string | null;
  /** Name a framework integration natively knows (graph name, agent name). */
  framework?: string | null;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}

/** The ladder with the rung that won, so unnamed agents can be flagged (AID-01). */
export function resolveAgentIdentity(opts: ResolveAgentNameOptions = {}): {
  name: string;
  source: IdentitySource;
} {
  const explicit = clean(opts.explicit);
  if (explicit) return { name: explicit, source: "run" };
  const framework = clean(opts.framework);
  if (framework) return { name: framework, source: "framework" };
  const service = readEnvServiceName(opts.env);
  if (service) return { name: service, source: "service_name" };
  const script = entryScriptName(opts.argv);
  if (script) return { name: script, source: "entry_script" };
  return { name: DEFAULT_AGENT_NAME, source: "default" };
}

export function resolveAgentName(opts: ResolveAgentNameOptions = {}): string {
  return resolveAgentIdentity(opts).name;
}
