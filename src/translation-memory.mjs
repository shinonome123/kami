import { normalizeSource, similarity } from "./text.mjs";

const QUALITY_WEIGHT = Object.freeze({
  human_approved: 0.12,
  machine_verified: 0.06,
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

export function rankTranslationMemories(source, memories = [], { limit = 5 } = {}) {
  const normalized = normalizeSource(source);
  return memories
    .filter((memory) => memory.source && memory.target && ["human_approved", "machine_verified"].includes(memory.qualityStatus))
    .map((memory) => {
      const edit = similarity(normalized, normalizeSource(memory.source));
      const overlap = tokenOverlap(normalized, memory.source);
      const exact = normalized === normalizeSource(memory.source) ? 1 : 0;
      const quality = QUALITY_WEIGHT[memory.qualityStatus] ?? 0;
      const score = Math.min(1, exact * 0.45 + edit * 0.38 + overlap * 0.17 + quality);
      return { ...memory, similarity: Number(score.toFixed(3)) };
    })
    .filter((memory) => memory.similarity >= 0.28)
    .sort((a, b) => b.similarity - a.similarity || (b.qaScore || 0) - (a.qaScore || 0))
    .slice(0, limit);
}

export function rankQaCases(source, cases = [], { limit = 3 } = {}) {
  const normalized = normalizeSource(source);
  return cases.map((item) => ({
    ...item,
    similarity: Number((similarity(normalized, normalizeSource(item.source)) * 0.72 + tokenOverlap(normalized, item.source) * 0.28).toFixed(3))
  })).filter((item) => item.similarity >= 0.3).sort((a, b) => b.similarity - a.similarity || b.scoreAfter - a.scoreAfter).slice(0, limit);
}
