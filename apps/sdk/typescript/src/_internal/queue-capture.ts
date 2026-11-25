/**
 * Queue spans for BullMQ and SQS (aws-sdk v3) — INFRACAP-07/08, the TypeScript
 * half of Python's `queue_capture.py`.
 *
 * Producer side (default-on, active trace only)
 *   Publishing inside a Morse trace records a `queue` span named
 *   `publish <destination>` with OTel messaging attributes in metadata
 *   (`messaging.system`, `messaging.operation.type`,
 *   `messaging.destination.name`) and injects a W3C `traceparent`: into the
 *   job's `telemetry.metadata` for BullMQ, into `MessageAttributes` for SQS.
 *   Payloads (job data, message bodies) are never read.
 *
 * Consumer side (opt-in, `AMUND_CAPTURE_QUEUE_CONSUMER=1`)
 *   Neither BullMQ nor aws-sdk exposes a stable worker hook to patch, so the
 *   consumer side is a pair of helpers, `continueFromBullMqJob` and
 *   `continueFromSqsMessage`. Without the flag they just call `fn`. With it they
 *   continue the producer's trace and record a `process <destination>` span. A
 *   missing or malformed `traceparent` starts a fresh trace and never throws.
 *
 * Wiring: the two `Instrumentation`s below hook `require("bullmq")` /
 * `require("@aws-sdk/client-sqs")` like the DB instrumentations, so they share
 * their limit: an ESM-only app needs OpenTelemetry's import hook for the
 * `require`-time patch to fire.
 */

import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  type InstrumentationConfig,
} from "@opentelemetry/instrumentation";

import { isCaptureEnabled, isQueueConsumerEnabled } from "./env";
import { admitInfraCall, errorLabel } from "./infra-shared";
import { extractTraceparent, formatTraceparent } from "../propagation";
import {
  getActiveTraceState,
  runAsync,
  spanAsync,
  startDetachedSpan,
  type DetachedSpan,
  type RunHandle,
} from "./tracing";

const TRACEPARENT = "traceparent";
const MAX_SQS_ATTRIBUTES = 10; // AWS limit per message

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function publishSpan(system: string, destination: string | undefined): DetachedSpan | null {
  // Untraced publishes stop before reading any env var (process.env is slow).
  if (getActiveTraceState() === null) return null;
  if (!isCaptureEnabled("CAPTURE_QUEUE")) return null;
  if (!admitInfraCall("queue")) return null;
  return startDetachedSpan({
    name: destination ? `publish ${destination}` : "publish",
    type: "queue",
    metadata: {
      "messaging.system": system,
      "messaging.operation.type": "publish",
      ...(destination ? { "messaging.destination.name": destination } : {}),
    },
  });
}

function traceparentFor(det: DetachedSpan): string {
  return formatTraceparent(det.span.trace_id, det.span.span_id);
}

/** Run `call`, closing `det` when the returned promise settles. */
function endWhenSettled<T>(det: DetachedSpan | null, call: () => T): T {
  if (det === null) return call();
  let result: T;
  try {
    result = call();
  } catch (err) {
    det.end(errorLabel(err));
    throw err;
  }
  if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        det.end();
        return value;
      },
      (err) => {
        det.end(errorLabel(err));
        throw err;
      },
    ) as unknown as T;
  }
  det.end();
  return result;
}

/* ------------------------------------------------------------------------ */
/*  BullMQ                                                                   */
/* ------------------------------------------------------------------------ */

function withBullTraceparent(opts: AnyRecord | undefined, tp: string): AnyRecord {
  const telemetry = { ...(opts?.telemetry ?? {}) };
  // Never overwrite a carrier BullMQ's own telemetry integration set.
  if (telemetry.metadata === undefined) telemetry.metadata = tp;
  return { ...(opts ?? {}), telemetry };
}

/**
 * Patch `Queue.prototype.add` / `addBulk`. Returns an undo function.
 * Exported for tests and for apps that import BullMQ as ESM.
 */
