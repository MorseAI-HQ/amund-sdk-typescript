/**
 * Amund rebrand: every SDK env var is read as `AMUND_<NAME>` first and
 * falls back to the pre-rebrand `MORSE_<NAME>`. `AMUND_<NAME>` wins when both
 * are set; a blank `AMUND_<NAME>` counts as unset.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as env from "../src/_internal/env";
import { isLegacyIdentity } from "../src/_internal/agent-name";
import { revisionFromEnv } from "../src/_internal/revision";
import { propagationEnabled, setPropagateDefault } from "../src/propagation";

const NAMES = [
  "API_KEY",
  "ENDPOINT",
  "FLUSH_INTERVAL_SECONDS",
  "DISABLED",
  "SDK_DEBUG",
  "SDK_DISABLE_TELEMETRY",
  "DISABLE_AUTO_DETECT",
  "INTERNAL_SOURCE",
  "SAMPLE_RATE",
  "MAX_FIELD_BYTES",
  "MAX_QUEUE_SIZE",
  "MAX_BATCH_SIZE",
  "LEGACY_TRANSPORT",
  "CAPTURE_DB",
  "CAPTURE_HTTP",
  "CAPTURE_QUEUE",
  "CAPTURE_INFRA",
  "CAPTURE_HTTP_EXCLUDE_HOSTS",
  "CAPTURE_QUEUE_CONSUMER",
  "PROPAGATE_TRACE_CONTEXT",
  "AGENT_IDENTITY",
  "GIT_REVISION",
];

const saved: Record<string, string | undefined> = {};

function clearAll(): void {
  for (const n of NAMES) {
    delete process.env[`AMUND_${n}`];
    delete process.env[`MORSE_${n}`];
  }
}

beforeEach(() => {
  for (const n of NAMES) {
    saved[`AMUND_${n}`] = process.env[`AMUND_${n}`];
    saved[`MORSE_${n}`] = process.env[`MORSE_${n}`];
  }
  clearAll();
});

afterEach(() => {
  clearAll();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  setPropagateDefault(undefined);
});

describe("readSdkEnv precedence", () => {
  it("names AMUND_ first, MORSE_ second", () => {
    expect(env.sdkEnvNames("API_KEY")).toEqual(["AMUND_API_KEY", "MORSE_API_KEY"]);
  });

  it("returns undefined when neither is set", () => {
    expect(env.readSdkEnv("API_KEY")).toBeUndefined();
  });

  it("falls back to MORSE_ when only MORSE_ is set", () => {
    process.env.MORSE_API_KEY = "from-morse"; // pragma: allowlist secret
    expect(env.readSdkEnv("API_KEY")).toBe("from-morse");
  });

  it("reads AMUND_ when only AMUND_ is set", () => {
    process.env.AMUND_API_KEY = "from-amund"; // pragma: allowlist secret
    expect(env.readSdkEnv("API_KEY")).toBe("from-amund");
  });

  it("AMUND_ wins when both are set", () => {
    process.env.AMUND_API_KEY = "from-amund"; // pragma: allowlist secret
    process.env.MORSE_API_KEY = "from-morse"; // pragma: allowlist secret
    expect(env.readSdkEnv("API_KEY")).toBe("from-amund");
  });

  it("a blank AMUND_ counts as unset and falls through to MORSE_", () => {
    process.env.AMUND_API_KEY = "   "; // pragma: allowlist secret
    process.env.MORSE_API_KEY = "from-morse"; // pragma: allowlist secret
    expect(env.readSdkEnv("API_KEY")).toBe("from-morse");
  });

  it("readSdkEnvFrom applies the same rule to an explicit env object", () => {
    expect(env.readSdkEnvFrom({ MORSE_X: "m" }, "X")).toBe("m");
    expect(env.readSdkEnvFrom({ AMUND_X: "a", MORSE_X: "m" }, "X")).toBe("a");
    expect(env.readSdkEnvFrom({ AMUND_X: "", MORSE_X: "m" }, "X")).toBe("m");
    expect(env.readSdkEnvFrom({}, "X")).toBeUndefined();
    expect(env.readSdkEnvFrom(undefined, "X")).toBeUndefined();
  });
});

describe("every env getter honours both prefixes", () => {
  type Case = {
    name: string;
    read: () => unknown;
    amund: string;
    morse: string;
    expectAmund: unknown;
    expectMorse: unknown;
  };
  const cases: Case[] = [
    {
      name: "API_KEY",
      read: env.getApiKey,
      amund: "a",
      morse: "m",
      expectAmund: "a",
      expectMorse: "m",
    },
    {
      name: "ENDPOINT",
      read: env.getEndpoint,
      amund: "https://a.example",
      morse: "https://m.example",
      expectAmund: "https://a.example",
      expectMorse: "https://m.example",
    },
    {
      name: "FLUSH_INTERVAL_SECONDS",
      read: () => env.getFlushIntervalSeconds(),
      amund: "5",
      morse: "7",
      expectAmund: 5,
      expectMorse: 7,
    },
    {
      name: "DISABLED",
      read: env.isDisabled,
      amund: "1",
      morse: "1",
      expectAmund: true,
      expectMorse: true,
    },
    {
      name: "SDK_DEBUG",
      read: env.isDebug,
      amund: "true",
      morse: "true",
      expectAmund: true,
      expectMorse: true,
    },
    {
      name: "SDK_DISABLE_TELEMETRY",
      read: env.isTelemetryDisabled,
      amund: "1",
      morse: "1",
      expectAmund: true,
      expectMorse: true,
    },
    {
      name: "DISABLE_AUTO_DETECT",
      read: env.isAutoDetectDisabled,
      amund: "1",
      morse: "1",
      expectAmund: true,
      expectMorse: true,
    },
    {
      name: "INTERNAL_SOURCE",
      read: env.getInternalSource,
      amund: "copilot",
      morse: "investigator",
      expectAmund: "copilot",
      expectMorse: "investigator",
    },
    {
      name: "SAMPLE_RATE",
      read: () => env.getSampleRate(),
      amund: "0.25",
      morse: "0.5",
      expectAmund: 0.25,
      expectMorse: 0.5,
    },
    {
      name: "MAX_FIELD_BYTES",
      read: () => env.getMaxFieldBytes(),
      amund: "100",
      morse: "200",
      expectAmund: 100,
      expectMorse: 200,
    },
    {
      name: "MAX_QUEUE_SIZE",
      read: () => env.getMaxQueueSize(),
      amund: "10",
      morse: "20",
      expectAmund: 10,
      expectMorse: 20,
    },
    {
      name: "MAX_BATCH_SIZE",
      read: () => env.getMaxBatchSize(),
      amund: "3",
      morse: "4",
      expectAmund: 3,
      expectMorse: 4,
    },
    {
      name: "LEGACY_TRANSPORT",
      read: env.isLegacyTransport,
      amund: "1",
      morse: "1",
      expectAmund: true,
      expectMorse: true,
    },
    {
      name: "CAPTURE_DB",
      read: env.isDbCaptureEnabled,
      amund: "0",
      morse: "0",
      expectAmund: false,
      expectMorse: false,
    },
    {
      name: "CAPTURE_QUEUE_CONSUMER",
      read: env.isQueueConsumerEnabled,
      amund: "1",
      morse: "1",
      expectAmund: true,
      expectMorse: true,
    },
    {
      name: "CAPTURE_HTTP_EXCLUDE_HOSTS",
      read: env.getHttpExcludeHosts,
      amund: "a.com",
      morse: "m.com",
      expectAmund: ["a.com"],
      expectMorse: ["m.com"],
    },
    {
      name: "GIT_REVISION",
      read: revisionFromEnv,
      amund: "aaa111",
      morse: "mmm222",
      expectAmund: "aaa111",
      expectMorse: "mmm222",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: MORSE_ fallback, AMUND_ alone, AMUND_ wins`, () => {
      process.env[`MORSE_${c.name}`] = c.morse;
      expect(c.read()).toEqual(c.expectMorse);
      delete process.env[`MORSE_${c.name}`];

      process.env[`AMUND_${c.name}`] = c.amund;
      expect(c.read()).toEqual(c.expectAmund);

      process.env[`MORSE_${c.name}`] = c.morse;
      expect(c.read()).toEqual(c.expectAmund);
    });
  }

  it("CAPTURE_*: AMUND_ opt-out beats a MORSE_ opt-in, and vice versa", () => {
    process.env.AMUND_CAPTURE_HTTP = "0";
    process.env.MORSE_CAPTURE_HTTP = "1";
    expect(env.isCaptureEnabled("CAPTURE_HTTP")).toBe(false);

    process.env.AMUND_CAPTURE_HTTP = "1";
    process.env.MORSE_CAPTURE_HTTP = "0";
    expect(env.isCaptureEnabled("CAPTURE_HTTP")).toBe(true);
  });

  it("CAPTURE_INFRA: MORSE_ umbrella still applies; a specific AMUND_ flag still wins", () => {
    process.env.MORSE_CAPTURE_INFRA = "0";
    expect(env.isCaptureEnabled("CAPTURE_QUEUE")).toBe(false);
    process.env.AMUND_CAPTURE_QUEUE = "1";
    expect(env.isCaptureEnabled("CAPTURE_QUEUE")).toBe(true);
    process.env.AMUND_CAPTURE_INFRA = "1";
    delete process.env.AMUND_CAPTURE_QUEUE;
    expect(env.isCaptureEnabled("CAPTURE_QUEUE")).toBe(true);
  });

  it("AGENT_IDENTITY (agent-name.ts)", () => {
    expect(isLegacyIdentity({ MORSE_AGENT_IDENTITY: "legacy" })).toBe(true);
    expect(isLegacyIdentity({ AMUND_AGENT_IDENTITY: "legacy" })).toBe(true);
    expect(isLegacyIdentity({ AMUND_AGENT_IDENTITY: "v2", MORSE_AGENT_IDENTITY: "legacy" })).toBe(
      false,
    );
    process.env.AMUND_AGENT_IDENTITY = "legacy";
    expect(isLegacyIdentity()).toBe(true);
  });

  it("PROPAGATE_TRACE_CONTEXT (propagation.ts)", () => {
    expect(propagationEnabled()).toBe(true);
    process.env.MORSE_PROPAGATE_TRACE_CONTEXT = "false";
    expect(propagationEnabled()).toBe(false);
    process.env.AMUND_PROPAGATE_TRACE_CONTEXT = "true";
    expect(propagationEnabled()).toBe(true);
    delete process.env.MORSE_PROPAGATE_TRACE_CONTEXT;
    process.env.AMUND_PROPAGATE_TRACE_CONTEXT = "off";
    expect(propagationEnabled()).toBe(false);
  });
});

describe("all env reads go through the helper", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  }

  it("no src file reads a MORSE_/AMUND_ variable directly", () => {
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, "..", "src"))) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/(?:env\??\.|env\[\s*["'`])(?:MORSE|AMUND)_/.test(code)) offenders.push(file);
      if (/["'`](?:MORSE|AMUND)_[A-Z_]+["'`]/.test(code) && !file.endsWith("env.ts")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
