import { describe, expect, it } from "vitest";

import { buildDocuments } from "../../src/_internal/retrieval-documents";

// @spec: RAGQ-01
describe("buildDocuments (retriever documents[] wire field, @beta)", () => {
  it("emits rank, id, content, score, source", () => {
    // @spec: RAGQ-01
    const docs = buildDocuments([
      { pageContent: "first chunk", metadata: { source: "a.pdf", score: 0.9 } },
      { pageContent: "second chunk", metadata: { source: "b.pdf" } },
    ]);
    expect(docs.map((d) => d.rank)).toEqual([1, 2]);
    expect(docs[0]).toMatchObject({ content: "first chunk", source: "a.pdf", score: 0.9 });
    expect(docs[1]!.score).toBeNull();
    expect(docs[0]!.id).not.toBe(docs[1]!.id);
  });

  it("uses explicit ids and relevance_score", () => {
    // @spec: RAGQ-01
    const docs = buildDocuments([
      { id: "chunk-7", pageContent: "hi", metadata: { relevance_score: 0.4 } },
    ]);
    expect(docs[0]).toMatchObject({ id: "chunk-7", score: 0.4, source: "" });
  });

  it("caps at 10 chunks and truncates content to 2KB with a flag", () => {
    // @spec: RAGQ-01
    const input = [{ pageContent: "x".repeat(5000) }];
    for (let i = 0; i < 14; i++) input.push({ pageContent: `d${i}` });
    const docs = buildDocuments(input);
    expect(docs).toHaveLength(10);
    expect(new TextEncoder().encode(docs[0]!.content).length).toBeLessThanOrEqual(2048);
    expect(docs[0]!.truncated).toBe(true);
    expect(docs[1]!.truncated).toBeUndefined();
  });

  it("never throws on junk input", () => {
    // @spec: RAGQ-01
    expect(buildDocuments(null)).toEqual([]);
    expect(buildDocuments([null, 3, "x"])).toEqual([]);
  });
});
