/**
 * MHQ-482 — vector-store / memory instrumentation (TS parity port).
 *
 * Coverage:
 *   - `classifyHttpCall`: one case per vector-store URL/method pattern,
 *     mirroring `apps/sdk/python/tests/test_http_classifier.py` exactly so
 *     both SDKs agree on what a Pinecone-upsert-vs-query HTTP call looks like.
 *   - `scanInstalledLibraries`: presence-detection smoke tests, adapted from
 *     `apps/sdk/python/tests/test_import_scanner.py`'s `TestScanImportedLibraries`
 *     (the watcher half of that Python file has no Node equivalent — see the
 *     module doc in `src/instrumentation/imports.ts`).
 */

import { describe, expect, it } from "vitest";

import { classifyHttpCall } from "../src/instrumentation/http-classifier";
import { scanInstalledLibraries, TRACKED_LIBRARIES } from "../src/instrumentation/imports";

describe("classifyHttpCall", () => {
  it("classifies a Pinecone query as retrieval", () => {
    expect(classifyHttpCall("myindex.svc.pinecone.io", "/query")).toBe("retrieval");
  });

  it("classifies a Pinecone upsert as store", () => {
    expect(classifyHttpCall("myindex.svc.pinecone.io", "/vectors/upsert")).toBe("store");
  });

  it("returns undefined for an unknown host and unknown path", () => {
    expect(classifyHttpCall("api.example.com", "/v1/something")).toBeUndefined();
  });

  it("returns undefined for an unknown host with a known path shape", () => {
    expect(classifyHttpCall("api.example.com", "/query")).toBeUndefined();
  });

  it("classifies a Chroma v4 (<0.5) query as retrieval", () => {
    expect(classifyHttpCall("localhost", "/api/v1/collections/my_collection/query")).toBe(
      "retrieval",
    );
  });

  it("classifies a Chroma v5 (0.5+) query as retrieval", () => {
    expect(
      classifyHttpCall(
        "127.0.0.1",
        "/api/v2/tenants/default_tenant/collections/my_collection/query",
      ),
    ).toBe("retrieval");
  });

  it("classifies a local Qdrant search as retrieval", () => {
    expect(classifyHttpCall("localhost", "/collections/my_collection/points/search")).toBe(
      "retrieval",
    );
  });

  it("classifies a Qdrant Cloud search as retrieval", () => {
    expect(
      classifyHttpCall(
        "abc123.us-east-1-0.aws.cloud.qdrant.io",
        "/collections/my_collection/points/search",
      ),
    ).toBe("retrieval");
  });

  it("classifies a Qdrant points upsert as store", () => {
    expect(classifyHttpCall("localhost", "/collections/my_collection/points")).toBe("store");
  });

  it("classifies a Weaviate GraphQL call as retrieval", () => {
    expect(classifyHttpCall("my-cluster.weaviate.network", "/v1/graphql")).toBe("retrieval");
  });

  it("classifies a Weaviate objects call as store", () => {
    expect(classifyHttpCall("my-cluster.weaviate.network", "/v1/objects")).toBe("store");
  });

  it("never throws on malformed input", () => {
    expect(() => classifyHttpCall("", "")).not.toThrow();
    expect(classifyHttpCall("", "")).toBeUndefined();
  });
});

describe("scanInstalledLibraries", () => {
  it("returns a plain object", () => {
    const result = scanInstalledLibraries();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });

  it("never throws even if resolution fails for every tracked library", () => {
    expect(() => scanInstalledLibraries()).not.toThrow();
  });

  it("only reports keys drawn from TRACKED_LIBRARIES", () => {
    const result = scanInstalledLibraries();
    for (const key of Object.keys(result)) {
      expect(TRACKED_LIBRARIES).toContain(key);
    }
  });

  it("reports a string version for any library found installed", () => {
    const result = scanInstalledLibraries();
    for (const version of Object.values(result)) {
      expect(typeof version).toBe("string");
    }
  });
});
