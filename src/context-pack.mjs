import { CONTENT_TYPES, LOCALES } from "./config.mjs";
import { punctuationGuidance } from "./orthography.mjs";
import { detectRhymeLike, extractProtectedTokens } from "./text.mjs";
import { normalizeBatchReferences } from "./batch-verse.mjs";

function normalizeNeighborContext(neighborContext) {
  if (typeof neighborContext === "string") return { previous: "", next: "", note: neighborContext };
  const normalizeItems = (items) => Array.isArray(items) ? items.slice(0, 20).map((item) => ({
    label: String(item?.label || "补充信息"),
    value: String(item?.value || ""),
    role: String(item?.role || "context")
  })).filter((item) => item.value) : [];
  return {
    previous: String(neighborContext?.previous || ""),
    next: String(neighborContext?.next || ""),
    note: String(neighborContext?.note || ""),
    document: String(neighborContext?.document || ""),
    sheet: String(neighborContext?.sheet || ""),
    row: Number(neighborContext?.row) || undefined,
    sourceColumn: String(neighborContext?.sourceColumn || ""),
    metadata: normalizeItems(neighborContext?.metadata),
    referenceTranslations: normalizeItems(neighborContext?.referenceTranslations),
    segmentIndex: Number(neighborContext?.segmentIndex) || undefined,
    segmentCount: Number(neighborContext?.segmentCount) || undefined
  };
}

export function buildContextPack({ source, locale, classification, matches, domain = "general", neighborContext = "", styleProfile = null, translationSkill = null, qaGuidance = [], userProfile = null, translationReferences = [], batchVerse = null, batchReferences = [] }) {
  const required = matches.filter((item) => item.mode === "exact" && item.term.enforcement === "required");
  const preferred = matches.filter((item) => item.mode !== "exact" || item.term.enforcement !== "required");
  const defaultRegister = CONTENT_TYPES[classification.contentType].register;
  return {
    sourceLanguage: "Simplified Chinese",
    targetLocale: locale,
    targetLanguage: LOCALES[locale].language,
    domain,
    contentType: classification.contentType,
    contentTypeLabel: CONTENT_TYPES[classification.contentType].label,
    register: defaultRegister,
    translationReferences: Array.isArray(translationReferences) ? translationReferences.slice(0, 5).map((item) => ({
      source: item.source,
      target: item.target,
      similarity: Number(item.similarity) || 0,
      qualityStatus: item.qualityStatus || ""
    })) : [],
    userProfile: userProfile ? {
      id: String(userProfile.id || ""),
      name: String(userProfile.name || "译者画像"),
      instruction: String(userProfile.instruction || ""),
      version: Number(userProfile.version) || 1,
      examples: Array.isArray(userProfile.examples) ? userProfile.examples.slice(0, 4) : []
    } : null,
    styleProfile: {
      id: String(styleProfile?.id || "content-type-default"),
      name: String(styleProfile?.name || CONTENT_TYPES[classification.contentType].label),
      source: String(styleProfile?.source || "content-type"),
      instruction: String(styleProfile?.instruction || defaultRegister),
      version: Number(styleProfile?.version) || 1,
      examples: Array.isArray(styleProfile?.examples) ? styleProfile.examples.slice(0, 8) : []
    },
    translationSkill: translationSkill ? {
      id: String(translationSkill.id || ""),
      name: String(translationSkill.name || "翻译技能"),
      version: Number(translationSkill.version) || 1,
      promptVersion: String(translationSkill.promptVersion || ""),
      instruction: String(translationSkill.strategy?.prompting?.additionalInstruction || translationSkill.strategy?.instruction || ""),
      additionalRules: Array.isArray(translationSkill.strategy?.prompting?.additionalRules || translationSkill.strategy?.additionalRules)
        ? (translationSkill.strategy.prompting?.additionalRules || translationSkill.strategy.additionalRules).slice(0, 12).map(String)
        : [],
      strategy: translationSkill.strategy || {}
    } : null,
    localeInstruction: LOCALES[locale].defaultInstruction,
    punctuation: punctuationGuidance(locale),
    requiredTerms: required.map(({ term }) => ({ source: term.source, target: term.target, forbidden: term.forbidden, note: term.note })),
    preferredTerms: preferred.map(({ term, mode, matchPhrase, score }) => ({
      source: term.source,
      matchedSource: matchPhrase,
      target: term.target,
      matchMode: mode,
      confidence: Number(score.toFixed(2)),
      note: mode === "exact" ? term.note : `疑似术语，仅供参考，不得未经判断强制替换。${term.note || ""}`
    })),
    protectedTokens: extractProtectedTokens(source),
    rhymeLike: detectRhymeLike(source),
    batchVerse: batchVerse?.active ? { active: true, shape: String(batchVerse.shape || ""), matchingCount: Math.max(0, Number(batchVerse.matchingCount) || 0) } : null,
    batchReferences: normalizeBatchReferences(batchReferences),
    qaGuidance: Array.isArray(qaGuidance) ? qaGuidance.slice(0, 3).map((item) => ({
      id: item.id,
      source: item.source,
      rejectedTranslation: item.rejectedTranslation,
      correctedTranslation: item.correctedTranslation,
      issues: item.issues,
      similarity: item.similarity
    })) : [],
    neighborContext: normalizeNeighborContext(neighborContext),
    source
  };
}
