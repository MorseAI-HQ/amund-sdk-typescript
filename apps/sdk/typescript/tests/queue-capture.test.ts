/**
 * INFRACAP-07/08 — BullMQ and SQS queue spans.
 *
 * The libraries are stood in by minimal fakes that have the shape the patch
 * relies on (`Queue.prototype.add/addBulk`, `SQSClient.prototype.send` with
 * command classes named like aws-sdk's). They are NOT the real packages: see
 * the PR report for what that does and does not prove.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  BullMqInstrumentation,
  SqsInstrumentation,
  continueFromBullMqJob,
  continueFromSqsMessage,
  patchBullMqQueue,
  patchSqsClient,
} from "../src/_internal/queue-capture";
import type { SpanData } from "../src/_internal/spans";
import { getActiveTraceState, runAsync, type TraceState } from "../src/_internal/tracing";

/* eslint-disable @typescript-eslint/no-explicit-any */

const undo: Array<() => void> = [];

afterEach(() => {
  while (undo.length) undo.pop()!();
  for (const k of ["MORSE_CAPTURE_QUEUE", "MORSE_CAPTURE_INFRA", "MORSE_CAPTURE_QUEUE_CONSUMER"]) {
    delete process.env[k];
  }
});

class FakeQueue {
  name = "agent-jobs";
  calls: any[] = [];
  fail = false;
  async add(name: string, data: unknown, opts?: any) {
    this.calls.push({ name, data, opts });
    if (this.fail) throw new Error("redis down");
    return { id: "1" };
  }
  async addBulk(jobs: any[]) {
    this.calls.push({ jobs });
    return jobs.map((_, i) => ({ id: String(i) }));
  }
}

class SendMessageCommand {
  constructor(public input: any) {}
}
class SendMessageBatchCommand {
  constructor(public input: any) {}
}
class ReceiveMessageCommand {
  constructor(public input: any) {}
}
class FakeSqsClient {
  sent: any[] = [];
  async send(command: any) {
    this.sent.push(command);
    return {};
  }
}

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/agent-jobs";

async function inTrace(fn: () => Promise<void>): Promise<{ spans: SpanData[]; state: TraceState }> {
  let state!: TraceState;
  await runAsync({ agentName: "queue-agent" }, async (handle) => {
    state = handle._state;
    await fn();
  });
  const spans = state.completedSpans.filter((s) => s.metadata?.["messaging.system"] !== undefined);
  return { spans, state };
}

