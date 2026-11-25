/**
 * INFRACAP-10 — overhead of default-on infra capture (TypeScript SDK).
 *
 *     pnpm --filter @amund/sdk bench:infra     # tsx benchmarks/infra-capture-overhead.ts
 *
 * Same two questions and the same fixed thresholds as the Python benchmark:
 *
 *   1. No trace active: what does a call cost with capture on vs off?
 *      Pass if the overhead is <= 2% of the call OR <= 5 microseconds.
 *   2. Trace active: what does one captured call ADD? p50 and p99 of per-call
 *      latency with capture on minus off. Pass if p50 <= 50 us and p99 <= 150 us.
 *
 * Three integrations, each measured the way that keeps its noise out:
 *
 *   - sqlite (better-sqlite3 behind the OTel instrumentation + trace gate):
 *     capture on/off is a process-level switch (the driver is patched when it
 *     is first `require`d), so each side runs in a child process and the parent
 *     alternates them.
 *   - http: the diagnostics_channel handlers are driven directly with a fake
 *     request, so the number is the handler's own cost ("isolated"). A real
 *     `fetch` against a local server is also timed, for the 2% rule only.
 *   - queue (BullMQ patch on a stand-in Queue): wrapper vs bare method.
 *
 * Thresholds are fixed. A miss prints FAIL and exits 1; nothing is tuned to the
 * result.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel } from "node:diagnostics_channel";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { disableDbCapture } from "../src/_internal/db-capture";
import { disableHttpCapture } from "../src/_internal/http-capture";
import { maybeEnableInfraCaptureFromEnv } from "../src/_internal/infra-capture";
import { getEngine } from "../src/_internal/otel-provider";
import { patchBullMqQueue } from "../src/_internal/queue-capture";
import { buildRedactionConfig } from "../src/_internal/redaction";
import { runSync } from "../src/_internal/tracing";

const NO_TRACE_MAX_PCT = 2.0;
const NO_TRACE_MAX_US = 5.0;
const SPAN_P50_MAX_US = 50.0;
const SPAN_P99_MAX_US = 150.0;

const BLOCK = 90; // calls per trace; caps are 200 db / 100 http / 100 queue
const TRACE_ROUNDS = 200;
const NO_TRACE_ROUNDS = 30;
const NO_TRACE_CALLS = 3000;
const CHILD_ROUNDS = 4;

const now = (): number => Number(process.hrtime.bigint());
const pct = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
};
const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
const median = (v: number[]): number => pct(v, 0.5);

/* ------------------------------------------------------------------------ */
/*  child process: better-sqlite3 with capture on or off                     */
/* ------------------------------------------------------------------------ */

function runChild(mode: "on" | "off", outFile: string): void {
  process.env.AMUND_CAPTURE_DB = mode === "on" ? "1" : "0";
  process.env.AMUND_CAPTURE_HTTP = "0";
  process.env.AMUND_CAPTURE_QUEUE = "0";
  const engine = getEngine();
  engine.configure({
    endpoint: "http://127.0.0.1:1/api/v1/otlp/v1/traces",
    apiKey: "av_bench", // pragma: allowlist secret
    sampleRate: 1.0,
    scheduleDelayMillis: 60_000, // never export during timing
    maxQueueSize: 1_000_000,
    maxExportBatchSize: 512,
    maxFieldBytes: 65536,
    timeoutMillis: 1000,
    redactionConfig: buildRedactionConfig({ enabled: true }),
    captureForTests: true,
  });
  maybeEnableInfraCaptureFromEnv();
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (a INTEGER)");
  const stmt = db.prepare("SELECT a FROM t WHERE a = 1");

  for (let i = 0; i < 2000; i++) stmt.get(); // warm
  const noTrace: number[] = [];
  for (let r = 0; r < NO_TRACE_ROUNDS; r++) {
    const t0 = now();
    for (let i = 0; i < NO_TRACE_CALLS; i++) stmt.get();
    noTrace.push((now() - t0) / NO_TRACE_CALLS);
  }
  const inTrace: number[] = [];
  for (let r = 0; r < TRACE_ROUNDS; r++) {
    runSync({ agentName: "bench" }, () => {
      for (let i = 0; i < BLOCK; i++) {
        const t0 = now();
        stmt.get();
        inTrace.push(now() - t0);
      }
    });
  }
  writeFileSync(outFile, JSON.stringify({ noTraceMean: median(noTrace), inTrace }));
  process.exit(0);
}

