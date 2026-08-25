/**
 * Kami translation learning engine.
 *
 * This module deliberately has no store, provider, clock, or random dependency.
 * Every exported operation is a pure function over JSON-compatible values so it
 * can be used by HTTP services, background jobs, CLIs, and tests alike.
 */

export const LEARNING_ENGINE_SCHEMA_VERSION = 1;
export const DEFAULT_MIN_EVALUATION_SAMPLES = 20;

const SCOPE_FIELDS = ["locale", "contentType", "domain", "project"];
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_PATCH_KEYS = new Set(["scope", "name", "description", "strategy", "changeReason", "metadata"]);

const DEFAULT_STRATEGY_TEMPLATE = {
  segmentation: {
    unit: "sentence_or_semantic_paragraph",
    preserveStructure: true,
    preserveProtectedTokens: true
  },
  context: {
    includePreviousSegments: 2,
    includeNextSegments: 1,
    includeDocumentMetadata: true
  },
  retrieval: {
    exactScopeOnly: true,
    requiredTerms: { enabled: true, limit: 100 },
    translationMemory: { enabled: true, limit: 5 },
    qaCases: { enabled: true, limit: 3 },
    styleProfile: { enabled: true, limit: 1 }
  },
  terminology: {
    enforceRequired: true,
    surfacePotentialMatches: true,
    blockForbiddenTranslations: true
  },
  prompting: {
    preserveMeaningBeforeFluency: true,
    useNeighborContext: true,
    useApprovedAssetsOnly: true
  },
  qa: {
    enabled: true,
    minimumScore: 90,
    blockOnHardError: true,
    maximumRevisionAttempts: 2
  }
};

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`不安全的对象字段：${key}`);
    output[key] = cloneJson(child);
  }
  return output;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const DEFAULT_TRANSLATION_STRATEGY = deepFreeze(cloneJson(DEFAULT_STRATEGY_TEMPLATE));

function requireScopePart(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`学习作用域缺少 ${field}`);
  }
  const normalized = value.trim();
  if (["*", "all", "any", "auto"].includes(normalized.toLowerCase())) {
    throw new TypeError(`学习作用域 ${field} 不允许使用通配值：${normalized}`);
  }
  return normalized;
}

/** Normalize and validate the required locale × contentType × domain × project scope. */
export function normalizeLearningScope(scope) {
  if (!isPlainObject(scope)) throw new TypeError("学习作用域必须是对象");
  return Object.freeze(Object.fromEntries(SCOPE_FIELDS.map((field) => [field, requireScopePart(scope[field], field)])));
}

export function learningScopeKey(scope) {
  const normalized = normalizeLearningScope(scope);
  return SCOPE_FIELDS.map((field) => encodeURIComponent(normalized[field])).join("::");
}

export function scopesEqual(left, right) {
  try {
    const a = normalizeLearningScope(left);
    const b = normalizeLearningScope(right);
    return SCOPE_FIELDS.every((field) => a[field] === b[field]);
  } catch {
    return false;
  }
}

export function assertExactLearningScope(expected, actual, label = "数据") {
  const expectedScope = normalizeLearningScope(expected);
  const actualScope = normalizeLearningScope(actual);
  if (!SCOPE_FIELDS.every((field) => expectedScope[field] === actualScope[field])) {
    throw new RangeError(`${label}作用域不一致：期望 ${learningScopeKey(expectedScope)}，实际 ${learningScopeKey(actualScope)}`);
  }
  return actualScope;
}

/** Alternate which variant runs first for each holdout case to avoid order bias. */
export function pairedBenchmarkOrder(caseIndex) {
  const index = Number(caseIndex);
  if (!Number.isInteger(index) || index < 0) throw new TypeError("评测样本序号必须是非负整数");
  return index % 2 === 0 ? ["champion", "challenger"] : ["challenger", "champion"];
}

/** Record the complete model input set, never only the IDs highlighted by the model. */
export function collectTrainingEvidenceIds(trajectories) {
  if (!Array.isArray(trajectories)) throw new TypeError("训练轨迹必须是数组");
  return [...new Set(trajectories.map((item) => String(item?.id || "")).filter(Boolean))];
}

