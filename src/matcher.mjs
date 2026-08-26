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

/**
 * 术语能不能进入模糊/智能匹配的廉价前置判断。
 *
 * 模糊路径要求编辑相似度 ≥0.78，智能路径要求无序字符相似度 ≥0.86（或全字符命中），
 * 两者都蕴含"术语的大部分字符必须出现在原文里"。所以先按字符集合算一次重合度，
 * 低于 0.6 的直接跳过——这个界远低于两条真实阈值，不会改变任何匹配结果。
 *
 * 不做这一步的代价是实测出来的：滑窗 × 每窗一次 Levenshtein + 一次无序比较，
 * 单句耗时随术语量线性上涨到 1 万条 10 秒、5 万条 48 秒，模型还没开始调用。
 */
function couldFuzzyMatch(sourceCharacters, normalizedVariant) {
  const variantCharacters = [...normalizedVariant];
  if (!variantCharacters.length) return false;
  let shared = 0;
  for (const character of variantCharacters) if (sourceCharacters.has(character)) shared += 1;
  return shared / variantCharacters.length >= 0.6;
}

export function matchTerms(text, assets, { contentType = "general", domain = "general", limit = 20 } = {}) {
  if (!assets?.locale) throw new Error("Asset collection must have an explicit locale");
  const normalizedText = normalizeSource(text);
  const sourceCharacters = new Set([...normalizedText]);
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
      if (normalizedVariant.length >= 3 && couldFuzzyMatch(sourceCharacters, normalizedVariant)) {
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
