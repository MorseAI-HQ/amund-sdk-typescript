/**
 * Phase 12.5 Tier 1.2 stretch — pino destination tests.
 *
 * Covers:
 *   - Pino-numeric-level → Morse-severity mapping.
 *   - Multi-line NDJSON write (the way pino actually writes).
 *   - `msg` field becomes log body, other fields become attributes,
 *     pino-internal fields (pid/hostname/time/v/level) are dropped.
 *   - Malformed NDJSON is silently dropped, not thrown.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as morse from "../src/index";
import { BatchTransport, type LogRecordPayload } from "../src/_internal/transport";
import { morsePinoDestination, forwardPinoRecord } from "../src/integrations/pino";

const ENV_KEYS = ["MORSE_API_KEY", "MORSE_ENDPOINT", "MORSE_DISABLED"];

function installCapturingTransport(): { events: unknown[] } {
  const events: unknown[] = [];
  morse._setTransportFactoryForTesting((): BatchTransport => {
    return {
      track(event: unknown): boolean {
        events.push(event);
        return true;
      },
      flush(): Promise<void> {
        return Promise.resolve();
      },
      shutdown(): Promise<void> {
        return Promise.resolve();
      },
    } as unknown as BatchTransport;
  });
  return { events };
}

beforeEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("forwardPinoRecord — direct record forwarding", () => {
  it("maps pino numeric levels to severity strings", () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    forwardPinoRecord({ level: 10, msg: "tr" });
    forwardPinoRecord({ level: 20, msg: "db" });
    forwardPinoRecord({ level: 30, msg: "in" });
    forwardPinoRecord({ level: 40, msg: "wn" });
    forwardPinoRecord({ level: 50, msg: "er" });
    forwardPinoRecord({ level: 60, msg: "fa" });

    const severities = events
      .map((e) => {
        if (e && typeof e === "object" && "logs" in e) {
          return (e as { logs: LogRecordPayload[] }).logs[0]?.severity;
        }
        return undefined;
      })
      .filter(Boolean);
    expect(severities).toEqual(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);
  });

  it("drops pino-internal fields and forwards the rest as attributes", () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    forwardPinoRecord({
      level: 30,
      time: 1700000000000,
      pid: 4242,
      hostname: "host-1",
      v: 1,
      msg: "search done",
      user_id: 7,
      query: "morse",
    });

    const log = (events[0] as { logs: LogRecordPayload[] }).logs[0]!;
    expect(log.body).toBe("search done");
    expect(log.severity).toBe("INFO");
    // pid / hostname / time / v / level / msg must be absent.
    expect(log.attributes).toEqual({ user_id: 7, query: "morse" });
  });

  it("uses pino `name` as service_name when present", () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    forwardPinoRecord({ level: 30, msg: "hi", name: "billing-worker" });

    const log = (events[0] as { logs: LogRecordPayload[] }).logs[0]!;
    expect(log.service_name).toBe("billing-worker");
  });
});

describe("morsePinoDestination — writable stream", () => {
  it("parses one NDJSON line per record and forwards each", async () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    const dest = morsePinoDestination();
    dest.write(JSON.stringify({ level: 30, msg: "first", a: 1 }) + "\n");
    dest.write(JSON.stringify({ level: 50, msg: "second", err: "boom" }) + "\n");
    await new Promise<void>((resolve) => dest.end(() => resolve()));

    expect(events).toHaveLength(2);
    const first = (events[0] as { logs: LogRecordPayload[] }).logs[0]!;
    const second = (events[1] as { logs: LogRecordPayload[] }).logs[0]!;
    expect(first.body).toBe("first");
    expect(first.severity).toBe("INFO");
    expect(first.attributes).toEqual({ a: 1 });
    expect(second.body).toBe("second");
    expect(second.severity).toBe("ERROR");
    expect(second.attributes).toEqual({ err: "boom" });
  });

  it("handles split writes (record spread across multiple chunks)", async () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    const dest = morsePinoDestination();
    const record = JSON.stringify({ level: 30, msg: "split-line", k: "v" });
    dest.write(record.slice(0, 5));
    dest.write(record.slice(5) + "\n");
    await new Promise<void>((resolve) => dest.end(() => resolve()));

    expect(events).toHaveLength(1);
    const rec = (events[0] as { logs: LogRecordPayload[] }).logs[0]!;
    expect(rec.body).toBe("split-line");
    expect(rec.attributes).toEqual({ k: "v" });
  });

  it("silently drops malformed JSON lines", async () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    const dest = morsePinoDestination();
    dest.write("not json\n");
    dest.write(JSON.stringify({ level: 30, msg: "valid" }) + "\n");
    dest.write("{still not}\n");
    await new Promise<void>((resolve) => dest.end(() => resolve()));

    expect(events).toHaveLength(1);
    const rec = (events[0] as { logs: LogRecordPayload[] }).logs[0]!;
    expect(rec.body).toBe("valid");
  });

  it("flushes a trailing record with no newline on final()", async () => {
    const { events } = installCapturingTransport();
    morse.init({ apiKey: "av_x", endpoint: "https://x.test/api/v1/traces/batch" });

    const dest = morsePinoDestination();
    dest.write(JSON.stringify({ level: 30, msg: "trailing" }));
    await new Promise<void>((resolve) => dest.end(() => resolve()));

    expect(events).toHaveLength(1);
    const rec = (events[0] as { logs: LogRecordPayload[] }).logs[0]!;
    expect(rec.body).toBe("trailing");
  });
});
