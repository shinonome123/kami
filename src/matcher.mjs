import { normalizeSource, similarity } from "./text.mjs";

function scopeBoost(term, contentType, domain) {
  let boost = 0;
  if (term.contentTypes?.includes(contentType)) boost += 0.16;
  else if (term.contentTypes?.includes("general")) boost += 0.04;
  if (term.domains?.includes(domain)) boost += 0.12;
  else if (term.domains?.includes("general")) boost += 0.03;
  if (term.status === "approved") boost += 0.08;
  return boost;
}

function unorderedCharacterSimilarity(left, right) {
  const leftCounts = new Map();
  const rightCounts = new Map();
  for (const character of [...left].filter((value) => !/\s/u.test(value))) leftCounts.set(character, (leftCounts.get(character) || 0) + 1);
  for (const character of [...right].filter((value) => !/\s/u.test(value))) rightCounts.set(character, (rightCounts.get(character) || 0) + 1);
  const overlap = [...leftCounts].reduce((sum, [character, count]) => sum + Math.min(count, rightCounts.get(character) || 0), 0);
  const maximum = Math.max([...leftCounts.values()].reduce((sum, count) => sum + count, 0), [...rightCounts.values()].reduce((sum, count) => sum + count, 0));
  return maximum ? overlap / maximum : 0;
}

export function matchTerms(text, assets, { contentType = "general", domain = "general", limit = 20 } = {}) {
  if (!assets?.locale) throw new Error("Asset collection must have an explicit locale");
  const normalizedText = normalizeSource(text);
  const matches = [];
  for (const term of assets.terms ?? []) {
    if (term.status !== "approved") continue;
    const variants = [term.source, ...(term.aliases ?? [])].filter(Boolean);
    let best = null;
    for (const variant of variants) {
      const normalizedVariant = normalizeSource(variant);
      if (!normalizedVariant) continue;
      if (normalizedText.includes(normalizedVariant)) {
        const exactness = normalizedVariant === normalizedText ? 1 : 0.92;
        const candidate = { mode: "exact", variant, matchPhrase: variant, score: exactness };
        if (!best || candidate.score > best.score) best = candidate;
        continue;
      }
      if (normalizedVariant.length >= 3) {
        const windows = [];
        const characters = [...normalizedText];
        const size = [...normalizedVariant].length;
        for (let index = 0; index <= characters.length - Math.max(2, size - 1); index += 1) {
          windows.push(characters.slice(index, index + size).join(""));
        }
        for (const window of windows) {
          const editScore = similarity(window, normalizedVariant);
          const unorderedScore = unorderedCharacterSimilarity(window, normalizedVariant);
          let candidate = null;
          if (editScore >= 0.78) candidate = { mode: "fuzzy", variant, matchPhrase: window, score: editScore * 0.82 };
          else if ((unorderedScore === 1 && size >= 4 && editScore + Number.EPSILON >= 0.2) || (unorderedScore >= 0.86 && editScore >= 0.38)) {
            candidate = { mode: "smart", variant, matchPhrase: window, score: (unorderedScore * 0.72 + editScore * 0.18) * 0.82 };
          }
          if (candidate && (!best || candidate.score > best.score)) best = candidate;
        }
      }
    }
    if (!best) continue;
    matches.push({
      ...best,
      score: Math.min(1, best.score + scopeBoost(term, contentType, domain)),
      locale: assets.locale,
      term
    });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