export function patchBullMqQueue(QueueCtor: AnyRecord): () => void {
  const proto = QueueCtor?.prototype as AnyRecord | undefined;
  if (!proto) return () => {};
  const originalAdd = proto.add;
  const originalAddBulk = proto.addBulk;

  if (typeof originalAdd === "function") {
    proto.add = function (this: AnyRecord, name: string, data: unknown, opts?: AnyRecord) {
      const det = safe(() => publishSpan("bullmq", this?.name));
      if (det === null) return originalAdd.call(this, name, data, opts);
      const nextOpts = safe(() => withBullTraceparent(opts, traceparentFor(det))) ?? opts;
      return endWhenSettled(det, () => originalAdd.call(this, name, data, nextOpts));
    };
  }
  if (typeof originalAddBulk === "function") {
    proto.addBulk = function (this: AnyRecord, jobs: AnyRecord[]) {
      const det = safe(() => publishSpan("bullmq", this?.name));
      if (det === null) return originalAddBulk.call(this, jobs);
      const tp = traceparentFor(det);
      const next =
        safe(() =>
          jobs.map((j) => ({
            ...j,
            opts: withBullTraceparent(j?.opts, tp),
          })),
        ) ?? jobs;
      return endWhenSettled(det, () => originalAddBulk.call(this, next));
    };
  }
  return () => {
    if (typeof originalAdd === "function") proto.add = originalAdd;
    if (typeof originalAddBulk === "function") proto.addBulk = originalAddBulk;
  };
}

/** Never let capture throw into the caller. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Process one BullMQ job inside the producer's trace. Pass-through unless
 * `AMUND_CAPTURE_QUEUE_CONSUMER=1`.
 *
 *     new Worker("jobs", (job) => continueFromBullMqJob(job, "jobs-worker", () => handle(job)))
 */
export async function continueFromBullMqJob<T>(
  job: AnyRecord,
  agentName: string,
  fn: (handle: RunHandle) => Promise<T> | T,
): Promise<T> {
  if (!isQueueConsumerEnabled()) return fn(undefined as unknown as RunHandle);
  const tp = safe(() => job?.opts?.telemetry?.metadata);
  const dest = safe(() => (typeof job?.queueName === "string" ? job.queueName : undefined));
  return processInTrace(
    "bullmq",
    dest ?? undefined,
    typeof tp === "string" ? tp : undefined,
    agentName,
    fn,
  );
}

/* ------------------------------------------------------------------------ */
/*  SQS (aws-sdk v3)                                                         */
/* ------------------------------------------------------------------------ */

function queueNameFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const name = url.replace(/\/+$/, "").split("/").pop();
  return name || undefined;
}

function withSqsAttribute<T extends AnyRecord>(item: T, tp: string): T {
  const existing = { ...(item.MessageAttributes ?? {}) };
  if (TRACEPARENT in existing || Object.keys(existing).length >= MAX_SQS_ATTRIBUTES) return item;
  existing[TRACEPARENT] = { DataType: "String", StringValue: tp };
  return { ...item, MessageAttributes: existing };
}