function spawnChild(mode: "on" | "off"): { noTraceMean: number; inTrace: number[] } {
  const dir = mkdtempSync(join(tmpdir(), "morse-bench-"));
  const outFile = join(dir, "result.json");
  try {
    const res = spawnSync(
      process.execPath,
      [...process.execArgv, process.argv[1]!, "--child", mode, outFile],
      { encoding: "utf8", cwd: process.cwd() },
    );
    if (res.status !== 0) throw new Error(`child ${mode} failed:\n${res.stdout}\n${res.stderr}`);
    return JSON.parse(readFileSync(outFile, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------ */
/*  http: handlers driven directly                                           */
/* ------------------------------------------------------------------------ */

function httpCycle(): void {
  const request = { host: "bench.example.test", method: "GET" };
  channel("http.client.request.start").publish({ request });
  channel("http.client.response.finish").publish({ request, response: { statusCode: 200 } });
}

function timeLoop(fn: () => void, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    fn();
    out.push(now() - t0);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/*  report                                                                   */
/* ------------------------------------------------------------------------ */

const failures: string[] = [];
const us = (ns: number): string => (ns / 1000).toFixed(2).padStart(9);

function gradeNoTrace(
  name: string,
  mode: string,
  offNs: number,
  onNs: number,
  useAbsoluteOnly: boolean,
): void {
  const dUs = (onNs - offNs) / 1000;
  const p = ((onNs - offNs) / offNs) * 100;
  const ok = useAbsoluteOnly
    ? dUs <= NO_TRACE_MAX_US
    : p <= NO_TRACE_MAX_PCT || dUs <= NO_TRACE_MAX_US;
  if (!ok) failures.push(`no-trace ${mode} ${name}: ${dUs.toFixed(2)} us / ${p.toFixed(2)}%`);
  console.log(
    `${name.padEnd(22)} ${mode.padEnd(11)} ${us(offNs)} ${us(onNs)} ${dUs.toFixed(2).padStart(9)} ${
      useAbsoluteOnly ? "n/a".padStart(8) : p.toFixed(2).padStart(8)
    }  ${ok ? "PASS" : "FAIL"}`,
  );
}

function gradeSpan(name: string, mode: string, off: number[], on: number[], graded: boolean): void {
  const p50 = (pct(on, 0.5) - pct(off, 0.5)) / 1000;
  const p99 = (pct(on, 0.99) - pct(off, 0.99)) / 1000;
  const ok = p50 <= SPAN_P50_MAX_US && p99 <= SPAN_P99_MAX_US;
  if (graded && !ok)
    failures.push(`per-span ${mode} ${name}: p50 ${p50.toFixed(2)} us, p99 ${p99.toFixed(2)} us`);
  console.log(
    `${name.padEnd(22)} ${mode.padEnd(11)} ${p50.toFixed(2).padStart(9)} ${p99.toFixed(2).padStart(9)}  ${
      graded ? (ok ? "PASS" : "FAIL") : "(informational, noisy)"
    }`,
  );
}

async function main(): Promise<number> {
  console.log(`Node ${process.version}`);
  console.log(
    `Thresholds: no-trace <= ${NO_TRACE_MAX_PCT}% or <= ${NO_TRACE_MAX_US} us per call; ` +
      `per span p50 <= ${SPAN_P50_MAX_US} us, p99 <= ${SPAN_P99_MAX_US} us\n`,
  );

  // sqlite via child processes, alternated
  const sqlite = {
    off: [] as number[],
    on: [] as number[],
    offNo: [] as number[],
    onNo: [] as number[],
  };
  for (let r = 0; r < CHILD_ROUNDS; r++) {
    for (const mode of ["off", "on"] as const) {
      const res = spawnChild(mode);
      sqlite[mode].push(...res.inTrace);
      (mode === "off" ? sqlite.offNo : sqlite.onNo).push(res.noTraceMean);
    }
  }

  // http isolated
  const startCh = channel("http.client.request.start");
  void startCh;
  const httpNoTrace = { off: [] as number[], on: [] as number[] };
  const httpInTrace = { off: [] as number[], on: [] as number[] };
  for (let r = 0; r < NO_TRACE_ROUNDS; r++) {
    for (const on of [false, true]) {
      disableHttpCapture();
      if (on) process.env.AMUND_CAPTURE_HTTP = "1";
      else process.env.AMUND_CAPTURE_HTTP = "0";
      maybeEnableInfraCaptureFromEnv();
      httpCycle();
      (on ? httpNoTrace.on : httpNoTrace.off).push(mean(timeLoop(httpCycle, NO_TRACE_CALLS)));
    }
  }
  for (let r = 0; r < TRACE_ROUNDS; r++) {
    for (const on of [false, true]) {
      disableHttpCapture();
      process.env.AMUND_CAPTURE_HTTP = on ? "1" : "0";
      maybeEnableInfraCaptureFromEnv();
      runSync({ agentName: "bench" }, () => {
        (on ? httpInTrace.on : httpInTrace.off).push(...timeLoop(httpCycle, BLOCK));
      });
    }
  }
  disableHttpCapture();

  // http end-to-end: real fetch against a local server, no trace (2% rule)
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const e2e = { off: [] as number[], on: [] as number[] };
  for (let r = 0; r < 60; r++) {
    for (const on of r % 2 === 0 ? [false, true] : [true, false]) {
      disableHttpCapture();
      process.env.AMUND_CAPTURE_HTTP = on ? "1" : "0";
      maybeEnableInfraCaptureFromEnv();
      await (await fetch(base)).text();
      const t0 = now();
      for (let i = 0; i < 300; i++) await (await fetch(base)).text();
      (on ? e2e.on : e2e.off).push((now() - t0) / 300);
    }
  }
  disableHttpCapture();
  server.close();

  // queue (BullMQ patch) isolated
  class Q {
    name = "bench";
    async add(): Promise<number> {
      return 1;
    }
  }
  const bareAdd = Q.prototype.add;
  const queueTimes = {
    off: [] as number[],
    on: [] as number[],
    offNo: [] as number[],
    onNo: [] as number[],
  };
  const q = new Q();
  process.env.AMUND_CAPTURE_QUEUE = "1";
  for (let r = 0; r < NO_TRACE_ROUNDS; r++) {
    for (const on of [false, true]) {
      const undo = on ? patchBullMqQueue(Q) : () => {};
      const t0 = now();
      for (let i = 0; i < NO_TRACE_CALLS; i++) await q.add();
      (on ? queueTimes.onNo : queueTimes.offNo).push((now() - t0) / NO_TRACE_CALLS);
      undo();
    }
  }
  for (let r = 0; r < TRACE_ROUNDS; r++) {
    for (const on of [false, true]) {
      const undo = on ? patchBullMqQueue(Q) : () => {};
      await runSyncAsync(async () => {
        for (let i = 0; i < BLOCK; i++) {
          const t0 = now();
          await q.add();
          (on ? queueTimes.on : queueTimes.off).push(now() - t0);
        }
      });
      undo();
    }
  }
  Q.prototype.add = bareAdd;

  console.log("1. NO TRACE ACTIVE: capture on vs off");
  console.log(
    `${"integration".padEnd(22)} ${"mode".padEnd(11)} ${"off us".padStart(9)} ${"on us".padStart(9)} ${"delta us".padStart(9)} ${"delta %".padStart(8)}  verdict`,
  );
  gradeNoTrace(
    "sqlite (better-sqlite3)",
    "end-to-end",
    median(sqlite.offNo),
    median(sqlite.onNo),
    false,
  );
  gradeNoTrace("http handlers", "isolated", median(httpNoTrace.off), median(httpNoTrace.on), true);
  // Paired per-round delta: off and on run back to back, order alternating, so drift cancels.
  const e2eOff = median(e2e.off);
  const e2eDelta = median(e2e.on.map((v, i) => v - e2e.off[i]!));
  gradeNoTrace("http fetch", "end-to-end", e2eOff, e2eOff + e2eDelta, false);
  gradeNoTrace("bullmq add", "isolated", median(queueTimes.offNo), median(queueTimes.onNo), true);

  console.log("\n2. TRACE ACTIVE: cost one captured call adds");
  console.log(
    `${"integration".padEnd(22)} ${"mode".padEnd(11)} ${"p50 us".padStart(9)} ${"p99 us".padStart(9)}  verdict`,
  );
  gradeSpan("sqlite (better-sqlite3)", "end-to-end", sqlite.off, sqlite.on, true);
  gradeSpan("http handlers", "isolated", httpInTrace.off, httpInTrace.on, true);
  gradeSpan("bullmq add", "isolated", queueTimes.off, queueTimes.on, true);

  console.log();
  if (failures.length) {
    console.log("FAILED thresholds:");
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log("All thresholds met.");
  return 0;
}

/** `runSync` with an async body: keep the trace open until the body settles. */
async function runSyncAsync(fn: () => Promise<void>): Promise<void> {
  const { runAsync } = await import("../src/_internal/tracing");
  await runAsync({ agentName: "bench" }, fn);
}

void disableDbCapture;

const childIdx = process.argv.indexOf("--child");
if (childIdx !== -1) {
  runChild(process.argv[childIdx + 1] as "on" | "off", process.argv[childIdx + 2]!);
} else {
  main().then((code) => process.exit(code));
}