/** Build a human-approved holdout that strictly excludes every training trajectory. */
export function selectSkillHoldout(trajectories, { scope, trainingEvidenceIds = [], limit = 60 } = {}) {
  if (!Array.isArray(trajectories)) throw new TypeError("候选留出轨迹必须是数组");
  const normalizedScope = normalizeLearningScope(scope);
  const training = new Set((Array.isArray(trainingEvidenceIds) ? trainingEvidenceIds : []).map(String));
  const maximum = Math.max(1, Math.trunc(finiteNumber(limit) ?? 60));
  return trajectories.filter((item) => item
    && !training.has(String(item.id || ""))
    && scopesEqual(normalizedScope, item.scope || item)
    && item.status === "completed"
    && item.humanDecision?.accepted === true
    && String(item.humanDecision?.finalTranslation || item.finalTranslation || "").trim())
    .slice(0, maximum);
}

/**
 * Validate that a candidate still belongs to the current champion generation.
 * When an evaluation is required, it must be the promotion result for these
 * exact two skill IDs and the same four-dimensional scope.
 */
export function validateCandidatePromotionState({ candidate, currentChampion, evaluation = null, requireEvaluation = false } = {}) {
  const reasons = [];
  let scope = null;
  if (!isPlainObject(candidate)) reasons.push("候选技能不存在");
  if (!isPlainObject(currentChampion)) reasons.push("当前 Champion 不存在");
  if (isPlainObject(candidate)) {
    try { scope = normalizeLearningScope(candidate.scope || candidate); } catch (error) { reasons.push(`候选作用域无效：${error.message}`); }
    if (!["challenger", "draft"].includes(candidate.status)) reasons.push(`候选状态必须是 challenger 或 draft，当前为 ${candidate.status || "未知"}`);
  }
  if (isPlainObject(currentChampion)) {
    if (currentChampion.status !== "champion") reasons.push(`当前基准状态不是 champion：${currentChampion.status || "未知"}`);
    if (scope && !scopesEqual(scope, currentChampion.scope || currentChampion)) reasons.push("候选与当前 Champion 作用域不一致");
  }
  if (isPlainObject(candidate) && isPlainObject(currentChampion) && String(candidate.parentId || "") !== String(currentChampion.id || "")) {
    reasons.push("候选父版本已不是当前 Champion");
  }
  if (requireEvaluation || evaluation) {
    if (!isPlainObject(evaluation)) {
      reasons.push("缺少最新晋升评测");
    } else {
      if (scope && !scopesEqual(scope, evaluation.scope || evaluation)) reasons.push("晋升评测作用域与候选不一致");
      if (String(evaluation.championSkillId || "") !== String(currentChampion?.id || "")) reasons.push("晋升评测对应的 Champion 已过期");
      if (String(evaluation.challengerSkillId || "") !== String(candidate?.id || "")) reasons.push("晋升评测不属于当前候选");
      if (evaluation.decision !== "promote" || evaluation.report?.promotable !== true) reasons.push("最新评测未通过完整晋升门禁");
    }
  }
  return { valid: reasons.length === 0, reasons, scope };
}

function mergePlainObject(base, patch) {
  if (!isPlainObject(patch)) return cloneJson(patch);
  const output = isPlainObject(base) ? cloneJson(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`不安全的补丁字段：${key}`);
    output[key] = isPlainObject(value) ? mergePlainObject(output[key], value) : cloneJson(value);
  }
  return output;
}

/** Create a deterministic v1 skill. Callers provide IDs; this layer never uses clocks or randomness. */
export function createDefaultTranslationSkill({ id = "", scope, name = "", description = "", strategy = {} } = {}) {
  const normalizedScope = normalizeLearningScope(scope);
  if (!isPlainObject(strategy)) throw new TypeError("strategy 必须是对象");
  const resolvedId = String(id || `translation-skill:${learningScopeKey(normalizedScope)}:v1`);
  return {
    schemaVersion: LEARNING_ENGINE_SCHEMA_VERSION,
    id: resolvedId,
    parentId: "",
    version: 1,
    status: "champion",
    scope: cloneJson(normalizedScope),
    name: String(name || `${normalizedScope.locale} · ${normalizedScope.contentType} · ${normalizedScope.project}`),
    description: String(description || "Kami 默认翻译策略"),
    strategy: mergePlainObject(DEFAULT_TRANSLATION_STRATEGY, strategy),
    changeReason: "初始默认策略",
    metadata: {}
  };
}

/**
 * Merge an agent-proposed patch into a champion without mutating either input.
 * Scope and lifecycle fields are immutable; the result is always a challenger.
 */
