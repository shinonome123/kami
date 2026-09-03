import { normalizeSource } from "./text.mjs";

export const ASSET_TIERS = Object.freeze({
  CANDIDATE: "candidate",
  WORKING: "working",
  FORMAL: "formal"
});

export const MEMORY_PURPOSES = Object.freeze({
  PRODUCTION: "production",
  QA_AUTHORITY: "qa_authority",
  WORKING_CONSISTENCY: "working_consistency"
});

const INACTIVE_STATUSES = new Set(["archived", "deprecated", "inactive", "rejected", "retired", "superseded"]);
const WILDCARDS = new Set(["*", "all", "any", "general"]);
const DEFAULT_WORKING_WINDOW_MS = 24 * 60 * 60 * 1_000;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function stringArray(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return stringArray(parsed);
    } catch { /* legacy comma-separated scope */ }
    return [...new Set(trimmed.split(",").map((item) => item.trim()).filter(Boolean))];
  }
  return [String(value)];
}

function scopeValues(asset, plural, singular, snakePlural = "", snakeSingular = "") {
  const pluralValue = firstDefined(asset?.[plural], snakePlural ? asset?.[snakePlural] : undefined);
  if (pluralValue !== undefined && pluralValue !== null && pluralValue !== "") return stringArray(pluralValue);
  return stringArray(firstDefined(asset?.[singular], snakeSingular ? asset?.[snakeSingular] : undefined));
}