describe("BullMQ producer", () => {
  it("records a publish span and injects traceparent into job opts", async () => {
    // @spec: INFRACAP-07
    undo.push(patchBullMqQueue(FakeQueue));
    const q = new FakeQueue();
    const { spans, state } = await inTrace(async () => {
      await q.add("work", { note: "payload-canary" });
    });
    expect(spans.map((s) => s.name)).toEqual(["publish agent-jobs"]);
    expect(spans[0]!.type).toBe("custom");
    expect(spans[0]!.metadata).toMatchObject({
      "messaging.system": "bullmq",
      "messaging.operation.type": "publish",
      "messaging.destination.name": "agent-jobs",
    });
    expect(JSON.stringify(spans)).not.toContain("payload-canary");
    expect(q.calls[0].opts.telemetry.metadata).toMatch(
      new RegExp(`^00-${state.traceId}-[0-9a-f]{16}-01$`),
    );
  });

  it("does not mutate the caller's opts and keeps an existing telemetry carrier", async () => {
    // @spec: INFRACAP-07
    undo.push(patchBullMqQueue(FakeQueue));
    const q = new FakeQueue();
    const opts = { attempts: 3, telemetry: { metadata: "their-carrier" } };
    await inTrace(async () => {
      await q.add("work", {}, opts);
    });
    expect(opts).toEqual({ attempts: 3, telemetry: { metadata: "their-carrier" } });
    expect(q.calls[0].opts.telemetry.metadata).toBe("their-carrier");
    expect(q.calls[0].opts.attempts).toBe(3);
  });

  it("addBulk injects into every job", async () => {
    // @spec: INFRACAP-07
    undo.push(patchBullMqQueue(FakeQueue));
    const q = new FakeQueue();
    const { spans } = await inTrace(async () => {
      await q.addBulk([
        { name: "a", data: {} },
        { name: "b", data: {}, opts: { delay: 5 } },
      ]);
    });
    expect(spans).toHaveLength(1);
    const sent = q.calls[0].jobs;
    expect(sent.every((j: any) => typeof j.opts.telemetry.metadata === "string")).toBe(true);
    expect(sent[1].opts.delay).toBe(5);
  });

  it("outside a trace it records nothing and passes opts through untouched", async () => {
    // @spec: INFRACAP-07
    undo.push(patchBullMqQueue(FakeQueue));
    const q = new FakeQueue();
    const opts = { attempts: 1 };
    await q.add("work", {}, opts);
    expect(q.calls[0].opts).toBe(opts);
  });

  it.each(["MORSE_CAPTURE_QUEUE", "MORSE_CAPTURE_INFRA"])("%s=0 switches it off", async (name) => {
    // @spec: INFRACAP-07
    process.env[name] = "0";
    undo.push(patchBullMqQueue(FakeQueue));
    const q = new FakeQueue();
    const { spans } = await inTrace(async () => {
      await q.add("work", {});
    });
    expect(spans).toHaveLength(0);
    expect(q.calls[0].opts).toBeUndefined();
  });

  it("a failing publish marks the span failed and still throws", async () => {
    // @spec: INFRACAP-07
    undo.push(patchBullMqQueue(FakeQueue));
    const q = new FakeQueue();
    q.fail = true;
    let thrown: unknown;
    const { spans } = await inTrace(async () => {
      await q.add("work", {}).catch((e) => {
        thrown = e;
      });
    });
    expect((thrown as Error).message).toBe("redis down");
    expect(spans[0]!.status).toBe("failed");
  });

  it("undo restores the original methods", () => {
    // @spec: INFRACAP-07
    const original = FakeQueue.prototype.add;
    const off = patchBullMqQueue(FakeQueue);
    expect(FakeQueue.prototype.add).not.toBe(original);
    off();
    expect(FakeQueue.prototype.add).toBe(original);
  });
});

describe("SQS producer", () => {
  it("records a publish span and injects a traceparent message attribute", async () => {
    // @spec: INFRACAP-07
    undo.push(patchSqsClient(FakeSqsClient));
    const client = new FakeSqsClient();
    const { spans, state } = await inTrace(async () => {
      await client.send(
        new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: "body-canary" }),
      );
    });
    expect(spans[0]!.name).toBe("publish agent-jobs");
    expect(spans[0]!.metadata!["messaging.system"]).toBe("aws_sqs");
    expect(JSON.stringify(spans)).not.toContain("body-canary");
    const attr = client.sent[0].input.MessageAttributes.traceparent;
    expect(attr.DataType).toBe("String");
    expect(attr.StringValue).toMatch(new RegExp(`^00-${state.traceId}-`));
  });

  it("batch injects each entry; a full attribute set is left alone", async () => {
    // @spec: INFRACAP-07
    undo.push(patchSqsClient(FakeSqsClient));
    const client = new FakeSqsClient();
    const full = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`a${i}`, { DataType: "String", StringValue: "v" }]),
    );
    await inTrace(async () => {
      await client.send(
        new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries: [
            { Id: "1", MessageBody: "a" },
            { Id: "2", MessageBody: "b", MessageAttributes: full },
          ],
        }),
      );
    });
    const entries = client.sent[0].input.Entries;
    expect(entries[0].MessageAttributes.traceparent).toBeDefined();
    expect(entries[1].MessageAttributes.traceparent).toBeUndefined();
  });

  it("outside a trace the command is untouched; kill switch records nothing", async () => {
    // @spec: INFRACAP-07
    undo.push(patchSqsClient(FakeSqsClient));
    const client = new FakeSqsClient();
    const cmd = new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: "b" });
    await client.send(cmd);
    expect(client.sent[0].input.MessageAttributes).toBeUndefined();

    process.env.MORSE_CAPTURE_INFRA = "0";
    const { spans } = await inTrace(async () => {
      await client.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: "b" }));
    });
    expect(spans).toHaveLength(0);
  });

  it("other commands pass through; ReceiveMessage asks for traceparent only with the consumer flag", async () => {
    // @spec: INFRACAP-08
    undo.push(patchSqsClient(FakeSqsClient));
    const client = new FakeSqsClient();
    await client.send(new ReceiveMessageCommand({ QueueUrl: QUEUE_URL }));
    expect(client.sent[0].input.MessageAttributeNames).toBeUndefined();

    process.env.MORSE_CAPTURE_QUEUE_CONSUMER = "1";
    await client.send(new ReceiveMessageCommand({ QueueUrl: QUEUE_URL }));
    expect(client.sent[1].input.MessageAttributeNames).toEqual(["traceparent"]);
  });
});

