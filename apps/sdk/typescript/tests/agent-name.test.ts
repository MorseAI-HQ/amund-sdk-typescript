/**
 * MHQ-1100 — agent name travels as the root-span attribute `morse.agent`;
 * an env-derived `service.name` must never reach the resource as identity.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_NAME,
  entryScriptName,
  readEnvServiceName,
  resolveAgentName,
} from "../src/_internal/agent-name";
import { getEngine } from "../src/_internal/otel-provider";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { _resetForTesting, runSync } from "../src/_internal/tracing";

describe("resolveAgentName tiers", () => {
  const noEnv = {} as NodeJS.ProcessEnv;
  const argv = ["/usr/bin/node", "/srv/app/lead-qualifier.js"];

  it("explicit beats framework, env, and script", () => {
    expect(
      resolveAgentName({
        explicit: "copilot",
        framework: "graph",
        env: { OTEL_SERVICE_NAME: "proc" },
        argv,
      }),
    ).toBe("copilot");
  });

  it("framework beats env and script", () => {
    expect(resolveAgentName({ framework: "graph", env: { OTEL_SERVICE_NAME: "proc" }, argv })).toBe(
      "graph",
    );
  });

  it("env service name beats script", () => {
    expect(resolveAgentName({ env: { OTEL_SERVICE_NAME: "proc" }, argv })).toBe("proc");
  });

  it("reads service.name from OTEL_RESOURCE_ATTRIBUTES", () => {
    expect(readEnvServiceName({ OTEL_RESOURCE_ATTRIBUTES: "a=b,service.name=svc%20x" })).toBe(
      "svc x",
    );
  });

  it("falls back to the entry script basename without extension", () => {
    expect(resolveAgentName({ env: noEnv, argv })).toBe("lead-qualifier");
  });

  it.each(["node", "index", "main", "server"])("skips generic script name %s", (n) => {
    expect(entryScriptName(["node", `/x/${n}.js`])).toBeUndefined();
  });

  it("falls to default-agent when nothing resolves", () => {
    expect(resolveAgentName({ env: noEnv, argv: ["node"] })).toBe(DEFAULT_AGENT_NAME);
    expect(DEFAULT_AGENT_NAME).toBe("default-agent");
  });

  it("treats empty and whitespace explicit names as unset", () => {
    expect(resolveAgentName({ explicit: "  ", env: { OTEL_SERVICE_NAME: "proc" }, argv })).toBe(
      "proc",
    );
  });
});

describe("root span + resource under OTEL_SERVICE_NAME", () => {
  const saved = process.env.OTEL_SERVICE_NAME;

  beforeEach(() => {
    process.env.OTEL_SERVICE_NAME = "proc";
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

  afterEach(() => {
    if (saved === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = saved;
    getEngine().resetForTesting();
    _resetForTesting();
  });

  async function rootSpanFor(opts: { agentName?: string }) {
    const engine = getEngine();
    runSync(opts, () => undefined);
    await engine.flush();
    const spans = engine.recorder!.spans;
    expect(spans.length).toBeGreaterThan(0);
    return spans[spans.length - 1]!;
  }

  it("explicit name wins; resource drops env service.name, keeps morse.process.service_name", async () => {
    const root = await rootSpanFor({ agentName: "copilot" });
    expect(root.attributes["morse.agent"]).toBe("copilot");
    expect(root.resource.attributes["service.name"]).toBeUndefined();
    expect(root.resource.attributes["morse.process.service_name"]).toBe("proc");
  });

  it("with no explicit name the env service name resolves the agent", async () => {
    const root = await rootSpanFor({});
    expect(root.attributes["morse.agent"]).toBe("proc");
  });
});