function dateText(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? String(value) : value.toISOString();
  return String(value).trim() || null;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizedLifecycleStatus(asset) {
  const status = String(firstDefined(asset?.lifecycleStatus, asset?.lifecycle_status, asset?.status, "active")).toLowerCase();
  // `approved`, `pending` and `draft` are approval states in the legacy term
  // schema, not lifecycle states. Approval is checked separately below.
  return INACTIVE_STATUSES.has(status) ? status : "active";
}

function inferredTier(asset, kind, approvalStatus) {
  const explicit = String(firstDefined(asset?.assetTier, asset?.asset_tier, "")).toLowerCase();
  if (Object.values(ASSET_TIERS).includes(explicit)) return explicit;
  if (kind === "translation_memory") {
    if (approvalStatus === "human_approved") return ASSET_TIERS.FORMAL;
    if (approvalStatus === "machine_verified") return ASSET_TIERS.WORKING;
    return ASSET_TIERS.CANDIDATE;
  }
  return approvalStatus === "approved" ? ASSET_TIERS.FORMAL : ASSET_TIERS.CANDIDATE;
}

/**
 * Normalize both the old JSON/Directus shape and the governed shape without
 * granting missing approval. Missing governance metadata gets safe defaults;
 * existing `human_approved` TM and `approved` terms remain usable.
 */
export function normalizeAssetGovernance(asset = {}, { kind = "term" } = {}) {
  const normalizedKind = kind === "tm" ? "translation_memory" : kind;
  const approvalStatus = String(normalizedKind === "translation_memory"
    ? firstDefined(asset.qualityStatus, asset.quality_status, "provisional")
    : firstDefined(asset.approvalStatus, asset.approval_status, asset.status, "draft")).toLowerCase();
  const version = Math.max(1, Math.trunc(Number(firstDefined(asset.version, 1))) || 1);
  const lifecycleStatus = normalizedLifecycleStatus(asset);
  const deprecated = booleanValue(firstDefined(asset.deprecated, asset.isDeprecated, asset.is_deprecated), false)
    || INACTIVE_STATUSES.has(lifecycleStatus)
    || Boolean(firstDefined(asset.deprecatedAt, asset.deprecated_at, asset.supersededBy, asset.superseded_by));
  const scope = {
    locales: scopeValues(asset, "locales", "locale", "target_locales", "target_locale"),
    contentTypes: scopeValues(asset, "contentTypes", "contentType", "content_types", "content_type"),
    domains: scopeValues(asset, "domains", "domain"),
    projects: scopeValues(asset, "projects", "project"),
    channels: scopeValues(asset, "channels", "channel"),
    platforms: scopeValues(asset, "platforms", "platform"),
    regions: scopeValues(asset, "regions", "region")
  };
  return {
    ...asset,
    kind: normalizedKind,
    approvalStatus,
    qualityStatus: normalizedKind === "translation_memory" ? approvalStatus : asset.qualityStatus,
    assetTier: inferredTier(asset, normalizedKind, approvalStatus),
    lifecycleStatus,
    version,
    versionGroupId: String(firstDefined(asset.versionGroupId, asset.version_group_id, asset.assetFamilyId, asset.asset_family_id, asset.logicalId, asset.logical_id, "")),
    caseSensitive: booleanValue(firstDefined(asset.caseSensitive, asset.case_sensitive), false),
    preserveOriginal: booleanValue(firstDefined(asset.preserveOriginal, asset.preserve_original, asset.keepSource, asset.keep_source), false),
    validFrom: dateText(firstDefined(asset.validFrom, asset.valid_from, asset.effectiveFrom, asset.effective_from)),
    validTo: dateText(firstDefined(asset.validTo, asset.valid_to, asset.effectiveTo, asset.effective_to, asset.expiresAt, asset.expires_at)),
    deprecated,
    scope
  };
}

function scopeDimensionMatches(storedValues, requestedValue) {
  if (requestedValue === undefined || requestedValue === null || requestedValue === "") return true;
  const stored = stringArray(storedValues);
  if (!stored.length) return true;
  const requested = stringArray(requestedValue);
  if (!requested.length) return true;
  const folded = new Set(stored.map((value) => value.toLocaleLowerCase()));
  if ([...folded].some((value) => WILDCARDS.has(value))) return true;
  return requested.some((value) => folded.has(value.toLocaleLowerCase()));
}

export function matchesAssetScope(asset, context = {}, options = {}) {
  const normalized = asset?.scope ? asset : normalizeAssetGovernance(asset, options);
  return scopeDimensionMatches(normalized.scope.locales, firstDefined(context.locale, context.targetLocale))
    && scopeDimensionMatches(normalized.scope.contentTypes, context.contentType)
    && scopeDimensionMatches(normalized.scope.domains, context.domain)
    && scopeDimensionMatches(normalized.scope.projects, context.project)
    && scopeDimensionMatches(normalized.scope.channels, context.channel)
    && scopeDimensionMatches(normalized.scope.platforms, context.platform)
    && scopeDimensionMatches(normalized.scope.regions, context.region);
}

/** Return explicit reasons so the UI/audit log can explain every exclusion. */
export function evaluateAssetEffectiveness(asset, context = {}, { kind = "term", now = new Date() } = {}) {
  const normalized = normalizeAssetGovernance(asset, { kind });
  const reasons = [];
  const nowMs = now instanceof Date ? now.valueOf() : Date.parse(now);
  const from = timestamp(normalized.validFrom);
  const to = timestamp(normalized.validTo);
  if (!String(normalized.source || "").trim() || !String(normalized.target || "").trim()) reasons.push("missing_text");
  if (normalized.deprecated || normalized.lifecycleStatus !== "active") reasons.push("deprecated");
  if (Number.isNaN(from)) reasons.push("invalid_valid_from");
  else if (from !== null && from > nowMs) reasons.push("not_yet_valid");
  if (Number.isNaN(to)) reasons.push("invalid_valid_to");
  else if (to !== null && to < nowMs) reasons.push("expired");
  if (from !== null && to !== null && !Number.isNaN(from) && !Number.isNaN(to) && from > to) reasons.push("invalid_valid_range");
  if (!matchesAssetScope(normalized, context, { kind })) reasons.push("scope_mismatch");
  return { asset: normalized, effective: reasons.length === 0, reasons };
}

function versionFamilyKey(asset) {
  if (asset.versionGroupId) return `family:${asset.versionGroupId}`;
  if (asset.id) return `id:${asset.id}`;
  // Missing IDs are common in tests and early JSON assets. Keep separate
  // translations separate; callers can supply versionGroupId when versioning.
  return [asset.kind, asset.locale || asset.scope?.locales?.join("|") || "", asset.source || "", asset.target || ""].join("\u0000");
}

export function selectLatestAssetVersions(assets = []) {
  const winners = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const key = versionFamilyKey(asset);
    const previous = winners.get(key);
    const date = timestamp(firstDefined(asset.updatedAt, asset.date_updated, asset.createdAt, asset.date_created)) || 0;
    const previousDate = previous ? timestamp(firstDefined(previous.updatedAt, previous.date_updated, previous.createdAt, previous.date_created)) || 0 : 0;
    if (!previous || asset.version > previous.version || (asset.version === previous.version && date > previousDate)) winners.set(key, asset);
  }
  return [...winners.values()];
}

