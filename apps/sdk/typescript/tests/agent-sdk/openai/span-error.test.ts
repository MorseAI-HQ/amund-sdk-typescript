/**
 * MHQ-1411 item 5 — openai-agents failure children read "[object Object]".
 *
 * `@openai/agents` reports a failed span as `{ message, data }`; the processor
 * used `String(span.error)`, so child spans stored "[object Object]" with
 * `exception_type=Error` while the root carried the real `NotFoundError`.
 */
import { describe, expect, it } from "vitest";

import { errToTypeName } from "../../../src/_internal/tracing";
import { agentsSpanError } from "../../../src/openai-agents/trace-processor";

describe("agentsSpanError (MHQ-1411)", () => {
  it("keeps the message and the error class from the SDK's span error object", () => {
    const err = agentsSpanError({
      message: "Error running agent",
      data: { error: "404 The model `gpt-nope` does not exist", name: "NotFoundError" },
    });
    expect(err.message).toBe("Error running agent: 404 The model `gpt-nope` does not exist");
    expect(err.message).not.toContain("[object Object]");
    expect(errToTypeName(err)).toBe("NotFoundError");
  });

  it("falls back to JSON for an object without a message", () => {
    expect(agentsSpanError({ code: 7 }).message).toBe('{"code":7}');
  });

  it("passes real Errors and strings through", () => {
    const e = new TypeError("boom");
    expect(agentsSpanError(e)).toBe(e);
    expect(agentsSpanError("plain").message).toBe("plain");
  });
});
