/**
 * Shared builder for the retriever `documents[]` wire field (@beta, RAGQ-01).
 *
 * Each retrieved chunk is reported as
 * `{ rank, id, content (<= 2KB), score, source }` (plus `truncated: true` when
 * the content was cut). At most {@link MAX_DOCUMENTS} chunks are reported. The
 * field is additive — legacy keys stay on the span. Mirrors the Python SDK's
 * `morse_ai.adapters._retrieval.build_documents`.
 */

export const MAX_DOCUMENTS = 10;
export const MAX_CONTENT_BYTES = 2048;

export interface RetrievedDocument {
  rank: number;
  id: string;
  content: string;
  score: number | null;
  source: string;
  truncated?: true;
}

function truncateUtf8(content: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= MAX_CONTENT_BYTES) return { text: content, truncated: false };
  // Non-fatal decode drops a split trailing code point.
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, MAX_CONTENT_BYTES))
    .replace(/�+$/u, "");
  return { text, truncated: true };
}

/** Non-cryptographic stable id for chunks that carry no id (FNV-1a, 32-bit). */
function contentId(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Normalise retrieved documents. Never throws; unreadable entries are skipped. */
export function buildDocuments(docs: unknown): RetrievedDocument[] {
  const out: RetrievedDocument[] = [];
  if (!Array.isArray(docs)) return out;
  for (const doc of docs.slice(0, MAX_DOCUMENTS)) {
    try {
      if (!doc || typeof doc !== "object") continue;
      const d = doc as Record<string, unknown>;
      const metaRaw = d.metadata;
      const meta =
        metaRaw && typeof metaRaw === "object" ? (metaRaw as Record<string, unknown>) : {};
      const contentRaw = d.pageContent ?? d.page_content ?? d.content;
      const content = typeof contentRaw === "string" ? contentRaw : "";
      const { text, truncated } = truncateUtf8(content);
      const rawId = d.id ?? meta.id;
      const id =
        rawId !== undefined && rawId !== null && String(rawId) !== ""
          ? String(rawId)
          : contentId(content);
      const sourceRaw = d.source ?? meta.source;
      const entry: RetrievedDocument = {
        rank: out.length + 1,
        id,
        content: text,
        score: asNumber(d.score ?? meta.score ?? meta.relevance_score),
        source: typeof sourceRaw === "string" ? sourceRaw : "",
      };
      if (truncated) entry.truncated = true;
      out.push(entry);
    } catch {
      continue;
    }
  }
  return out;
}
