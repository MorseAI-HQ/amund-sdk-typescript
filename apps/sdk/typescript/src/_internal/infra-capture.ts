/**
 * Default-on infra capture entry point (INFRACAP-01/02), the TypeScript
 * counterpart of Python's `infra_capture.maybe_enable_from_env` plus
 * `queue_capture.maybe_enable_from_env`.
 *
 * On unless switched off: `MORSE_CAPTURE_DB=0`, `MORSE_CAPTURE_HTTP=0`,
 * `MORSE_CAPTURE_QUEUE=0`, or `MORSE_CAPTURE_INFRA=0` for all three (a
 * specific flag wins). Nothing is recorded outside an active Morse trace.
 *
 * Node-only. The browser build swaps this module for `infra-capture.browser.ts`.
 */

import type { Instrumentation } from "@opentelemetry/instrumentation";

import { report } from "./diagnostics";
import { maybeEnableDbCaptureFromEnv } from "./db-capture";
import { isCaptureEnabled, isQueueConsumerEnabled } from "./env";
import { disableHttpCapture, enableHttpCapture } from "./http-capture";
import { getEngine } from "./otel-provider";
import { BullMqInstrumentation, SqsInstrumentation } from "./queue-capture";

let unregisterQueue: (() => void) | null = null;

/** Register the BullMQ + SQS producer hooks. Idempotent; no-op before `configure()`. */
export function registerQueueInstrumentation(): boolean {
  unregisterQueue?.();
  unregisterQueue = null;
  const instrumentations = [
    new BullMqInstrumentation() as unknown as Instrumentation,
    new SqsInstrumentation() as unknown as Instrumentation,
  ];
  const off = getEngine().registerInstrumentations(instrumentations);
  if (off === null) return false;
  unregisterQueue = off;
  return true;
}

/** Undo the queue hooks. Primarily for tests. */
export function disableQueueCapture(): void {
  unregisterQueue?.();
  unregisterQueue = null;
}

/**
 * Called from `index.ts::buildSingleton()` after `getOtelEngine().configure()`.
 *
 * @param opts.endpoint The ingest URL in use, so HTTP capture never traces the
 *   SDK's own telemetry.
 */
export function maybeEnableInfraCaptureFromEnv(opts: { endpoint?: string } = {}): void {
  try {
    maybeEnableDbCaptureFromEnv();
  } catch (err) {
    report(err, { fingerprint: "morse.db_capture.register" });
  }
  try {
    if (isCaptureEnabled("MORSE_CAPTURE_HTTP")) enableHttpCapture({ endpoint: opts.endpoint });
    else disableHttpCapture();
  } catch (err) {
    report(err, { fingerprint: "morse.http_capture.register" });
  }
  try {
    if (isCaptureEnabled("MORSE_CAPTURE_QUEUE") || isQueueConsumerEnabled()) {
      registerQueueInstrumentation();
    } else {
      disableQueueCapture();
    }
  } catch (err) {
    report(err, { fingerprint: "morse.queue_capture.register" });
  }
}