describe("consumer continuation (opt-in)", () => {
  const PRODUCER_TRACE = "c".repeat(32);
  const tp = `00-${PRODUCER_TRACE}-${"d".repeat(16)}-01`;

  async function seenTrace(
    run: (cb: () => unknown) => Promise<unknown>,
  ): Promise<string | undefined> {
    let id: string | undefined;
    await run(() => {
      id = getActiveTraceState()?.traceId;
    });
    return id;
  }

  it("is a pass-through without the flag", async () => {
    // @spec: INFRACAP-08
    const job = { queueName: "agent-jobs", opts: { telemetry: { metadata: tp } } };
    expect(await seenTrace((cb) => continueFromBullMqJob(job, "w", cb))).toBeUndefined();
    const msg = { MessageAttributes: { traceparent: { StringValue: tp } } };
    expect(await seenTrace((cb) => continueFromSqsMessage(msg, "w", cb))).toBeUndefined();
  });

  it("continues the producer trace for a BullMQ job and an SQS message", async () => {
    // @spec: INFRACAP-08
    process.env.MORSE_CAPTURE_QUEUE_CONSUMER = "1";
    const job = { queueName: "agent-jobs", opts: { telemetry: { metadata: tp } } };
    expect(await seenTrace((cb) => continueFromBullMqJob(job, "w", cb))).toBe(PRODUCER_TRACE);
    const msg = { MessageAttributes: { traceparent: { StringValue: tp } } };
    expect(
      await seenTrace((cb) => continueFromSqsMessage(msg, "w", cb, { queueUrl: QUEUE_URL })),
    ).toBe(PRODUCER_TRACE);
  });

  it("records a `process <destination>` span", async () => {
    // @spec: INFRACAP-08
    process.env.MORSE_CAPTURE_QUEUE_CONSUMER = "1";
    const msg = { MessageAttributes: { traceparent: { StringValue: tp } } };
    let state: TraceState | undefined;
    await continueFromSqsMessage(
      msg,
      "w",
      () => {
        state = getActiveTraceState() ?? undefined;
      },
      { queueUrl: QUEUE_URL },
    );
    const names = state!.completedSpans.map((s) => s.name);
    expect(names).toContain("process agent-jobs");
  });

  it.each([
    ["garbage", { MessageAttributes: { traceparent: { StringValue: "garbage" } } }],
    ["missing", {}],
    ["wrong shape", { MessageAttributes: "nope" }],
  ])("a %s traceparent starts a fresh trace and never throws", async (_label, msg) => {
    // @spec: INFRACAP-08
    process.env.MORSE_CAPTURE_QUEUE_CONSUMER = "1";
    const id = await seenTrace((cb) => continueFromSqsMessage(msg as any, "w", cb));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe(PRODUCER_TRACE);
    const jobId = await seenTrace((cb) => continueFromBullMqJob({ opts: null } as any, "w", cb));
    expect(jobId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("instrumentations", () => {
  it("construct without throwing", () => {
    // @spec: INFRACAP-07
    expect(() => new BullMqInstrumentation()).not.toThrow();
    expect(() => new SqsInstrumentation()).not.toThrow();
  });
});
