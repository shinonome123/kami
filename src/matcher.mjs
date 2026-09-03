import { expectedTermTarget, filterEffectiveTerms } from "./asset-governance.mjs";
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

function isContentScopeCompatible(term, contentType) {
  const scopes = Array.isArray(term.contentTypes) ? term.contentTypes.filter(Boolean) : [];
  return !scopes.length || scopes.includes(contentType) || scopes.includes("general");
}

/**
 * Same folding as `normalizeSource` minus the case fold, so a case-sensitive
 * term can be compared without lowercasing the text first.
 */
function foldPreservingCase(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * @param options.project/channel/platform/region  投放上下文。术语上标注的适用
 *   项目、渠道、平台和地区据此生效；调用方不传就等于不限定，与旧行为一致。
 * @param options.now  判定术语有效期的时点。过期、未生效和已废弃的术语不再参与
 *   匹配，因此它们既不会被强制要求，也不会再触发 QA 报错。
 *
 * 内容语体与业务领域不参与准入过滤：跨语体的术语仍会被匹配出来并标记
 * `scopeMismatch`，交由人工判断，这是既有约定。
 */
export function matchTerms(text, assets, {
  contentType = "general",
  domain = "general",
  limit = 20,
  project = "",
  channel = "",
  platform = "",
  region = "",
  now = new Date()
} = {}) {
  if (!assets?.locale) throw new Error("Asset collection must have an explicit locale");
  const normalizedText = normalizeSource(text);
  const caseSensitiveText = foldPreservingCase(text);
  const sourceCharacters = new Set([...normalizedText]);
  const matches = [];
  // 治理准入：只保留已批准、正式层级、当前有效且投放范围命中的术语版本。
  const governedTerms = filterEffectiveTerms(assets.terms ?? [], {
    locale: assets.locale, project, channel, platform, region
  }, { now });
  for (const term of governedTerms) {
    const caseSensitive = Boolean(term.caseSensitive);
    const variants = [term.source, ...(term.aliases ?? [])].filter(Boolean);
    let best = null;
    for (const variant of variants) {
      const normalizedVariant = normalizeSource(variant);
      if (!normalizedVariant) continue;
      if (normalizedText.includes(normalizedVariant)) {
        // 区分大小写的术语只有大小写也一致才算精确命中；仅拼写相同的，降级成
        // 待确认提示，让人工决定 iOS / ios 是不是同一个东西。
        const caseMatched = !caseSensitive || caseSensitiveText.includes(foldPreservingCase(variant));
        const exactness = normalizedVariant === normalizedText ? 1 : 0.92;
        const candidate = caseMatched
          ? { mode: "exact", variant, matchPhrase: variant, score: exactness }
          : { mode: "fuzzy", variant, matchPhrase: variant, score: exactness * 0.82, caseMismatch: true };
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
      scopeMismatch: !isContentScopeCompatible(term, contentType),
      caseSensitive,
      // 保留原文的术语，期望译文里出现的是原文形态本身，而不是 target 字段。
      expectedTarget: expectedTermTarget(term, { matchedSource: best.matchPhrase || term.source }),
      preserveOriginal: Boolean(term.preserveOriginal),
      term
    });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