export function filterEffectiveTerms(terms = [], context = {}, { now = new Date() } = {}) {
  const approved = [];
  for (const term of Array.isArray(terms) ? terms : []) {
    const result = evaluateAssetEffectiveness(term, context, { kind: "term", now });
    if (!result.effective) continue;
    if (result.asset.approvalStatus !== "approved" || result.asset.assetTier !== ASSET_TIERS.FORMAL) continue;
    approved.push(result.asset);
  }
  return selectLatestAssetVersions(approved);
}

function sameNonEmpty(left, right) {
  return Boolean(left && right && String(left) === String(right));
}

function recentEnough(asset, now, windowMs) {
  const created = timestamp(firstDefined(asset.updatedAt, asset.date_updated, asset.createdAt, asset.date_created));
  if (created === null || Number.isNaN(created)) return false;
  const age = now - created;
  return age >= 0 && age <= windowMs;
}

/**
 * Machine-verified TM is allowed only as a deliberately requested consistency
 * hint. Same-batch references are bounded by the batch itself; other recent
 * references require an explicit task/session binding, or `allowRecentWorking`.
 */
export function isWorkingMemoryAllowed(asset, context = {}, { now = new Date(), workingWindowMs = DEFAULT_WORKING_WINDOW_MS, allowRecentWorking = false } = {}) {
  const nowMs = now instanceof Date ? now.valueOf() : Date.parse(now);
  if (sameNonEmpty(asset.batchId ?? asset.batch_id, context.batchId)) return true;
  const boundToTask = sameNonEmpty(asset.taskId ?? asset.task_id, context.taskId)
    || sameNonEmpty(asset.sessionId ?? asset.session_id, context.sessionId);
  if (boundToTask) {
    const hasTimestamp = firstDefined(asset.updatedAt, asset.date_updated, asset.createdAt, asset.date_created);
    return !hasTimestamp || recentEnough(asset, nowMs, workingWindowMs);
  }
  return allowRecentWorking && recentEnough(asset, nowMs, workingWindowMs);
}

/**
 * The returned `authority` array is always human-approved. `references` adds
 * machine working memory only for WORKING_CONSISTENCY and never upgrades it.
 */
export function partitionTranslationMemories(memories = [], context = {}, options = {}) {
  const purpose = options.purpose || MEMORY_PURPOSES.PRODUCTION;
  const evaluated = [];
  const excluded = [];
  for (const memory of Array.isArray(memories) ? memories : []) {
    const result = evaluateAssetEffectiveness(memory, context, { kind: "translation_memory", now: options.now });
    if (!result.effective) {
      excluded.push({ asset: result.asset, reasons: result.reasons });
      continue;
    }
    evaluated.push(result.asset);
  }
  const current = selectLatestAssetVersions(evaluated);
  const currentSet = new Set(current);
  for (const asset of evaluated) {
    if (!currentSet.has(asset)) excluded.push({ asset, reasons: ["superseded_version"] });
  }

  const formal = [];
  const working = [];
  for (const asset of current) {
    if (asset.qualityStatus === "human_approved" && asset.assetTier === ASSET_TIERS.FORMAL) {
      formal.push(asset);
      continue;
    }
    if (asset.qualityStatus === "machine_verified" && asset.assetTier === ASSET_TIERS.WORKING) {
      if (purpose === MEMORY_PURPOSES.WORKING_CONSISTENCY && isWorkingMemoryAllowed(asset, context, options)) working.push(asset);
      else excluded.push({ asset, reasons: [purpose === MEMORY_PURPOSES.WORKING_CONSISTENCY ? "working_scope_mismatch" : "machine_not_authoritative"] });
      continue;
    }
    excluded.push({ asset, reasons: ["not_human_approved"] });
  }
  return {
    purpose,
    formal,
    working,
    authority: formal,
    references: purpose === MEMORY_PURPOSES.WORKING_CONSISTENCY ? [...formal, ...working] : formal,
    excluded
  };
}

