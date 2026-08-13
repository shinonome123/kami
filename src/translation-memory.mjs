import { normalizeSource, similarity } from "./text.mjs";

const QUALITY_WEIGHT = Object.freeze({
  human_approved: 0.18,
  machine_verified: 0.02,
  provisional: 0,
  rejected: -1
});

function tokenOverlap(left, right) {
  const a = new Set([...normalizeSource(left)]);
  const b = new Set([...normalizeSource(right)]);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function cosineScore(stored, query) {
  const storedVector = stored?.embedding?.vector;
  if (!Array.isArray(storedVector) || !Array.isArray(query?.vector) || !storedVector.length) return null;
  if (Number(stored.embedding?.dimensions) !== Number(query.dimensions)) return null;
  if (stored.embedding?.model && query.model && stored.embedding.model !== query.model) return null;
  let dot = 0;
  for (let index = 0; index < storedVector.length; index += 1) dot += storedVector[index] * query.vector[index];
  return Math.max(0, Math.min(1, dot));
}

function lexicalScore(normalized, memory) {
  const edit = similarity(normalized, normalizeSource(memory.source));
  const overlap = tokenOverlap(normalized, memory.source);
  const exact = normalized === normalizeSource(memory.source) ? 1 : 0;
  return { edit, overlap, exact };
}

export function rankTranslationMemories(source, memories = [], { limit = 5, queryEmbedding = null } = {}) {
  const normalized = normalizeSource(source);
  const ranked = memories
    .filter((memory) => memory.source && memory.target && ["human_approved", "machine_verified"].includes(memory.qualityStatus))
    .map((memory) => {
      const { edit, overlap, exact } = lexicalScore(normalized, memory);
      const quality = QUALITY_WEIGHT[memory.qualityStatus] ?? 0;
      const lexical = Math.min(1, exact * 0.45 + edit * 0.38 + overlap * 0.17 + quality);
      const cosine = cosineScore(memory, queryEmbedding);
      const localVector = String(queryEmbedding?.model || "").startsWith("local-");
      const blended = cosine === null
        ? lexical
        : Math.min(1, (localVector ? 0.72 : 0.42) * lexical + (localVector ? 0.28 : 0.58) * cosine + quality);
      const score = Math.max(lexical, blended);
      return { ...memory, similarity: Number(score.toFixed(3)), semantic: cosine === null ? null : Number(cosine.toFixed(3)) };
    })
    .sort((a, b) => b.similarity - a.similarity || (b.qaScore || 0) - (a.qaScore || 0));
  const strong = ranked.filter((memory) => memory.similarity >= 0.28).slice(0, limit);
  if (strong.length >= limit) return strong;
  const selectedIds = new Set(strong.map((memory) => memory.id));
  const styleFallback = ranked
    .filter((memory) => !selectedIds.has(memory.id) && (memory.similarity >= 0.12 || memory.qualityStatus === "human_approved"))
    .map((memory) => ({ ...memory, contextualFallback: true }))
    .slice(0, limit - strong.length);
  return [...strong, ...styleFallback];
}

export function rankQaCases(source, cases = [], { limit = 3, queryEmbedding = null } = {}) {
  const normalized = normalizeSource(source);
  return cases.map((item) => {
    const edit = similarity(normalized, normalizeSource(item.source));
    const overlap = tokenOverlap(normalized, item.source);
    const lexical = edit * 0.72 + overlap * 0.28;
    const cosine = cosineScore(item, queryEmbedding);
    const blended = cosine === null ? lexical : 0.45 * lexical + 0.55 * cosine;
    const score = Math.max(lexical, blended);
    return { ...item, similarity: Number(score.toFixed(3)), semantic: cosine === null ? null : Number(cosine.toFixed(3)) };
  }).filter((item) => item.similarity >= 0.3).sort((a, b) => b.similarity - a.similarity || b.scoreAfter - a.scoreAfter).slice(0, limit);
}
