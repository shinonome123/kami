import { textContainsTerm } from "./asset-governance.mjs";
import { selectActiveGoldSamples, selectActiveRegressionCases } from "./gold-regression.mjs";
import { calculateQualityMetrics } from "./quality-metrics.mjs";
import { normalizeSource, similarity } from "./text.mjs";

/**
 * Deterministic release gate over fixed quality assets. Every check here is
 * reproducible without a model call: the gate decides whether a candidate may
 * be promoted, and a model is only ever used upstream to produce the outputs
 * this module scores.
 */
export const QUALITY_GATE_SCHEMA_VERSION = 1;
export const GATE_DECISIONS = Object.freeze(["pass", "block", "insufficient"]);

export const DEFAULT_GATE_THRESHOLDS = Object.freeze({
  regressionPassRate: 1,
  minimumRegressionCases: 1,
  minimumGoldSamples: 5,
  goldTermAccuracy: 0.98,
  goldFactAccuracy: 1,
  goldSimilarity: 0.6,
  allowMissingGold: true
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function round(value, digits = 4) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

/**
 * A required term is satisfied by its approved target or any accepted variant.
 * `preserveSource` inverts the expectation: the source form must survive
 * untranslated, which is exactly how brand and SKU strings are protected.
 */
export function checkRequiredTerms(translation, requiredTerms = []) {
  return (Array.isArray(requiredTerms) ? requiredTerms : []).map((term) => {
    const caseSensitive = Boolean(term?.caseSensitive);
    const expected = term?.preserveSource ? text(term?.source) : text(term?.target);
    const accepted = term?.preserveSource
      ? [text(term?.source)]
      : [text(term?.target), ...(Array.isArray(term?.acceptedTargets) ? term.acceptedTargets.map(text) : [])];
    const variants = accepted.filter(Boolean);
    const matched = variants.some((variant) => textContainsTerm(translation, variant, { caseSensitive }));
    return {
      source: text(term?.source),
      expected,
      acceptedTargets: variants,
      caseSensitive,
      preserveSource: Boolean(term?.preserveSource),
      matched,
      correct: matched
    };
  });
}

/** Fact anchors are compared literally: a date or platform must reappear intact. */
export function checkFactAnchors(translation, facts = []) {
  return (Array.isArray(facts) ? facts : []).map((fact, index) => {
    const expected = text(fact?.expectedValue) || text(fact?.sourceValue);
    const passed = Boolean(expected) && textContainsTerm(translation, expected, { caseSensitive: false });
    return {
      id: text(fact?.id) || `fact-${index + 1}`,
      type: text(fact?.type) || "fact",
      expected,
      critical: fact?.critical !== false,
      passed,
      correct: passed
    };
  });
}

function forbiddenHits(translation, forbidden = []) {
  return (Array.isArray(forbidden) ? forbidden : [])
    .map(text)
    .filter((phrase) => phrase && textContainsTerm(translation, phrase, { caseSensitive: false }));
}

function missingProtectedTokens(translation, tokens = []) {
  return (Array.isArray(tokens) ? tokens : [])
    .map(text)
    .filter((token) => token && !String(translation).includes(token));
}

function bestReferenceSimilarity(translation, references = []) {
  const candidates = (Array.isArray(references) ? references : []).map(text).filter(Boolean);
  if (!candidates.length) return { best: null, bestReference: "", exactMatch: false };
  let best = 0;
  let bestReference = candidates[0];
  let exactMatch = false;
  const normalizedTranslation = normalizeSource(translation);
  for (const reference of candidates) {
    if (normalizeSource(reference) === normalizedTranslation) exactMatch = true;
    const score = similarity(translation, reference);
    if (score > best) {
      best = score;
      bestReference = reference;
    }
  }
  return { best, bestReference, exactMatch };
}

/**
 * Score one Gold sample. The reference translations are a quality signal, not
 * an equality requirement: only terms, facts, forbidden wordings and protected
 * tokens can hard-fail a sample.
 */
export function evaluateGoldSample(sample, result = {}) {
  if (!isPlainObject(sample)) throw new TypeError("Gold 样本必须是对象");
  const translation = text(result?.translation ?? result);
  const requiredTerms = checkRequiredTerms(translation, sample.requiredTerms);
  const factChecks = checkFactAnchors(translation, sample.facts);
  const forbidden = forbiddenHits(translation, sample.forbiddenTranslations);
  const missingTokens = missingProtectedTokens(translation, sample.protectedTokens);
  const reference = bestReferenceSimilarity(translation, sample.referenceTargets);
  const failures = [];
  if (!translation.trim()) failures.push({ category: "omission", severity: "critical", message: "译文为空" });
  for (const term of requiredTerms.filter((item) => !item.correct)) {
    failures.push({ category: "terminology", severity: "critical", message: `强制术语未命中：${term.source} → ${term.expected}` });
  }
  for (const fact of factChecks.filter((item) => !item.correct && item.critical)) {
    failures.push({ category: fact.type || "fact", severity: "critical", message: `事实锚点丢失：${fact.expected}` });
  }
  for (const phrase of forbidden) {
    failures.push({ category: "forbidden", severity: "critical", message: `命中禁用译法：${phrase}` });
  }
  for (const token of missingTokens) {
    failures.push({ category: "placeholder", severity: "critical", message: `占位符或保留标记丢失：${token}` });
  }
  return {
    id: text(sample.id),
    goldSetId: text(sample.goldSetId),
    goldSetVersion: sample.goldSetVersion ?? null,
    source: text(sample.source),
    translation,
    referenceTargets: (sample.referenceTargets || []).map(text),
    bestReference: reference.bestReference,
    similarity: round(reference.best),
    exactMatch: reference.exactMatch,
    requiredTerms,
    factChecks,
    issues: failures,
    passed: failures.length === 0
  };
}

/**
 * Score one regression case. The bar is deliberately narrow and absolute: the
 * exact wording a human already rejected must not come back, and whatever the
 * fix established — terms and fact anchors — must still hold.
 */
export function evaluateRegressionCase(regressionCase, result = {}) {
  if (!isPlainObject(regressionCase)) throw new TypeError("回归案例必须是对象");
  const translation = text(result?.translation ?? result);
  const requiredTerms = checkRequiredTerms(translation, regressionCase.requiredTerms);
  const factChecks = checkFactAnchors(translation, regressionCase.facts);
  const failures = [];
  if (!translation.trim()) {
    failures.push({ category: "omission", severity: "critical", message: "译文为空" });
  } else if (normalizeSource(translation) === normalizeSource(regressionCase.failingTranslation)) {
    failures.push({ category: "regression", severity: "critical", message: "复现了已被人工拒绝的译文" });
  }
  for (const term of requiredTerms.filter((item) => !item.correct)) {
    failures.push({ category: "terminology", severity: "critical", message: `强制术语未命中：${term.source} → ${term.expected}` });
  }
  for (const fact of factChecks.filter((item) => !item.correct && item.critical)) {
    failures.push({ category: fact.type || "fact", severity: "critical", message: `事实锚点丢失：${fact.expected}` });
  }
  const expected = bestReferenceSimilarity(translation, [regressionCase.expectedTranslation]);
  return {
    id: text(regressionCase.id),
    regressionSuiteId: text(regressionCase.regressionSuiteId),
    regressionSuiteVersion: regressionCase.regressionSuiteVersion ?? null,
    sourceQaCaseId: text(regressionCase.sourceQaCaseId),
    source: text(regressionCase.source),
    translation,
    failingTranslation: text(regressionCase.failingTranslation),
    expectedTranslation: text(regressionCase.expectedTranslation),
    similarity: round(expected.best),
    matchesExpected: expected.exactMatch,
    requiredTerms,
    factChecks,
    issues: failures,
    passed: failures.length === 0
  };
}

function pairResults(items, results, key = "id") {
  const byId = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const id = text(result?.[key] ?? result?.caseId ?? result?.sampleId);
    if (id) byId.set(id, result);
  }
  return items.map((item) => ({ item, result: byId.get(text(item[key])) || null }));
}

/** Aggregate a Gold Set run into KPI metrics plus the raw per-sample verdicts. */
export function evaluateGoldRun({ samples = [], results = [] } = {}) {
  const paired = pairResults(Array.isArray(samples) ? samples : [], results);
  const evaluated = paired
    .filter((entry) => entry.result)
    .map((entry) => evaluateGoldSample(entry.item, entry.result));
  const missing = paired.filter((entry) => !entry.result).map((entry) => text(entry.item.id));
  const termTotal = evaluated.reduce((sum, item) => sum + item.requiredTerms.length, 0);
  const termHits = evaluated.reduce((sum, item) => sum + item.requiredTerms.filter((term) => term.correct).length, 0);
  const factTotal = evaluated.reduce((sum, item) => sum + item.factChecks.length, 0);
  const factErrors = evaluated.reduce((sum, item) => sum + item.factChecks.filter((fact) => !fact.correct).length, 0);
  const similarities = evaluated.map((item) => item.similarity).filter((value) => value !== null);
  const metrics = calculateQualityMetrics(evaluated.map((item) => ({
    issues: item.issues,
    requiredTerms: item.requiredTerms,
    factChecks: item.factChecks
  })));
  return {
    total: paired.length,
    evaluated: evaluated.length,
    missing,
    passed: evaluated.filter((item) => item.passed).length,
    failed: evaluated.filter((item) => !item.passed).length,
    exactMatches: evaluated.filter((item) => item.exactMatch).length,
    termAccuracy: round(ratio(termHits, termTotal)),
    factAccuracy: round(factTotal ? (factTotal - factErrors) / factTotal : null),
    averageSimilarity: round(similarities.length ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length : null),
    metrics,
    samples: evaluated
  };
}

/** Aggregate a regression suite run; any unexecuted case counts as not passed. */
export function evaluateRegressionRun({ cases = [], results = [] } = {}) {
  const paired = pairResults(Array.isArray(cases) ? cases : [], results);
  const evaluated = paired
    .filter((entry) => entry.result)
    .map((entry) => evaluateRegressionCase(entry.item, entry.result));
  const missing = paired.filter((entry) => !entry.result).map((entry) => text(entry.item.id));
  const failures = evaluated.filter((item) => !item.passed);
  return {
    total: paired.length,
    evaluated: evaluated.length,
    missing,
    passed: evaluated.filter((item) => item.passed).length,
    failed: failures.length,
    passRate: round(ratio(evaluated.filter((item) => item.passed).length, paired.length)),
    failures: failures.map((item) => ({
      id: item.id,
      sourceQaCaseId: item.sourceQaCaseId,
      source: item.source,
      translation: item.translation,
      issues: item.issues
    })),
    cases: evaluated
  };
}

/**
 * Decide whether a candidate may be promoted. A regression failure always
 * blocks; a missing Gold Set only blocks when the caller demands one, so that a
 * scope which has not built its benchmark yet stays honestly "insufficient"
 * instead of silently passing.
 */
export function decideReleaseGate({ regression = null, gold = null, thresholds = {} } = {}) {
  const limits = { ...DEFAULT_GATE_THRESHOLDS, ...(isPlainObject(thresholds) ? thresholds : {}) };
  const blocking = [];
  const warnings = [];

  if (!regression || !regression.total) {
    const message = "当前作用域没有已批准的回归集，无法证明历史失败不会复发";
    if (limits.minimumRegressionCases > 0) blocking.push({ code: "regression_missing", message });
    else warnings.push({ code: "regression_missing", message });
  } else {
    if (regression.missing?.length) {
      blocking.push({ code: "regression_incomplete", message: `有 ${regression.missing.length} 个回归案例未执行` });
    }
    if (regression.total < limits.minimumRegressionCases) {
      blocking.push({ code: "regression_too_small", message: `回归案例数 ${regression.total} 少于要求的 ${limits.minimumRegressionCases}` });
    }
    const passRate = regression.passRate ?? 0;
    if (passRate < limits.regressionPassRate) {
      blocking.push({
        code: "regression_failed",
        message: `回归通过率 ${(passRate * 100).toFixed(1)}% 低于门槛 ${(limits.regressionPassRate * 100).toFixed(1)}%，${regression.failed} 个历史失败复发`
      });
    }
  }

  if (!gold || !gold.total) {
    const message = "当前作用域没有启用的固定 Gold Set";
    if (limits.allowMissingGold) warnings.push({ code: "gold_missing", message });
    else blocking.push({ code: "gold_missing", message });
  } else {
    if (gold.missing?.length) {
      blocking.push({ code: "gold_incomplete", message: `有 ${gold.missing.length} 个 Gold 样本未执行` });
    }
    if (gold.evaluated < limits.minimumGoldSamples) {
      warnings.push({ code: "gold_too_small", message: `Gold 样本数 ${gold.evaluated} 少于建议的 ${limits.minimumGoldSamples}，结论不稳定` });
    }
    if (gold.termAccuracy !== null && gold.termAccuracy < limits.goldTermAccuracy) {
      blocking.push({ code: "gold_terminology", message: `Gold 术语准确率 ${(gold.termAccuracy * 100).toFixed(1)}% 低于门槛 ${(limits.goldTermAccuracy * 100).toFixed(1)}%` });
    }
    if (gold.factAccuracy !== null && gold.factAccuracy < limits.goldFactAccuracy) {
      blocking.push({ code: "gold_facts", message: `Gold 事实准确率 ${(gold.factAccuracy * 100).toFixed(1)}% 低于门槛 ${(limits.goldFactAccuracy * 100).toFixed(1)}%` });
    }
    if (gold.averageSimilarity !== null && gold.averageSimilarity < limits.goldSimilarity) {
      warnings.push({ code: "gold_similarity", message: `Gold 平均相似度 ${(gold.averageSimilarity * 100).toFixed(1)}% 低于建议值 ${(limits.goldSimilarity * 100).toFixed(1)}%` });
    }
  }

  const hasEvidence = Boolean(regression?.total) || Boolean(gold?.total);
  const decision = blocking.length ? "block" : hasEvidence ? "pass" : "insufficient";
  return {
    schemaVersion: QUALITY_GATE_SCHEMA_VERSION,
    decision,
    allowed: decision === "pass",
    blocking,
    warnings,
    thresholds: limits
  };
}

/**
 * Resolve the exact fixed assets a scope must run. Returned samples and cases
 * carry their owning version and fingerprint, so a gate result can always be
 * traced back to the immutable asset version it was produced from.
 */
export function resolveGateAssets({ goldSets = [], regressionSuites = [], scope } = {}) {
  const samples = selectActiveGoldSamples(Array.isArray(goldSets) ? goldSets : [], scope ? { scope } : {});
  const cases = selectActiveRegressionCases(Array.isArray(regressionSuites) ? regressionSuites : [], scope ? { scope } : {});
  return {
    samples,
    cases,
    goldSetVersions: [...new Set(samples.map((sample) => `${sample.goldSeriesId}@v${sample.goldSetVersion}`))],
    regressionSuiteVersions: [...new Set(cases.map((item) => `${item.regressionSeriesId}@v${item.regressionSuiteVersion}`))]
  };
}
