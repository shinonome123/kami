import { CONTENT_TYPES, LOCALES } from "./config.mjs";
import { punctuationGuidance } from "./orthography.mjs";
import { detectRhymeLike, extractProtectedTokens } from "./text.mjs";
import { normalizeBatchReferences } from "./batch-verse.mjs";
import { contentTypeDirective, registerPolicyFor } from "./register-classifier.mjs";

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

export function buildContextPack({ source, locale, classification, matches, domain = "general", neighborContext = "", styleProfile = null, translationSkill = null, qaGuidance = [], userProfile = null, translationReferences = [], batchVerse = null, batchReferences = [], factSchema = null, titleOverrides = null }) {
  const required = matches.filter((item) => item.mode === "exact" && item.term.enforcement === "required" && !item.scopeMismatch);
  const preferred = matches.filter((item) => item.mode !== "exact" || item.term.enforcement !== "required" || item.scopeMismatch);
  const defaultRegister = CONTENT_TYPES[classification.contentType].register;
  return {
    sourceLanguage: "Simplified Chinese",
    targetLocale: locale,
    targetLanguage: LOCALES[locale].language,
    domain,
    contentType: classification.contentType,
    contentTypeLabel: CONTENT_TYPES[classification.contentType].label,
    contentTags: Array.isArray(classification.contentTags) ? classification.contentTags.slice(0, 8) : [],
    register: defaultRegister,
    translationReferences: Array.isArray(translationReferences) ? translationReferences.slice(0, 5).map((item) => ({
      source: item.source,
      target: item.target,
      similarity: Number(item.similarity) || 0,
      qualityStatus: item.qualityStatus || "",
      contentType: item.contentType || "general",
      contentTags: Array.isArray(item.contentTags) ? item.contentTags.slice(0, 8) : [],
      provenance: item.provenance || "",
      sourceFile: item.sourceFile || "",
      sourceRow: item.sourceRow || null
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
      generationRules: Array.isArray(styleProfile?.rules) ? styleProfile.rules.slice(0, 30) : [],
      // 语体写作指令与语域容忍度来自同一张表：生成按它写，事后按它判。
      contentTypeDirective: contentTypeDirective(classification.contentType),
      registerPolicy: registerPolicyFor(classification.contentType, styleProfile?.reviewRubric?.registerPolicy || null),
      reviewRubric: styleProfile?.reviewRubric || {
        accuracy: "不得漏译、增译、误译或改变事实与承诺强度",
        fluency: "目标语言应自然、通顺且没有翻译腔",
        terminology: "正式术语、禁用译法与保留原文规则必须执行",
        style: "遵守当前语体、品牌语气和正反例",
        locale: "符合目标地区书写、日期、标点及文化习惯",
        platform: "平台名、字符限制、占位符和渠道规则必须正确"
      },
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
    punctuation: punctuationGuidance(locale, titleOverrides),
    requiredTerms: required.map(({ term }) => ({ source: term.source, target: term.target, forbidden: term.forbidden, note: term.note })),
    preferredTerms: preferred.map(({ term, mode, matchPhrase, score, scopeMismatch }) => ({
      source: term.source,
      matchedSource: matchPhrase,
      target: term.target,
      matchMode: mode,
      confidence: Number(score.toFixed(2)),
      note: scopeMismatch
        ? `该术语不属于当前主分类，仅作跨场景参考，不得强制采用。${term.note || ""}`
        : (mode === "exact" ? term.note : `疑似术语，仅供参考，不得未经判断强制替换。${term.note || ""}`)
    })),
    protectedTokens: extractProtectedTokens(source),
    factSchema: factSchema ? {
      version: String(factSchema.version || "1.0"),
      facts: Array.isArray(factSchema.facts) ? factSchema.facts.slice(0, 80) : [],
      limits: Array.isArray(factSchema.limits) ? factSchema.limits.slice(0, 20) : [],
      summary: factSchema.summary || {}
    } : null,
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
