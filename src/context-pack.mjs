import { CONTENT_TYPES, LOCALES } from "./config.mjs";
import { extractProtectedTokens } from "./text.mjs";

function normalizeNeighborContext(neighborContext) {
  if (typeof neighborContext === "string") return { previous: "", next: "", note: neighborContext };
  return {
    previous: String(neighborContext?.previous || ""),
    next: String(neighborContext?.next || ""),
    note: String(neighborContext?.note || ""),
    document: String(neighborContext?.document || ""),
    segmentIndex: Number(neighborContext?.segmentIndex) || undefined,
    segmentCount: Number(neighborContext?.segmentCount) || undefined
  };
}

export function buildContextPack({ source, locale, classification, matches, domain = "general", neighborContext = "", styleProfile = null }) {
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
    styleProfile: {
      id: String(styleProfile?.id || "content-type-default"),
      name: String(styleProfile?.name || CONTENT_TYPES[classification.contentType].label),
      source: String(styleProfile?.source || "content-type"),
      instruction: String(styleProfile?.instruction || defaultRegister)
    },
    localeInstruction: LOCALES[locale].defaultInstruction,
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
    neighborContext: normalizeNeighborContext(neighborContext),
    source
  };
}