export function mergeTranslationSkillPatch(champion, patch, { candidateId = "" } = {}) {
  if (!isPlainObject(champion) || !isPlainObject(champion.strategy)) {
    throw new TypeError("champion 必须是有效的 translation skill");
  }
  const championScope = normalizeLearningScope(champion.scope);
  if (!isPlainObject(patch)) throw new TypeError("候选补丁必须是对象");
  for (const key of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`不安全的补丁字段：${key}`);
    if (!ALLOWED_PATCH_KEYS.has(key)) throw new TypeError(`候选补丁不允许修改字段：${key}`);
  }
  if (patch.scope) assertExactLearningScope(championScope, patch.scope, "候选技能");
  if (patch.strategy !== undefined && !isPlainObject(patch.strategy)) {
    throw new TypeError("候选 strategy 补丁必须是对象");
  }

  const version = Math.max(1, Number(champion.version) || 1) + 1;
  const id = String(candidateId || `${champion.id || `translation-skill:${learningScopeKey(championScope)}`}@candidate-v${version}`);
  return {
    schemaVersion: LEARNING_ENGINE_SCHEMA_VERSION,
    id,
    parentId: String(champion.id || ""),
    version,
    status: "challenger",
    scope: cloneJson(championScope),
    name: String(patch.name ?? champion.name ?? ""),
    description: String(patch.description ?? champion.description ?? ""),
    strategy: mergePlainObject(champion.strategy, patch.strategy || {}),
    changeReason: String(patch.changeReason || "候选策略补丁"),
    metadata: mergePlainObject(champion.metadata || {}, patch.metadata || {})
  };
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function codePoints(text) {
  return [...String(text ?? "")];
}

/** Unicode-code-point Levenshtein distance normalized to 0..1. */
export function normalizedEditDistance(left, right) {
  const a = codePoints(left);
  const b = codePoints(right);
  if (!a.length && !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function hardErrorCount(value) {
  const explicit = finiteNumber(value?.hardErrorCount);
  if (explicit !== null) return Math.max(0, Math.trunc(explicit));
  if (Array.isArray(value?.hardErrors)) return value.hardErrors.length;
  return null;
}

function termCounts(value) {
  const explicitTotal = finiteNumber(value?.requiredTermTotal);
  const explicitHits = finiteNumber(value?.requiredTermHits);
  if (explicitTotal !== null && explicitHits !== null) {
    const total = Math.max(0, Math.trunc(explicitTotal));
    return { total, hits: clamp(Math.trunc(explicitHits), 0, total) };
  }
  if (Array.isArray(value?.requiredTerms)) {
    const total = value.requiredTerms.length;
    const hits = value.requiredTerms.filter((item) => item === true || item?.correct === true || item?.adopted === true || item?.matched === true).length;
    return { total, hits };
  }
  return null;
}

function editDistanceFromSample(sample) {
  const explicit = finiteNumber(sample?.humanEditDistance);
  if (explicit !== null) return clamp(explicit, 0, 1);
  const finalText = sample?.humanFinalTranslation ?? sample?.finalTranslation;
  const outputText = sample?.translation ?? sample?.candidateTranslation;
  if (typeof finalText === "string" && typeof outputText === "string") {
    return normalizedEditDistance(outputText, finalText);
  }
  return null;
}

function numericField(sample, names, { minimum = -Infinity, maximum = Infinity } = {}) {
  for (const name of names) {
    const value = finiteNumber(sample?.[name]);
    if (value !== null) return clamp(value, minimum, maximum);
  }
  return null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(percentage * ordered.length) - 1)];
}

function coverage(count, total) {
  return total ? count / total : 0;
}

