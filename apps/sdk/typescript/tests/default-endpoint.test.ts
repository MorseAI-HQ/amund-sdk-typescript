/**
 * Default ingest host (Amund rebrand, 2026-11-25): api.amundai.com is the
 * default; api.morseai.dev stays a supported alias for the same service.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_API_HOST, DEFAULT_ENDPOINT, PROD_API_HOSTS } from "../src/_internal/env";
import { deriveLogsEndpoint } from "../src/_internal/transport";

describe("default endpoint", () => {
  it("is the prod API on api.amundai.com", () => {
    expect(DEFAULT_API_HOST).toBe("api.amundai.com");
    expect(DEFAULT_ENDPOINT).toBe("https://api.amundai.com/api/v1/traces/batch");
  });

  it("recognises api.amundai.com and api.morseai.dev as the production API", () => {
    expect([...PROD_API_HOSTS].sort()).toEqual(["api.amundai.com", "api.morseai.dev"]);
    expect(PROD_API_HOSTS).not.toContain("api.morsehq.dev");
  });

  it("derives sibling endpoints on whichever prod host is configured", () => {
    expect(deriveLogsEndpoint(DEFAULT_ENDPOINT)).toBe("https://api.amundai.com/api/v1/logs/ingest");
    expect(deriveLogsEndpoint("https://api.morseai.dev/api/v1/traces/batch")).toBe(
      "https://api.morseai.dev/api/v1/logs/ingest",
    );
  });
});
