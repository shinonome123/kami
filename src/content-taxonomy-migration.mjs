import { classifyContent, inferContentTags } from "./classifier.mjs";
import { CONTENT_TAGS, CONTENT_TYPES } from "./config.mjs";
import { normalizeSource } from "./text.mjs";

const STRONG_NEW_TYPES = new Set(["verse", "narrative", "codex", "store", "tutorial"]);
const AMBIGUOUS_SHORT_TYPES = new Set(["item_name", "ui"]);
const TAG_OWNER = new Map(Object.entries(CONTENT_TAGS).flatMap(([type, tags]) => Object.keys(tags).map((tag) => [tag, type])));
const STYLE_TEXT_SIGNALS = Object.freeze({
  marketing: [/促销|促銷|折扣|宣传文案|宣傳文案|节庆祝福|節慶祝福|活动宣发|活動宣發/giu],
  store: [/游戏商店|遊戲商店|商品描述|购买入口|購買入口|游戏本体|遊戲本體|版本名|升级包|升級包|DLC|追加内容|追加內容/giu],
  announcement: [/公告类|公告類|维护公告|維護公告|服务通知|服務通知/gu],
  verse: [/诗句|詩句|对偶句|對偶句|对仗|對仗|韵律|韻律|分行诗|分行詩/gu],
  codex: [/图鉴|圖鑑|设定集|設定集|人物志|怪物志|人物小传|人物小傳/gu],
  narrative: [/叙事文本|敘事文本|旁白语境|旁白語境|说书|說書|故事叙述|故事敘述/gu],
  dialogue: [/剧情对白|劇情對白|角色对白|角色對白|角色台词|角色台詞/gu],
  tutorial: [/操作指引|操作指南|新手引导|新手引導|教程文本|教學文本/gu]
});

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
}

function sameArray(left, right) {
  return JSON.stringify(stringArray(left).sort()) === JSON.stringify(stringArray(right).sort());
}

/**
 * Conservatively reclassify a historical memory/evidence row.
 * Existing specific scopes are preserved unless a strong new family is detected.
 */
export function classifyExistingAsset(record = {}) {
  const source = String(record.source || "").trim();
  const sourceFile = String(record.source_file || record.sourceFile || "");
  const current = Object.hasOwn(CONTENT_TYPES, record.content_type || record.contentType)
    ? String(record.content_type || record.contentType)
    : "general";
  const inferred = classifyContent(source, "auto", { sourceFile });
  let contentType = current;
  let reason = "preserved-existing-scope";

  if (!source) {
    reason = "empty-source";
  } else if (inferred.contentType === "verse" && inferred.confidence >= 0.9) {
    contentType = "verse";
    reason = "strong-verse-structure";
  } else if (/Portraits|影神图|影神圖|图鉴|圖鑑|codex/i.test(sourceFile)) {
    contentType = "codex";
    reason = "source-file-codex";
  } else if (current === "general") {
    const usable = inferred.confidence >= 0.84 && !AMBIGUOUS_SHORT_TYPES.has(inferred.contentType);
    if (usable) {
      contentType = inferred.contentType;
      reason = "high-confidence-unclassified-row";
    }
  } else if (STRONG_NEW_TYPES.has(inferred.contentType) && inferred.confidence >= 0.9) {
    contentType = inferred.contentType;
    reason = "strong-new-family";
  }

  const contentTags = inferContentTags(source, contentType, { sourceFile });
  return {
    contentType,
    contentTags,
    changed: contentType !== current || !sameArray(contentTags, record.content_tags || record.contentTags),
    reason,
    inferred
  };
}

export function aggregateScope(records = []) {
  const typeCounts = new Map();
  const tagCounts = new Map();
  for (const record of records) {
    const type = record.contentType || record.content_type || "general";
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    for (const tag of stringArray(record.contentTags || record.content_tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const types = [...typeCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = records.length;
  return {
    total,
    typeCounts: Object.fromEntries(types),
    tagCounts: Object.fromEntries(tags),
    dominantType: types[0]?.[0] || "general",
    dominantShare: total ? (types[0]?.[1] || 0) / total : 0,
    contentTags: tags.slice(0, 8).map(([tag]) => tag)
  };
}

/** Classify the intended use expressed by a style profile's own rules. */
export function inferStyleScopeFromText(text = "") {
  const value = String(text || "");
  const counts = [];
  for (const [type, patterns] of Object.entries(STYLE_TEXT_SIGNALS)) {
    const count = patterns.reduce((sum, pattern) => sum + (value.match(pattern)?.length || 0), 0);
    if (count) counts.push([type, count]);
  }
  counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  return {
    total,
    dominantType: counts[0]?.[0] || "general",
    dominantShare: total ? (counts[0]?.[1] || 0) / total : 0,
    typeCounts: Object.fromEntries(counts)
  };
}

/** Infer a term's valid primary scopes from the localized rows where it occurs. */
export function inferTermScopes(term = {}, records = []) {
  const fallback = () => {
    const currentTypes = stringArray(term.content_types || term.contentTypes || ["general"]);
    const provenance = String(term.provenance || term.source_file || term.sourceFile || "");
    const current = currentTypes.find((type) => type !== "general") || currentTypes[0] || "general";
    let classified = classifyExistingAsset({ source: term.source, content_type: current, source_file: provenance });
    if (current === "general" && classified.contentType === "general" && /Epilogue|结局|結局/i.test(provenance)) {
      classified = { contentType: "dialogue", contentTags: inferContentTags(term.source, "dialogue", { sourceFile: provenance }) };
    } else if (current === "general" && classified.contentType === "general" && /公告|notice/i.test(provenance)) {
      classified = { contentType: "announcement", contentTags: inferContentTags(term.source, "announcement", { sourceFile: provenance }) };
    }
    const contentTypes = classified.contentType !== "general" ? [classified.contentType] : currentTypes;
    const allowed = new Set(contentTypes);
    const inferredTags = classified.contentTags?.length ? classified.contentTags : stringArray(term.content_tags || term.contentTags);
    return { contentTypes, contentTags: inferredTags.filter((tag) => allowed.has(TAG_OWNER.get(tag))), evidenceCount: 0 };
  };
  const variants = [term.source, ...stringArray(term.aliases)]
    .map(normalizeSource)
    .filter((value) => [...value].length >= 2);
  if (!variants.length) return fallback();

  const matched = records.filter((record) => {
    const source = record.normalizedSource || normalizeSource(record.source);
    return source && variants.some((variant) => source.includes(variant));
  });
  if (!matched.length) return fallback();

  const scope = aggregateScope(matched);
  const rankedTypes = Object.entries(scope.typeCounts).filter(([type]) => type !== "general");
  const threshold = Math.max(2, Math.ceil(scope.total * 0.2));
  const selected = rankedTypes
    .filter(([, count], index) => index === 0 || count >= threshold)
    .slice(0, 4)
    .map(([type]) => type);
  const contentTypes = selected.length ? selected : [scope.dominantType || "general"];
  const allowed = new Set(contentTypes);
  return {
    contentTypes,
    contentTags: scope.contentTags.filter((tag) => allowed.has(TAG_OWNER.get(tag))),
    evidenceCount: matched.length
  };
}