/** Calculate all benchmark metrics for one skill on one exact scope. */
export function calculateSkillEvaluationMetrics(samples, { scope, minSamples = DEFAULT_MIN_EVALUATION_SAMPLES } = {}) {
  const normalizedScope = normalizeLearningScope(scope);
  if (!Array.isArray(samples)) throw new TypeError("评测样本必须是数组");
  const minimum = Math.max(1, Math.trunc(finiteNumber(minSamples) ?? DEFAULT_MIN_EVALUATION_SAMPLES));
  samples.forEach((sample, index) => {
    if (!isPlainObject(sample)) throw new TypeError(`评测样本 ${index + 1} 必须是对象`);
    if (sample.scope) assertExactLearningScope(normalizedScope, sample.scope, `评测样本 ${index + 1} `);
  });

  let requiredTermHits = 0;
  let requiredTermTotal = 0;
  let termObserved = 0;
  const hardErrors = [];
  const qaScores = [];
  const editDistances = [];
  const humanAccepted = [];
  const costs = [];
  const latencies = [];

  for (const sample of samples) {
    const terms = termCounts(sample);
    if (terms) {
      termObserved += 1;
      requiredTermHits += terms.hits;
      requiredTermTotal += terms.total;
    }
    const errors = hardErrorCount(sample);
    if (errors !== null) hardErrors.push(errors);
    const qa = numericField(sample, ["qaScore"], { minimum: 0, maximum: 100 });
    if (qa !== null) qaScores.push(qa);
    const edit = editDistanceFromSample(sample);
    if (edit !== null) editDistances.push(edit);
    if (typeof sample.humanAccepted === "boolean") humanAccepted.push(sample.humanAccepted ? 1 : 0);
    const cost = numericField(sample, ["cost", "costUsd"], { minimum: 0 });
    if (cost !== null) costs.push(cost);
    const latency = numericField(sample, ["latencyMs"], { minimum: 0 });
    if (latency !== null) latencies.push(latency);
  }

  const hardErrorTotal = hardErrors.reduce((sum, value) => sum + value, 0);
  const result = {
    scope: cloneJson(normalizedScope),
    scopeKey: learningScopeKey(normalizedScope),
    sampleSize: samples.length,
    minimumSampleSize: minimum,
    status: samples.length < minimum ? "insufficient" : "ready",
    mandatoryTermAccuracy: requiredTermTotal ? requiredTermHits / requiredTermTotal : null,
    requiredTermHits,
    requiredTermTotal,
    hardErrorCount: hardErrors.length ? hardErrorTotal : null,
    hardErrorsPerSample: hardErrors.length ? hardErrorTotal / hardErrors.length : null,
    hardErrorFreeRate: hardErrors.length ? hardErrors.filter((value) => value === 0).length / hardErrors.length : null,
    qaScore: average(qaScores),
    humanEditDistance: average(editDistances),
    humanAcceptanceRate: average(humanAccepted),
    cost: {
      total: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      average: average(costs)
    },
    latencyMs: {
      average: average(latencies),
      p95: percentile(latencies, 0.95)
    },
    coverage: {
      mandatoryTerms: coverage(termObserved, samples.length),
      hardErrors: coverage(hardErrors.length, samples.length),
      qaScore: coverage(qaScores.length, samples.length),
      humanEditDistance: coverage(editDistances.length, samples.length),
      humanAcceptance: coverage(humanAccepted.length, samples.length),
      cost: coverage(costs.length, samples.length),
      latency: coverage(latencies.length, samples.length)
    }
  };
  if (result.status === "insufficient") result.insufficientReason = `样本 ${samples.length} 条，少于门槛 ${minimum} 条`;
  return result;
}

function metricDelta(champion, challenger) {
  return champion === null || challenger === null ? null : challenger - champion;
}

function ratioRegression(champion, challenger) {
  if (champion === null || challenger === null) return null;
  if (champion === 0) return challenger === 0 ? 0 : Infinity;
  return (challenger - champion) / champion;
}

function gate(id, label, type, passed, detail) {
  return { id, label, type, status: passed ? "passed" : "failed", passed, detail };
}

function percent(value) {
  return value === null ? "暂无" : `${(value * 100).toFixed(1)}%`;
}

function fixed(value, digits = 2) {
  return value === null ? "暂无" : Number(value).toFixed(digits);
}

function extractCaseIds(samples) {
  const ids = samples.map((sample) => sample.caseId).filter((id) => id !== undefined && id !== null && String(id));
  return ids.length === samples.length ? ids.map(String).sort() : null;
}

function sameCaseSet(championSamples, challengerSamples) {
  if (championSamples.length !== challengerSamples.length) return false;
  const championIds = extractCaseIds(championSamples);
  const challengerIds = extractCaseIds(challengerSamples);
  if (!championIds && !challengerIds) return true;
  if (!championIds || !challengerIds) return false;
  return championIds.every((id, index) => id === challengerIds[index]);
}