/** Patch `SQSClient.prototype.send`. Returns an undo function. */
export function patchSqsClient(ClientCtor: AnyRecord): () => void {
  const proto = ClientCtor?.prototype as AnyRecord | undefined;
  if (!proto || typeof proto.send !== "function") return () => {};
  const originalSend = proto.send;

  proto.send = function (this: AnyRecord, command: AnyRecord, ...rest: unknown[]) {
    const kind = safe(() => command?.constructor?.name);

    if (kind === "ReceiveMessageCommand" && isQueueConsumerEnabled()) {
      safe(() => {
        const input = (command.input ?? {}) as AnyRecord;
        const names: string[] = [...(input.MessageAttributeNames ?? [])];
        if (!names.some((n) => n === "All" || n === ".*" || n === TRACEPARENT)) {
          command.input = { ...input, MessageAttributeNames: [...names, TRACEPARENT] };
        }
      });
      return originalSend.call(this, command, ...rest);
    }

    if (kind !== "SendMessageCommand" && kind !== "SendMessageBatchCommand") {
      return originalSend.call(this, command, ...rest);
    }
    const input = command.input as AnyRecord;
    const det = safe(() => publishSpan("aws_sqs", queueNameFromUrl(input?.QueueUrl)));
    if (det === null) return originalSend.call(this, command, ...rest);
    safe(() => {
      const tp = traceparentFor(det);
      command.input =
        kind === "SendMessageCommand"
          ? withSqsAttribute(input, tp)
          : {
              ...input,
              Entries: (input.Entries ?? []).map((e: AnyRecord) => withSqsAttribute(e, tp)),
            };
    });
    return endWhenSettled(det, () => originalSend.call(this, command, ...rest));
  };
  return () => {
    proto.send = originalSend;
  };
}

/**
 * Process one received SQS message inside the producer's trace. Pass-through
 * unless `AMUND_CAPTURE_QUEUE_CONSUMER=1`.
 */
export async function continueFromSqsMessage<T>(
  message: AnyRecord,
  agentName: string,
  fn: (handle: RunHandle) => Promise<T> | T,
  opts: { queueUrl?: string } = {},
): Promise<T> {
  if (!isQueueConsumerEnabled()) return fn(undefined as unknown as RunHandle);
  const tp = safe(() => message?.MessageAttributes?.[TRACEPARENT]?.StringValue);
  return processInTrace(
    "aws_sqs",
    queueNameFromUrl(opts.queueUrl),
    typeof tp === "string" ? tp : undefined,
    agentName,
    fn,
  );
}

async function processInTrace<T>(
  system: string,
  destination: string | undefined,
  traceparent: string | undefined,
  agentName: string,
  fn: (handle: RunHandle) => Promise<T> | T,
): Promise<T> {
  // A malformed value would only be ignored downstream; checking here keeps the
  // outcome ("fresh trace") explicit.
  const incoming = traceparent && extractTraceparent(traceparent) ? traceparent : undefined;
  const result = await runAsync({ agentName, incomingTraceparent: incoming }, (handle) =>
    spanAsync(
      {
        name: destination ? `process ${destination}` : "process",
        type: "custom",
        metadata: {
          "messaging.system": system,
          "messaging.operation.type": "process",
          ...(destination ? { "messaging.destination.name": destination } : {}),
        },
      },
      async () => fn(handle),
    ),
  );
  return result as T;
}

/* ------------------------------------------------------------------------ */
/*  Instrumentations (require-time hooks)                                    */
/* ------------------------------------------------------------------------ */

export class BullMqInstrumentation extends InstrumentationBase<InstrumentationConfig> {
  private undo: (() => void) | null = null;

  constructor(config: InstrumentationConfig = {}) {
    super("@morsehq/instrumentation-bullmq", "0.1.0", config);
  }

  protected init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        "bullmq",
        [">=3.0.0 <6"],
        (moduleExports: AnyRecord) => {
          this.undo?.();
          this.undo = patchBullMqQueue(moduleExports.Queue);
          return moduleExports;
        },
        () => {
          this.undo?.();
          this.undo = null;
        },
      ),
    ];
  }
}

export class SqsInstrumentation extends InstrumentationBase<InstrumentationConfig> {
  private undo: (() => void) | null = null;

  constructor(config: InstrumentationConfig = {}) {
    super("@morsehq/instrumentation-sqs", "0.1.0", config);
  }

  protected init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        "@aws-sdk/client-sqs",
        [">=3.0.0 <4"],
        (moduleExports: AnyRecord) => {
          this.undo?.();
          this.undo = patchSqsClient(moduleExports.SQSClient);
          return moduleExports;
        },
        () => {
          this.undo?.();
          this.undo = null;
        },
      ),
    ];
  }
}