function comparableText(value, caseSensitive) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase();
}

export function textContainsTerm(text, phrase, { caseSensitive = false } = {}) {
  const needle = comparableText(phrase, caseSensitive);
  return Boolean(needle) && comparableText(text, caseSensitive).includes(needle);
}

export function findTermSourceMatch(text, term, { includeAliases = true } = {}) {
  const normalized = normalizeAssetGovernance(term, { kind: "term" });
  const variants = [normalized.source, ...(includeAliases ? stringArray(normalized.aliases) : [])].filter(Boolean);
  const variant = variants.find((value) => textContainsTerm(text, value, { caseSensitive: normalized.caseSensitive }));
  return variant ? { matched: true, variant, caseSensitive: normalized.caseSensitive } : { matched: false, variant: "", caseSensitive: normalized.caseSensitive };
}

export function expectedTermTarget(term, { matchedSource = "" } = {}) {
  const normalized = normalizeAssetGovernance(term, { kind: "term" });
  return normalized.preserveOriginal ? String(matchedSource || normalized.source || "").trim() : String(normalized.target || "").trim();
}

function excerpt(text, needle, radius = 100) {
  const value = String(text || "").trim();
  if (value.length <= radius * 2 + 20) return value;
  const index = needle ? value.indexOf(String(needle)) : -1;
  const start = Math.max(0, index < 0 ? 0 : index - radius);
  const end = Math.min(value.length, index < 0 ? radius * 2 : index + String(needle).length + radius);
  return `${start ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}

function candidateAction(sourceTerm, targetTerm, existingTerms, originTermId = "") {
  const sourceKey = normalizeSource(sourceTerm);
  const targetKey = normalizeSource(targetTerm);
  const origin = originTermId ? existingTerms.find((term) => String(term.id || "") === String(originTermId)) : null;
  if (origin) {
    const knownSources = [origin.source, ...stringArray(origin.aliases)].map(normalizeSource);
    if (normalizeSource(origin.target) !== targetKey) return "resolve_conflict";
    return knownSources.includes(sourceKey) ? "add_usage_evidence" : "add_alias";
  }
  const sameSource = existingTerms.find((term) => normalizeSource(term.source) === sourceKey);
  if (sameSource && normalizeSource(sameSource.target) === targetKey) return "add_usage_evidence";
  if (sameSource) return "resolve_conflict";
  const sameTarget = existingTerms.find((term) => normalizeSource(term.target) === targetKey);
  return sameTarget ? "add_alias" : "create_term";
}

/**
 * Turn evidence from a human-approved final translation into review candidates.
 * No candidate returned by this function is a formal term, even if untrusted
 * suggestion input contains `status: approved`.
 */
export function deriveTermCandidatesFromHumanFinal({
  locale,
  source,
  finalTranslation,
  matches = [],
  suggestions = [],
  existingTerms = [],
  contentType = "general",
  domain = "general",
  project = "default",
  channel = "",
  platform = "",
  region = "",
  batchId = "",
  taskId = "",
  sourceFile = "",
  sourceRow = null,
  minimumSuggestionConfidence = 0.88,
  maximumSourceLength = 80,
  maximumTargetLength = 120,
  maximumCandidates = 50
} = {}) {
  if (!String(locale || "").trim()) throw new TypeError("人工终稿提取术语候选时必须指定目标语种");
  const sourceText = String(source || "").trim();
  const targetText = String(finalTranslation || "").trim();
  if (!sourceText || !targetText) return [];
  const localeTerms = (Array.isArray(existingTerms) ? existingTerms : []).filter((term) => !term.locale || term.locale === locale);
  const candidates = [];
  const keys = new Set();

  const add = ({ sourceTerm, targetTerm, confidence, evidenceType, reason = "", matchMode = "", originTermId = "", caseSensitive = false, preserveOriginal = false }) => {
    const cleanSource = String(sourceTerm || "").trim();
    const cleanTarget = String(targetTerm || "").trim();
    if (!cleanSource || !cleanTarget) return;
    if ([...cleanSource].length > maximumSourceLength || [...cleanTarget].length > maximumTargetLength) return;
    if (!textContainsTerm(sourceText, cleanSource, { caseSensitive })) return;
    if (!textContainsTerm(targetText, cleanTarget, { caseSensitive: preserveOriginal ? caseSensitive : false })) return;
    const key = `${locale}\u0000${normalizeSource(cleanSource)}\u0000${normalizeSource(cleanTarget)}`;
    if (keys.has(key) || candidates.length >= maximumCandidates) return;
    keys.add(key);
    candidates.push({
      candidateKey: key,
      assetType: "term",
      assetTier: ASSET_TIERS.CANDIDATE,
      status: "pending",
      approvalStatus: "pending",
      requiresHumanApproval: true,
      proposalAction: candidateAction(cleanSource, cleanTarget, localeTerms, originTermId),
      source: cleanSource,
      target: cleanTarget,
      locale,
      aliases: [],
      forbidden: [],
      domains: [domain || "general"],
      contentTypes: [contentType || "general"],
      projects: [project || "default"],
      channels: channel ? [channel] : [],
      platforms: platform ? [platform] : [],
      regions: region ? [region] : [],
      enforcement: "preferred",
      caseSensitive: Boolean(caseSensitive),
      preserveOriginal: Boolean(preserveOriginal),
      version: 1,
      validFrom: null,
      validTo: null,
      confidence: Number(Math.max(0, Math.min(1, Number(confidence) || 0)).toFixed(3)),
      provenance: `human-final:${evidenceType}`,
      batchId: String(batchId || ""),
      taskId: String(taskId || ""),
      sourceFile: String(sourceFile || ""),
      sourceRow: Number(sourceRow) || null,
      originTermId: String(originTermId || ""),
      evidence: {
        type: evidenceType,
        reason: String(reason || "").slice(0, 300),
        matchMode: String(matchMode || ""),
        sourceExcerpt: excerpt(sourceText, cleanSource),
        targetExcerpt: excerpt(targetText, cleanTarget)
      }
    });
  };

  for (const match of Array.isArray(matches) ? matches : []) {
    const term = normalizeAssetGovernance(match?.term || {}, { kind: "term" });
    if (term.id && !localeTerms.some((item) => String(item.id || "") === String(term.id))) localeTerms.push(term);
    const matchedSource = String(match?.matchPhrase || match?.variant || findTermSourceMatch(sourceText, term).variant || term.source || "").trim();
    const targetTerm = expectedTermTarget(term, { matchedSource });
    add({
      sourceTerm: matchedSource,
      targetTerm,
      confidence: match?.mode === "exact" ? 1 : Number(match?.score) || 0,
      evidenceType: "confirmed_term_hit",
      reason: "人工终稿实际采用了已识别术语",
      matchMode: match?.mode || "exact",
      originTermId: term.id,
      caseSensitive: term.caseSensitive,
      preserveOriginal: term.preserveOriginal
    });
  }

  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    const confidence = Number(suggestion?.confidence);
    if (!Number.isFinite(confidence) || confidence < minimumSuggestionConfidence) continue;
    const sourceTerm = String(suggestion?.matchedSource || suggestion?.sourceTerm || suggestion?.source || "").trim();
    const targetTerm = String(suggestion?.replacement || suggestion?.target || "").trim();
    add({
      sourceTerm,
      targetTerm,
      confidence,
      evidenceType: "high_confidence_suggestion",
      reason: suggestion?.reason || "高置信术语建议已在人工终稿中得到实际使用",
      matchMode: suggestion?.matchMode || "model",
      originTermId: suggestion?.termId || suggestion?.originTermId || "",
      caseSensitive: booleanValue(firstDefined(suggestion?.caseSensitive, suggestion?.case_sensitive), false),
      preserveOriginal: booleanValue(firstDefined(suggestion?.preserveOriginal, suggestion?.preserve_original), false)
    });
  }
  return candidates;
}
