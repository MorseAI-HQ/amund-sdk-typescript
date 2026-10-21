/**
 * agent-identity-v2 (MHQ-1408), TypeScript SDK: identity ladder, framework nodes as
 * chain spans, run() as a label over the discovered root, legacy opt-out.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_NAME,
  isFrameworkNodeName,
  resolveAgentIdentity,
} from "../src/_internal/agent-name";
import { getEngine } from "../src/_internal/otel-provider";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { _resetForTesting, getLastTrace, runAsync, runSync } from "../src/_internal/tracing";
import { MorseCallbackHandler as LangGraphHandler } from "../src/langgraph";
import { MorseCallbackHandler as LangChainHandler } from "../src/langchain/callback-handler";
import { MorseTraceProcessor } from "../src/openai-agents/trace-processor";

interface WireSpan {
  span_id: string;
  parent_span_id?: string;
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
}

const spans = (): WireSpan[] => (getLastTrace()?.spans ?? []) as unknown as WireSpan[];
const traceDict = (): Record<string, unknown> =>
  (getLastTrace()?.trace ?? {}) as Record<string, unknown>;
const meta = (): Record<string, unknown> => (traceDict().metadata ?? {}) as Record<string, unknown>;

beforeEach(() => {
  _resetForTesting();
  delete process.env.MORSE_AGENT_IDENTITY;
});
afterEach(() => {
  delete process.env.MORSE_AGENT_IDENTITY;
  _resetForTesting();
});

describe("identity ladder", () => {
  const argv = ["node", "/srv/app/drv.mjs"];

  it("AID-01: run name > framework > service.name > entry script", () => {
    // @spec: AID-01
    const env = { OTEL_SERVICE_NAME: "svc" } as NodeJS.ProcessEnv;
    expect(resolveAgentIdentity({ explicit: "a", framework: "f", env, argv })).toEqual({
      name: "a",
      source: "run",
    });
    expect(resolveAgentIdentity({ framework: "f", env, argv })).toEqual({
      name: "f",
      source: "framework",
    });
    expect(resolveAgentIdentity({ env, argv })).toEqual({ name: "svc", source: "service_name" });
    expect(resolveAgentIdentity({ env: {}, argv })).toEqual({
      name: "drv",
      source: "entry_script",
    });
  });

  it("AID-01: Next.js launcher `start-server` is not an identity", () => {
    // @spec: AID-01
    expect(
      resolveAgentIdentity({ env: {}, argv: ["node", "/x/.next/server/start-server.js"] }),
    ).toEqual({ name: DEFAULT_AGENT_NAME, source: "default" });
  });

  it("AID-01: a bare script run carries identity_source=entry_script on the trace", () => {
    // @spec: AID-01
    const prev = process.argv[1];
    process.argv[1] = "/srv/app/lead-qualifier.js";
    try {
      runSync({}, () => undefined);
    } finally {
      process.argv[1] = prev!;
    }
    expect(traceDict().agent).toBe("lead-qualifier");
    expect(meta()).toEqual({ identity_source: "entry_script" });
  });

  it("MHQ-1415: run({ name }) names the agent like run({ agentName })", () => {
    // @spec: AID-01
    runSync({ name: "ts-core" }, () => undefined);
    expect(traceDict().agent).toBe("ts-core");
    expect(meta().identity_source).toBe("run");
  });

  it("AID-02: framework plumbing names are recognised, real names are not", () => {
    // @spec: AID-02
    for (const n of ["__start__", "tools", "RunnableSequence", "LangGraph", "agent [langgraph]"]) {
      expect(isFrameworkNodeName(n), n).toBe(true);
    }
    for (const n of ["research-assistant", "Triage Agent", "analyst_3"]) {
      expect(isFrameworkNodeName(n), n).toBe(false);
    }
  });
});

describe("LangGraph handler", () => {
  it("AID-01: compiled graph name becomes the root agent, replacing the entry script", async () => {
    // @spec: AID-01
    await runAsync({}, async () => {
      const h = new LangGraphHandler();
      h.handleChainStart(
        { name: "x" },
        {},
        "r0",
        undefined,
        undefined,
        {},
        undefined,
        "research-assistant",
      );
      h.handleChainEnd({}, "r0");
    });
    expect(traceDict().agent).toBe("research-assistant");
    expect(meta().identity_source).toBe("framework");
    expect(spans()[0]!.name).toBe("research-assistant");
  });

  it("AID-04: run('airline-support') keeps the discovered root and records morse_app", async () => {
    // @spec: AID-04
    await runAsync({ agentName: "airline-support" }, async () => {
      const h = new LangGraphHandler();
      h.handleChainStart(
        { name: "x" },
        {},
        "r0",
        undefined,
        undefined,
        {},
        undefined,
        "Triage Agent",
      );
      h.handleChainEnd({}, "r0");
    });
    expect(traceDict().agent).toBe("Triage Agent");
    expect(meta()).toEqual({ identity_source: "framework", morse_app: "airline-support" });
    expect(spans().filter((s) => s.type === "agent" && s.name === "airline-support")).toHaveLength(
      0,
    );
  });

  it("AID-04: generic graph names (`LangGraph`) never replace the run name", async () => {
    // @spec: AID-04
    await runAsync({ agentName: "my-app" }, async () => {
      const h = new LangGraphHandler();
      h.handleChainStart(
        { name: "LangGraph" },
        {},
        "r0",
        undefined,
        undefined,
        {},
        undefined,
        "LangGraph",
      );
      h.handleChainEnd({}, "r0");
    });
    expect(traceDict().agent).toBe("my-app");
    expect(meta()).toEqual({ identity_source: "run" });
  });

  it("AID-02/AID-05: 14-analyst fan-out has one agent span; llm parents are their own analyst", async () => {
    // @spec: AID-02, AID-05
    await runAsync({ agentName: "hedge-fund" }, async () => {
      const h = new LangGraphHandler();
      h.handleChainStart(
        { name: "g" },
        {},
        "root",
        undefined,
        undefined,
        {},
        undefined,
        "hedge-fund",
      );
      // all analysts start before any LLM call (parallel branches interleave)
      for (let i = 0; i < 14; i++) {
        h.handleChainStart(
          { name: "n" },
          {},
          `a${i}`,
          "root",
          undefined,
          {},
          undefined,
          `analyst_${i}`,
        );
      }
      for (let i = 0; i < 14; i++) {
        h.handleChatModelStart!({ id: ["x"], name: "m" }, [[]], `l${i}`, `a${i}`, {
          invocation_params: { model: "gpt-4o-mini" },
        });
        h.handleLLMEnd!({ generations: [] }, `l${i}`);
      }
      for (let i = 0; i < 14; i++) h.handleChainEnd({}, `a${i}`);
      h.handleChainEnd({}, "root");
    });
    const all = spans();
    expect(all.filter((s) => s.type === "agent").length).toBeLessThanOrEqual(15);
    const byName = new Map(all.map((s) => [s.name, s]));
    const llms = all.filter((s) => s.type === "llm");
    expect(llms).toHaveLength(14);
    for (const llm of llms) {
      const parent = all.find((s) => s.span_id === llm.parent_span_id)!;
      expect(parent.name).toMatch(/^analyst_\d+$/);
      expect(parent.metadata?.span_kind).toBe("chain");
    }
    expect(byName.get("analyst_3")!.parent_span_id).toBe(byName.get("hedge-fund")!.span_id);
  });

  it("AID-09: MORSE_AGENT_IDENTITY=legacy restores agent spans and the run name", async () => {
    // @spec: AID-09
    process.env.MORSE_AGENT_IDENTITY = "legacy";
    await runAsync({ agentName: "airline-support" }, async () => {
      const h = new LangGraphHandler();
      h.handleChainStart(
        { name: "x" },
        {},
        "r0",
        undefined,
        undefined,
        {},
        undefined,
        "Triage Agent",
      );
      h.handleChainEnd({}, "r0");
    });
    expect(traceDict().agent).toBe("airline-support");
    expect(traceDict().metadata).toBeUndefined();
    expect(spans().some((s) => s.type === "agent" && s.name === "langgraph-js.agent")).toBe(true);
  });
});

describe("LangChain handler", () => {
  it("AID-02/AID-05: LCEL chain nests prompt > model under the chain span, none are agents", async () => {
    // @spec: AID-02, AID-05
    await runAsync({ agentName: "app" }, async () => {
      const h = new LangChainHandler();
      h.handleChainStart({ id: ["a", "RunnableSequence"] }, {}, "seq");
      h.handleChainStart({ id: ["a", "ChatPromptTemplate"] }, {}, "p", "seq");
      h.handleChainEnd({}, "p");
      h.handleChatModelStart!({ id: ["a", "ChatOpenAI"] }, [[]], "m", "seq", {});
      h.handleLLMEnd!({ generations: [] }, "m");
      h.handleChainEnd({}, "seq");
    });
    const all = spans();
    expect(all.filter((s) => s.type === "agent")).toHaveLength(1); // the root only
    const seq = all.find((s) => s.name === "RunnableSequence")!;
    expect(seq.metadata?.span_kind).toBe("chain");
    expect(all.find((s) => s.type === "llm")!.parent_span_id).toBe(seq.span_id);
    expect(all.find((s) => s.name === "ChatPromptTemplate")!.parent_span_id).toBe(seq.span_id);
    expect(traceDict().agent).toBe("app"); // RunnableSequence is plumbing, not a root
  });
});

describe("openai-agents processor", () => {
  const sp = (id: string, type: string, name?: string, parentId?: string, rest = {}) => ({
    spanId: id,
    parentId,
    spanData: { type, name, ...rest },
  });

  it("AID-02/AID-05: task/turn are chain spans, the starting agent is not a second agent", async () => {
    // @spec: AID-02, AID-05
    await runAsync({ agentName: "airline-support" }, async () => {
      const p = new MorseTraceProcessor();
      const events = [
        sp("t", "task", "Agent workflow"),
        sp("a", "agent", "Triage Agent", "t"),
        sp("u", "turn", "anon", "a"),
        sp("f", "function", "lookup", "u"),
      ];
      for (const e of events) p.onSpanStart(e);
      for (const e of [...events].reverse()) p.onSpanEnd(e);
    });
    const all = spans();
    expect(all.filter((s) => s.type === "tool" && /^(task|turn)\./.test(s.name))).toHaveLength(0);
    expect(all.filter((s) => s.type === "agent").map((s) => s.name)).toEqual(["Triage Agent"]);
    expect(traceDict().agent).toBe("Triage Agent");
    expect(meta().morse_app).toBe("airline-support");
    const turn = all.find((s) => s.name === "turn")!;
    const tool = all.find((s) => s.type === "tool")!;
    expect(turn.metadata?.span_kind).toBe("chain");
    expect(tool.parent_span_id).toBe(turn.span_id);
  });

  it("AID-02: a handoff target is the sub-agent span, not a duplicate agent span", async () => {
    // @spec: AID-02
    await runAsync({ agentName: "app" }, async () => {
      const p = new MorseTraceProcessor();
      const a = sp("a", "agent", "Triage");
      const h = sp("h", "handoff", undefined, "a", { from_agent: "Triage", to_agent: "Billing" });
      const b = sp("b", "agent", "Billing", "a");
      p.onSpanStart(a);
      p.onSpanStart(h);
      p.onSpanEnd(h);
      p.onSpanStart(b);
      p.onSpanEnd(b);
      p.onSpanEnd(a);
    });
    const agentTyped = spans().filter((s) => s.type === "agent");
    expect(agentTyped.map((s) => s.name).sort()).toEqual([
      "Triage",
      "openai-agents.subagent.Billing",
    ]);
  });
});

describe("OTLP wire", () => {
  beforeEach(() => {
    getEngine().configure({
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
  });
  afterEach(() => getEngine().resetForTesting());

  it("AID-04/AID-01: root span carries morse.app and morse.identity_source", async () => {
    // @spec: AID-04, AID-01
    await runAsync({ agentName: "airline-support" }, async () => {
      const h = new LangGraphHandler();
      h.handleChainStart(
        { name: "x" },
        {},
        "r0",
        undefined,
        undefined,
        {},
        undefined,
        "Triage Agent",
      );
      h.handleChainEnd({}, "r0");
    });
    await getEngine().flush();
    const recorded = getEngine().recorder!.spans;
    const root = recorded.find((s) => s.attributes["morse.agent"] !== undefined)!;
    expect(root.attributes["morse.agent"]).toBe("Triage Agent");
    expect(root.attributes["morse.app"]).toBe("airline-support");
    expect(root.attributes["morse.identity_source"]).toBe("framework");
  });
});