export function buildChinesePromotionReport(result) {
  const conclusion = result.status === "promote"
    ? "建议晋升 Challenger"
    : result.status === "insufficient"
      ? "证据不足，暂不晋升"
      : "门禁未通过，拒绝晋升";
  const champion = result.championMetrics;
  const challenger = result.challengerMetrics;
  const lines = [
    `结论：${conclusion}`,
    `范围：${result.scope.locale} × ${result.scope.contentType} × ${result.scope.domain} × ${result.scope.project}`,
    `样本：Champion ${champion.sampleSize} 条；Challenger ${challenger.sampleSize} 条；最低 ${champion.minimumSampleSize} 条。`,
    `强制术语正确率：${percent(champion.mandatoryTermAccuracy)} → ${percent(challenger.mandatoryTermAccuracy)}`,
    `硬错误：${fixed(champion.hardErrorCount, 0)} → ${fixed(challenger.hardErrorCount, 0)}；无硬错误率 ${percent(champion.hardErrorFreeRate)} → ${percent(challenger.hardErrorFreeRate)}`,
    `QA 平均分：${fixed(champion.qaScore, 1)} → ${fixed(challenger.qaScore, 1)}`,
    `人工编辑距离：${percent(champion.humanEditDistance)} → ${percent(challenger.humanEditDistance)}；接受率 ${percent(champion.humanAcceptanceRate)} → ${percent(challenger.humanAcceptanceRate)}`,
    `平均成本：${fixed(champion.cost.average, 4)} → ${fixed(challenger.cost.average, 4)}；平均延迟 ${fixed(champion.latencyMs.average, 0)}ms → ${fixed(challenger.latencyMs.average, 0)}ms。`
  ];
  if (result.insufficientReasons?.length) lines.push(`证据缺口：${result.insufficientReasons.join("；")}。`);
  if (result.gates?.length) {
    lines.push("门禁：", ...result.gates.map((item) => `${item.passed ? "通过" : "未通过"}｜${item.label}：${item.detail}`));
  }
  return lines.join("\n");
}

/**
 * Compare a champion and challenger on the same benchmark and decide promotion.
 * Hard terminology/error regressions are absolute vetoes. Quality cannot
 * regress; cost and latency use explicit guardrails.
 */
