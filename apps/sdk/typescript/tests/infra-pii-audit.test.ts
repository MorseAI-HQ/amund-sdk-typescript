/**
 * INFRACAP-09 — canary PII audit for default-on infra capture (TypeScript).
 *
 * Canary values go through every instrumented path (SQL bound parameters and
 * inline literals, URL path and query, headers, request/response bodies, queue
 * job data and message bodies, and the text of failing calls). Everything that
 * reaches the OTLP exporter is then searched for them.
 *
 * Redaction is OFF for the audit on purpose: with it on, the generic
 * email/card patterns would mask some canaries and the test could pass because
 * of redaction instead of because capture never read the value.
 */

import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { disableDbCapture, registerDbInstrumentation } from "../src/_internal/db-capture";
import { disableHttpCapture, enableHttpCapture } from "../src/_internal/http-capture";
import { scrubDbSpan } from "../src/_internal/infra-shared";
import { getEngine } from "../src/_internal/otel-provider";
import { patchBullMqQueue, patchSqsClient } from "../src/_internal/queue-capture";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { runAsync } from "../src/_internal/tracing";

/* eslint-disable @typescript-eslint/no-explicit-any */

const EMAIL = "canary.user@pii-audit.test";
const CARD = "4111111111111111";
const TOKEN = "tok_canary_9f3a7c";
const BEARER = "sk-canary-bearer-0123456789";
const COOKIE = "session=canary-cookie-777";
const BODY = "canary-body-payload-42";
const CANARIES = [EMAIL, CARD, TOKEN, BEARER, COOKIE, BODY];

class FakeQueue {
  name = "pii-queue";
  async add() {
    return { id: "1" };
  }
  async addBulk(jobs: any[]) {
    return jobs;
  }
}
class SendMessageCommand {
  constructor(public input: any) {}
}
class FakeSqsClient {
  failNext = false;
  async send() {
    if (this.failNext) throw new Error(`queue refused ${BODY} for ${EMAIL}`);
    return {};
  }
}

let server: http.Server;
let base: string;
const undo: Array<() => void> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = req.url?.startsWith("/boom") ? 503 : 200;
    res.end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  disableHttpCapture();
  disableDbCapture();
  while (undo.length) undo.pop()!();
  getEngine().resetForTesting();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("canary PII audit", () => {
  it("zero canaries in exported spans", async () => {
    // @spec: INFRACAP-09
    const engine = getEngine();
    engine.configure({
      endpoint: "http://127.0.0.1:1/api/v1/otlp/v1/traces",
      apiKey: "av_test", // pragma: allowlist secret
      sampleRate: 1.0,
      scheduleDelayMillis: 20,
      maxQueueSize: 4096,
      maxExportBatchSize: 512,
      maxFieldBytes: 65536,
      timeoutMillis: 1000,
      redactionConfig: buildRedactionConfig({ enabled: false }),
      captureForTests: true,
    });
    registerDbInstrumentation();
    enableHttpCapture();
    undo.push(patchBullMqQueue(FakeQueue), patchSqsClient(FakeSqsClient));
    // better-sqlite3 must be first required AFTER the instrumentation is registered.
    const Database = createRequire(import.meta.url)("better-sqlite3");

    const queue: any = new FakeQueue();
    const sqs: any = new FakeSqsClient();
    const url = `${base}/users/${EMAIL}/orders?token=${TOKEN}&card=${CARD}`;

    await runAsync({ agentName: "pii-agent" }, async () => {
      // SQL: bound params, inline literals, and a failing statement
      const db = new Database(":memory:");
      db.exec("CREATE TABLE users (email TEXT UNIQUE, card TEXT, n INTEGER)");
      db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(EMAIL, CARD, 1);
      db.prepare(`SELECT * FROM users WHERE email = '${EMAIL}' AND n = ${CARD}`).all();
      expect(() =>
        db.prepare(`INSERT INTO users VALUES ('${EMAIL}', '${CARD}', 3)`).run(),
      ).toThrow();
      db.prepare(`SELECT 1 -- ${BEARER}\n`).all();
      db.close();

      // HTTP via fetch: path, query, headers, body, and a failing call
      await (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${BEARER}`, cookie: COOKIE },
          body: BODY,
        })
      ).text();
      await (await fetch(`${base}/boom/${EMAIL}?token=${TOKEN}`)).text();
      await fetch(`http://127.0.0.1:1/${EMAIL}?token=${TOKEN}`).catch(() => undefined);

      // HTTP via node:http
      await new Promise<void>((resolve) => {
        http
          .get(url, { headers: { authorization: `Bearer ${BEARER}`, cookie: COOKIE } }, (res) => {
            res.resume();
            res.on("end", () => resolve());
          })
          .on("error", () => resolve());
      });

      // Queue: BullMQ job data and options, SQS body and attribute values, and a failure
      await queue.add("work", { email: EMAIL, card: CARD, body: BODY }, { jobId: TOKEN });
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/pii-queue",
          MessageBody: BODY,
          MessageAttributes: { who: { DataType: "String", StringValue: EMAIL } },
        }),
      );
      sqs.failNext = true;
      await sqs
        .send(
          new SendMessageCommand({
            QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/pii-queue",
            MessageBody: BODY,
          }),
        )
        .catch(() => undefined);
    });

    await engine.flush();
    const spans = engine.recorder!.spans;
    // The audit only means something if every path really produced a span.
    const count = (pred: (s: (typeof spans)[number]) => boolean) => spans.filter(pred).length;
    expect(count((s) => s.attributes["db.system.name"] === "sqlite")).toBeGreaterThanOrEqual(5);
    expect(
      count((s) => s.attributes["http.status_code"] !== undefined || /127\.0\.0\.1/.test(s.name)),
    ).toBeGreaterThanOrEqual(3);
    expect(
      count((s) => /messaging\.system/.test(JSON.stringify(s.attributes))),
    ).toBeGreaterThanOrEqual(3);

    const exported = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })),
        status: s.status,
      })),
    );
    const hits = CANARIES.filter((c) => exported.includes(c));
    expect(hits, `canary values leaked: ${hits.join(", ")}`).toEqual([]);
  });

  it("driver exception text is dropped from DB spans (Postgres-style DETAIL line)", () => {
    // @spec: INFRACAP-09
    const span = {
      attributes: { "db.system": "postgresql", "db.statement": `SELECT '${EMAIL}'` },
      events: [
        {
          attributes: {
            "exception.type": "error",
            "exception.message": `duplicate key\nDETAIL: Key (email)=(${EMAIL}) already exists.`,
            "exception.stacktrace": `error: ${EMAIL}\n  at foo`,
          },
        },
      ],
      status: { message: `Key (email)=(${EMAIL}) already exists.` } as { message?: string },
    };
    scrubDbSpan(span as any);
    expect(JSON.stringify(span)).not.toContain(EMAIL);
    expect((span.events[0]!.attributes as any)["exception.type"]).toBe("error");
  });
});
