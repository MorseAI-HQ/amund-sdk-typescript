/**
 * Tests for the agent-SDK context-propagation helpers — fan-out parent
 * pinning, hook tool-sibling lookup, and the read-only trace inspector.
 *
 * Uses `runAsync` from the internal tracing module to construct
 * realistic active-trace states, then exercises the helpers against the
 * resulting `spanStack` / `completedSpans`.
 */

import { describe, expect, it } from "vitest";

import {
  captureParentForFanOut,
  emitAsToolSibling,
  emitWithPinnedParent,
  inspectTraceState,
} from "../../../src/_agent-sdk-common/context-propagation";
import { _resetForTesting, runAsync, startSpan } from "../../../src/_internal/tracing";

describe("captureParentForFanOut", () => {
  it("returns null outside any trace", () => {
    _resetForTesting();
    expect(captureParentForFanOut()).toBeNull();
  });

  it("returns the top-of-stack span_id inside a trace with one open span", async () => {
    _resetForTesting();
    await runAsync({ agentName: "test-agent" }, async () => {
      // The agent root span is on the stack now.
      const snap = captureParentForFanOut();
      expect(snap).not.toBeNull();
      // span_ids are UUID-shaped (32 hex chars) since Phase 13 fix —
      // matches backend TracePayloadIn + Python SDK. W3C interop slices
      // the first 16 chars at the propagation layer.
      expect(snap?.parentSpanId).toMatch(/^[0-9a-f]{32}$/);
      expect(snap?.traceId).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it("snapshot points to the deepest open span (not the trace root) when nested", async () => {
    _resetForTesting();
    await runAsync({ agentName: "test-agent" }, async () => {
      const outer = startSpan({ name: "outer", type: "custom" });
      expect(outer).not.toBeNull();
      const snap = captureParentForFanOut();
      expect(snap?.parentSpanId).toBe(outer?.span.span_id);
      outer?.end();
    });
  });
});

describe("emitWithPinnedParent — fan-out semantics", () => {
  it("pins child to captured parent even when stack has moved", async () => {
    _resetForTesting();
    await runAsync({ agentName: "test-agent" }, async () => {
      // A is the parent agent span we want children pinned to.
      const a = startSpan({ name: "A-agent", type: "agent" });
      expect(a).not.toBeNull();
      const snapshot = captureParentForFanOut();
      expect(snapshot?.parentSpanId).toBe(a?.span.span_id);

      // B starts and becomes top-of-stack — default startSpan would
      // pick B as parent for any new span.
      const b = startSpan({ name: "B-sibling", type: "custom" });
      expect(b).not.toBeNull();

      // Now emit C with the pinned snapshot — must link to A, NOT B.
      const c = emitWithPinnedParent({
        name: "C-fanout-child",
        type: "tool",
        snapshot: snapshot!,
      });
      expect(c).not.toBeNull();
      expect(c?.span.parent_span_id).toBe(a?.span.span_id);
      expect(c?.span.parent_span_id).not.toBe(b?.span.span_id);
      c?.end();
      b?.end();
      a?.end();
    });
  });

  it("returns null when snapshot's traceId is stale (different trace)", async () => {
    _resetForTesting();
    let staleSnapshot: { parentSpanId: string; traceId: string } | null = null;
    await runAsync({ agentName: "trace-1" }, async () => {
      staleSnapshot = captureParentForFanOut();
    });
    expect(staleSnapshot).not.toBeNull();

    // Now open a fresh trace; the previous snapshot's traceId is now
    // stale. emitWithPinnedParent must refuse.
    await runAsync({ agentName: "trace-2" }, async () => {
      const result = emitWithPinnedParent({
        name: "should-not-emit",
        type: "tool",
        snapshot: staleSnapshot!,
      });
      expect(result).toBeNull();
      // Confirm no span was added to the active trace's completedSpans
      // when we close out runAsync below.
      const inspected = inspectTraceState();
      expect(inspected?.completedSpans.length).toBe(0);
      // spanStack only holds the root agent span at this point.
      expect(inspected?.spanStack.length).toBe(1);
    });
  });

  it("returns null when no active trace exists", () => {
    _resetForTesting();
    const result = emitWithPinnedParent({
      name: "no-trace",
      type: "tool",
      snapshot: { parentSpanId: "deadbeefdeadbeef", traceId: "0".repeat(32) },
    });
    expect(result).toBeNull();
  });
});

describe("emitAsToolSibling — hook semantics", () => {
  it("attaches to the same parent as a still-open tool span", async () => {
    _resetForTesting();
    await runAsync({ agentName: "hook-test" }, async () => {
      const agentRootSnap = captureParentForFanOut();
      const tool = startSpan({ name: "search-tool", type: "tool" });
      expect(tool).not.toBeNull();
      expect(tool?.span.parent_span_id).toBe(agentRootSnap?.parentSpanId);

      const hook = emitAsToolSibling({
        name: "pre_tool",
        type: "custom",
        toolSpanId: tool!.span.span_id,
      });
      expect(hook).not.toBeNull();
      expect(hook?.span.parent_span_id).toBe(tool?.span.parent_span_id);
      // And NOT nested under the tool span itself.
      expect(hook?.span.parent_span_id).not.toBe(tool?.span.span_id);
      hook?.end();
      tool?.end();
    });
  });

  it("works after the tool span has been closed (looks up completedSpans)", async () => {
    _resetForTesting();
    await runAsync({ agentName: "post-hook-test" }, async () => {
      const tool = startSpan({ name: "search-tool", type: "tool" });
      const toolId = tool!.span.span_id;
      const toolParent = tool!.span.parent_span_id;
      tool!.end();
      // Tool is now in completedSpans, not on the stack.

      const post = emitAsToolSibling({
        name: "post_tool",
        type: "custom",
        toolSpanId: toolId,
      });
      expect(post).not.toBeNull();
      expect(post?.span.parent_span_id).toBe(toolParent);
      post?.end();
    });
  });

  it("returns null when the toolSpanId is unknown", async () => {
    _resetForTesting();
    await runAsync({ agentName: "unknown-tool-test" }, async () => {
      const result = emitAsToolSibling({
        name: "orphan-hook",
        type: "custom",
        toolSpanId: "0123456789abcdef",
      });
      expect(result).toBeNull();
    });
  });

  it("returns null outside of any active trace", () => {
    _resetForTesting();
    const result = emitAsToolSibling({
      name: "outside-trace",
      type: "custom",
      toolSpanId: "0123456789abcdef",
    });
    expect(result).toBeNull();
  });
});

describe("inspectTraceState", () => {
  it("returns null outside any trace", () => {
    _resetForTesting();
    expect(inspectTraceState()).toBeNull();
  });

  it("returns populated snapshot inside a trace", async () => {
    _resetForTesting();
    await runAsync({ agentName: "inspect-test" }, async () => {
      const open = startSpan({ name: "open-span", type: "custom" });
      const closed = startSpan({ name: "closed-span", type: "custom" });
      closed?.end();

      const snap = inspectTraceState();
      expect(snap).not.toBeNull();
      expect(snap?.traceId).toMatch(/^[0-9a-f]{32}$/);
      // spanStack: agent root + open-span (closed-span popped).
      expect(snap?.spanStack.length).toBe(2);
      expect(snap?.spanStack[1]?.name).toBe("open-span");
      expect(snap?.completedSpans.length).toBe(1);
      expect(snap?.completedSpans[0]?.name).toBe("closed-span");

      open?.end();
    });
  });

  it("returns independent snapshot arrays (mutations don't bleed back)", async () => {
    _resetForTesting();
    await runAsync({ agentName: "isolation-test" }, async () => {
      const snap = inspectTraceState();
      expect(snap).not.toBeNull();
      // Try to mutate the snapshot — should not affect the live trace.
      (snap?.spanStack as unknown as SpanLike[]).push({ span_id: "fake" } as SpanLike);
      const snap2 = inspectTraceState();
      expect(snap2?.spanStack.length).toBe(1);
    });
  });
});

describe("error absorption", () => {
  it("emitWithPinnedParent absorbs errors from a malformed snapshot", async () => {
    _resetForTesting();
    await runAsync({ agentName: "absorb-test" }, async () => {
      // Pass a null snapshot via an `unknown` cast — we want to verify
      // the helper never propagates a TypeError to the caller.
      const result = emitWithPinnedParent({
        name: "bad-input",
        type: "tool",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshot: null as unknown as any,
      });
      expect(result).toBeNull();
    });
  });

  it("emitAsToolSibling absorbs errors when given an obviously bad input", async () => {
    _resetForTesting();
    await runAsync({ agentName: "absorb-test-2" }, async () => {
      const result = emitAsToolSibling({
        name: "bad-input",
        type: "custom",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolSpanId: undefined as unknown as any,
      });
      expect(result).toBeNull();
    });
  });
});

// Minimal local alias so the mutation-isolation test compiles without
// importing the internal SpanData shape.
type SpanLike = { span_id: string };