export function evaluateSkillPromotion({
  scope,
  champion,
  challenger,
  minSamples = DEFAULT_MIN_EVALUATION_SAMPLES,
  minimumCoverage = 0.8,
  guardrails = {}
} = {}) {
  const normalizedScope = normalizeLearningScope(scope);
  if (!isPlainObject(champion) || !Array.isArray(champion.samples)) throw new TypeError("champion.samples 必须是数组");
  if (!isPlainObject(challenger) || !Array.isArray(challenger.samples)) throw new TypeError("challenger.samples 必须是数组");
  assertExactLearningScope(normalizedScope, champion.scope ?? champion.skill?.scope, "Champion ");
  assertExactLearningScope(normalizedScope, challenger.scope ?? challenger.skill?.scope, "Challenger ");
  const championMetrics = calculateSkillEvaluationMetrics(champion.samples, { scope: normalizedScope, minSamples });
  const challengerMetrics = calculateSkillEvaluationMetrics(challenger.samples, { scope: normalizedScope, minSamples });
  const requiredCoverage = clamp(finiteNumber(minimumCoverage) ?? 0.8, 0, 1);
  const requireCost = guardrails.requireCost !== false;
  const insufficientReasons = [];
  if (championMetrics.status === "insufficient") insufficientReasons.push(`Champion ${championMetrics.insufficientReason}`);
  if (challengerMetrics.status === "insufficient") insufficientReasons.push(`Challenger ${challengerMetrics.insufficientReason}`);
  if (!sameCaseSet(champion.samples, challenger.samples)) insufficientReasons.push("双方未使用同一组评测样本");
  const requiredMetricCoverage = [
    ["mandatoryTerms", "强制术语"], ["hardErrors", "硬错误"], ["qaScore", "QA 分"],
    ["humanEditDistance", "人工编辑距离"], ["humanAcceptance", "人工接受率"],
    ["latency", "延迟"]
  ];
  if (requireCost) requiredMetricCoverage.push(["cost", "成本"]);
  for (const [key, label] of requiredMetricCoverage) {
    if (championMetrics.coverage[key] < requiredCoverage || challengerMetrics.coverage[key] < requiredCoverage) {
      insufficientReasons.push(`${label}数据覆盖率低于 ${percent(requiredCoverage)}`);
    }
  }

  const deltas = {
    mandatoryTermAccuracy: metricDelta(championMetrics.mandatoryTermAccuracy, challengerMetrics.mandatoryTermAccuracy),
    hardErrorCount: metricDelta(championMetrics.hardErrorCount, challengerMetrics.hardErrorCount),
    hardErrorsPerSample: metricDelta(championMetrics.hardErrorsPerSample, challengerMetrics.hardErrorsPerSample),
    hardErrorFreeRate: metricDelta(championMetrics.hardErrorFreeRate, challengerMetrics.hardErrorFreeRate),
    qaScore: metricDelta(championMetrics.qaScore, challengerMetrics.qaScore),
    humanEditDistance: metricDelta(championMetrics.humanEditDistance, challengerMetrics.humanEditDistance),
    humanAcceptanceRate: metricDelta(championMetrics.humanAcceptanceRate, challengerMetrics.humanAcceptanceRate),
    averageCost: metricDelta(championMetrics.cost.average, challengerMetrics.cost.average),
    averageLatencyMs: metricDelta(championMetrics.latencyMs.average, challengerMetrics.latencyMs.average)
  };

  const result = {
    schemaVersion: LEARNING_ENGINE_SCHEMA_VERSION,
    scope: cloneJson(normalizedScope),
    scopeKey: learningScopeKey(normalizedScope),
    championId: String(champion.id ?? champion.skill?.id ?? "champion"),
    challengerId: String(challenger.id ?? challenger.skill?.id ?? "challenger"),
    championMetrics,
    challengerMetrics,
    deltas,
    gates: [],
    insufficientReasons,
    status: "insufficient",
    promotable: false,
    reportZh: ""
  };

  if (insufficientReasons.length) {
    result.reportZh = buildChinesePromotionReport(result);
    return result;
  }

  const termApplicable = championMetrics.requiredTermTotal > 0 || challengerMetrics.requiredTermTotal > 0;
  const termPassed = !termApplicable || (
    championMetrics.mandatoryTermAccuracy !== null &&
    challengerMetrics.mandatoryTermAccuracy !== null &&
    challengerMetrics.mandatoryTermAccuracy >= championMetrics.mandatoryTermAccuracy
  );
  result.gates.push(gate("mandatory_terms", "强制术语不得回退", "hard", termPassed,
    termApplicable ? `${percent(championMetrics.mandatoryTermAccuracy)} → ${percent(challengerMetrics.mandatoryTermAccuracy)}` : "本评测集无强制术语，按不适用处理"));
  result.gates.push(gate("hard_errors", "硬错误不得增加", "hard",
    challengerMetrics.hardErrorCount <= championMetrics.hardErrorCount,
    `${championMetrics.hardErrorCount} → ${challengerMetrics.hardErrorCount}`));
  result.gates.push(gate("qa_score", "QA 分不得下降", "quality",
    challengerMetrics.qaScore >= championMetrics.qaScore,
    `${fixed(championMetrics.qaScore, 1)} → ${fixed(challengerMetrics.qaScore, 1)}`));
  result.gates.push(gate("human_edit", "人工编辑距离不得上升", "quality",
    challengerMetrics.humanEditDistance <= championMetrics.humanEditDistance,
    `${percent(championMetrics.humanEditDistance)} → ${percent(challengerMetrics.humanEditDistance)}`));
  result.gates.push(gate("human_acceptance", "人工接受率不得下降", "quality",
    challengerMetrics.humanAcceptanceRate >= championMetrics.humanAcceptanceRate,
    `${percent(championMetrics.humanAcceptanceRate)} → ${percent(challengerMetrics.humanAcceptanceRate)}`));

  const maximumCostRegression = Math.max(0, finiteNumber(guardrails.maximumCostRegression) ?? 0.2);
  const maximumLatencyRegression = Math.max(0, finiteNumber(guardrails.maximumLatencyRegression) ?? 0.25);
  const costRegression = ratioRegression(championMetrics.cost.average, challengerMetrics.cost.average);
  const latencyRegression = ratioRegression(championMetrics.latencyMs.average, challengerMetrics.latencyMs.average);
  if (requireCost) {
    result.gates.push(gate("cost", "成本回退在允许范围内", "efficiency",
      costRegression !== null && costRegression <= maximumCostRegression,
      `变化 ${costRegression === Infinity ? "无限" : percent(costRegression)}，上限 ${percent(maximumCostRegression)}`));
  }
  result.gates.push(gate("latency", "延迟回退在允许范围内", "efficiency",
    latencyRegression !== null && latencyRegression <= maximumLatencyRegression,
    `变化 ${latencyRegression === Infinity ? "无限" : percent(latencyRegression)}，上限 ${percent(maximumLatencyRegression)}`));

  const materialGains = {
    mandatoryTerms: deltas.mandatoryTermAccuracy !== null && deltas.mandatoryTermAccuracy > 0,
    hardErrors: deltas.hardErrorCount !== null && deltas.hardErrorCount < 0,
    qaScore: deltas.qaScore !== null && deltas.qaScore >= (finiteNumber(guardrails.minimumQaGain) ?? 0.5),
    humanEditDistance: deltas.humanEditDistance !== null && deltas.humanEditDistance <= -(finiteNumber(guardrails.minimumEditDistanceGain) ?? 0.005),
    humanAcceptance: deltas.humanAcceptanceRate !== null && deltas.humanAcceptanceRate >= (finiteNumber(guardrails.minimumAcceptanceGain) ?? 0.01),
    cost: costRegression !== null && costRegression <= -(finiteNumber(guardrails.minimumEfficiencyGain) ?? 0.1),
    latency: latencyRegression !== null && latencyRegression <= -(finiteNumber(guardrails.minimumEfficiencyGain) ?? 0.1)
  };
  // Some evaluations must not let a metric justify promotion even though that
  // metric still guards against regression. Style-profile评测 is the case that
  // needs this: AIQA reads the style profile, so letting a new style profile
  // win on QA score would be self-scoring. Restricting the whitelist keeps the
  // qa_score gate as a guard while forcing the gain to come from elsewhere.
  const allowedGainKeys = Array.isArray(guardrails.materialGainMetrics) && guardrails.materialGainMetrics.length
    ? guardrails.materialGainMetrics.filter((key) => Object.hasOwn(materialGains, key))
    : Object.keys(materialGains);
  const achieved = allowedGainKeys.filter((key) => materialGains[key]);
  const materialImprovement = achieved.length > 0;
  const restricted = allowedGainKeys.length < Object.keys(materialGains).length;
  result.materialGains = materialGains;
  result.gates.push(gate("material_gain", "至少有一项实质收益", "promotion", materialImprovement,
    materialImprovement
      ? `质量或效率达到最小改进幅度（${achieved.join("、")}）`
      : `与 Champion 持平，尚无晋升价值${restricted ? `（本次只认可 ${allowedGainKeys.join("、")}）` : ""}`));

  result.promotable = result.gates.every((item) => item.passed);
  result.status = result.promotable ? "promote" : "reject";
  result.reportZh = buildChinesePromotionReport(result);
  return result;
}

function trajectoryStage(value = {}) {
  return {
    qaScore: numericField(value, ["qaScore"], { minimum: 0, maximum: 100 }),
    hardErrorCount: hardErrorCount(value),
    terms: termCounts(value)
  };
}

function attribution(factor, label, direction, confidence, evidence) {
  return { factor, label, direction, confidence, evidence: evidence.filter(Boolean) };
}

/**
 * Produce a cautious, human-readable attribution summary from one completed
 * trajectory. It reports evidence signals, not unverifiable causal certainty.
 */
export function summarizeTrajectoryAttribution(trajectory = {}) {
  if (!isPlainObject(trajectory)) throw new TypeError("轨迹必须是对象");
  const scope = normalizeLearningScope(trajectory.scope);
  const initial = trajectoryStage(trajectory.initial || {});
  const final = trajectoryStage(trajectory.final || {});
  const context = isPlainObject(trajectory.context) ? trajectory.context : {};
  const humanFeedback = isPlainObject(trajectory.humanFeedback) ? trajectory.humanFeedback : {};
  const revisions = Array.isArray(trajectory.revisions) ? trajectory.revisions : [];
  const contributions = [];

  const qaDelta = initial.qaScore === null || final.qaScore === null ? null : final.qaScore - initial.qaScore;
  const hardErrorDelta = initial.hardErrorCount === null || final.hardErrorCount === null ? null : final.hardErrorCount - initial.hardErrorCount;
  const initialTermAccuracy = initial.terms?.total ? initial.terms.hits / initial.terms.total : null;
  const finalTermAccuracy = final.terms?.total ? final.terms.hits / final.terms.total : null;
  const termDelta = initialTermAccuracy === null || finalTermAccuracy === null ? null : finalTermAccuracy - initialTermAccuracy;

  if (termDelta !== null && termDelta !== 0) {
    contributions.push(attribution("terminology", "术语约束", termDelta > 0 ? "positive" : "negative", 0.9,
      [`强制术语正确率 ${percent(initialTermAccuracy)} → ${percent(finalTermAccuracy)}`]));
  } else if (Array.isArray(context.requiredTerms) && context.requiredTerms.length) {
    contributions.push(attribution("terminology", "术语约束", "exposed", 0.35,
      [`翻译上下文加载 ${context.requiredTerms.length} 条强制术语；仅能确认使用过，不能单独证明因果`]));
  }
  if ((qaDelta !== null && qaDelta !== 0) || (hardErrorDelta !== null && hardErrorDelta !== 0) || revisions.length) {
    const positive = (qaDelta ?? 0) > 0 || (hardErrorDelta ?? 0) < 0;
    contributions.push(attribution("qa_revision", "AIQA 修订", positive ? "positive" : "negative", revisions.length ? 0.85 : 0.7, [
      qaDelta === null ? "" : `QA 分 ${fixed(initial.qaScore, 1)} → ${fixed(final.qaScore, 1)}`,
      hardErrorDelta === null ? "" : `硬错误 ${initial.hardErrorCount} → ${final.hardErrorCount}`,
      revisions.length ? `执行 ${revisions.length} 次修订` : ""
    ]));
  }
  if (context.styleProfile?.id) {
    contributions.push(attribution("style_profile", "风格规范", "exposed", 0.35,
      [`加载风格规范 ${context.styleProfile.name || context.styleProfile.id} v${context.styleProfile.version || 1}；需通过对照评测确认贡献`]));
  }
  const memoryCount = Array.isArray(context.translationReferences) ? context.translationReferences.length : 0;
  if (memoryCount) {
    contributions.push(attribution("translation_memory", "相似译例", "exposed", 0.3,
      [`加载 ${memoryCount} 条相似译例；需通过消融评测确认贡献`]));
  }

  const accepted = typeof humanFeedback.accepted === "boolean" ? humanFeedback.accepted : null;
  const humanEdit = editDistanceFromSample({
    humanEditDistance: humanFeedback.editDistance,
    translation: trajectory.final?.translation,
    humanFinalTranslation: humanFeedback.finalTranslation
  });
  if (accepted !== null || humanEdit !== null) {
    contributions.push(attribution("human_feedback", "人工反馈", accepted === false || (humanEdit ?? 0) > 0.1 ? "correction" : "positive", 1,
      [accepted === null ? "" : `人工${accepted ? "接受" : "拒绝"}`, humanEdit === null ? "" : `编辑距离 ${percent(humanEdit)}`]));
  }

  const learningCandidates = [];
  if (final.terms?.total && final.terms.hits < final.terms.total) {
    learningCandidates.push({ type: "terminology_rule", priority: "high", reason: `最终仍漏用 ${final.terms.total - final.terms.hits} 条强制术语` });
  }
  if ((final.hardErrorCount ?? 0) > 0) {
    learningCandidates.push({ type: "qa_rule", priority: "high", reason: `最终仍有 ${final.hardErrorCount} 个硬错误` });
  }
  if (accepted === false || (humanEdit ?? 0) > 0.1) {
    learningCandidates.push({ type: "style_or_prompt_patch", priority: "medium", reason: "人工拒绝或编辑幅度较大，应提炼修订模式并进入候选技能评测" });
  }
  if (accepted === true && (humanEdit === null || humanEdit <= 0.03) && (final.hardErrorCount ?? 0) === 0) {
    learningCandidates.push({ type: "positive_example", priority: "low", reason: "人工低编辑接受，可作为同作用域正向译例" });
  }

  const positiveSignals = contributions.filter((item) => item.direction === "positive").length;
  const negativeSignals = contributions.filter((item) => ["negative", "correction"].includes(item.direction)).length;
  const outcome = negativeSignals ? "needs_learning" : positiveSignals || accepted === true ? "improved" : "observed";
  const reportLines = [
    `轨迹：${trajectory.id || "未命名"}`,
    `范围：${scope.locale} × ${scope.contentType} × ${scope.domain} × ${scope.project}`,
    `结果：${outcome === "improved" ? "已有正向改进信号" : outcome === "needs_learning" ? "发现需要学习的修订信号" : "仅完成观察，尚不能确认改进"}`,
    ...contributions.map((item) => `${item.label}｜${item.evidence.join("；")}`)
  ];
  if (learningCandidates.length) reportLines.push(`学习候选：${learningCandidates.map((item) => `${item.type}（${item.reason}）`).join("；")}`);

  return {
    schemaVersion: LEARNING_ENGINE_SCHEMA_VERSION,
    trajectoryId: String(trajectory.id || ""),
    scope: cloneJson(scope),
    scopeKey: learningScopeKey(scope),
    outcome,
    deltas: { qaScore: qaDelta, hardErrorCount: hardErrorDelta, mandatoryTermAccuracy: termDelta, humanEditDistance: humanEdit },
    contributions,
    learningCandidates,
    reportZh: reportLines.join("\n")
  };
}
