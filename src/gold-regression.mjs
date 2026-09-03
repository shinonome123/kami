import { createHash } from "node:crypto";
import { assertExactLearningScope, learningScopeKey, normalizeLearningScope, scopesEqual } from "./learning-engine.mjs";

/**
 * Fixed quality assets are intentionally independent from the translation
 * store. Callers decide where records live; this module only validates and
 * shapes immutable, JSON-compatible records.
 */
export const QUALITY_ASSET_SCHEMA_VERSION = 1;
export const GOLD_SET_STATUSES = Object.freeze(["draft", "active", "retired"]);
export const REGRESSION_CANDIDATE_STATUSES = Object.freeze(["pending", "approved", "rejected", "retired"]);
export const REGRESSION_SUITE_STATUSES = Object.freeze(["draft", "active", "retired"]);

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ISSUE_SEVERITIES = new Set(["critical", "major", "minor", "warning", "info"]);

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}不能为空`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveVersion(value, label = "版本") {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`${label}必须是正整数`);
  return version;
}

function normalizeLifecycle(input, allowed, { defaultStatus = "draft" } = {}) {
  const status = optionalText(input.status || defaultStatus).toLowerCase();
  if (!allowed.includes(status)) throw new TypeError(`不支持的状态：${status || "空"}`);
  const enabled = input.enabled === undefined ? status === "active" : input.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("enabled 必须是布尔值");
  if (enabled && status !== "active") throw new RangeError(`只有 active 状态可以启用，当前为 ${status}`);
  return { status, enabled };
}

function normalizeStringList(values, label) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label}必须是数组`);
  return [...new Set(values.map((value, index) => requiredText(value, `${label}第 ${index + 1} 项`)))];
}

function normalizeRequiredTerm(term, index) {
  if (!isPlainObject(term)) throw new TypeError(`强制术语第 ${index + 1} 项必须是对象`);
  return {
    source: requiredText(term.source, `强制术语第 ${index + 1} 项 source`),
    target: requiredText(term.target, `强制术语第 ${index + 1} 项 target`),
    acceptedTargets: normalizeStringList(term.acceptedTargets || term.aliases, `强制术语第 ${index + 1} 项 acceptedTargets`),
    caseSensitive: Boolean(term.caseSensitive),
    preserveSource: Boolean(term.preserveSource)
  };
}

function normalizeFact(fact, index) {
  if (!isPlainObject(fact)) throw new TypeError(`事实约束第 ${index + 1} 项必须是对象`);
  const sourceValue = requiredText(fact.sourceValue ?? fact.source, `事实约束第 ${index + 1} 项 sourceValue`);
  return {
    id: optionalText(fact.id) || `fact-${index + 1}`,
    type: optionalText(fact.type) || "fact",
    sourceValue,
    expectedValue: requiredText(fact.expectedValue ?? fact.target ?? sourceValue, `事实约束第 ${index + 1} 项 expectedValue`),
    comparison: optionalText(fact.comparison) || "semantic_exact",
    critical: fact.critical !== false
  };
}

function referenceTargets(sample, index) {
  const candidates = sample.referenceTargets ?? sample.acceptedTargets
    ?? (sample.referenceTarget !== undefined ? [sample.referenceTarget]
      : sample.target !== undefined ? [sample.target] : []);
  const targets = normalizeStringList(candidates, `Gold 样本 ${index + 1} referenceTargets`);
  if (!targets.length) throw new TypeError(`Gold 样本 ${index + 1} 至少需要一个参考译文`);
  return targets;
}

/** Validate one stable Gold sample against its owning set's exact scope. */
export function normalizeGoldSample(sample, { scope, index = 0 } = {}) {
  if (!isPlainObject(sample)) throw new TypeError(`Gold 样本 ${index + 1} 必须是对象`);
  const normalizedScope = normalizeLearningScope(scope);
  if (sample.scope) assertExactLearningScope(normalizedScope, sample.scope, `Gold 样本 ${index + 1} `);
  const normalized = {
    id: requiredText(sample.id, `Gold 样本 ${index + 1} id`),
    scope: cloneJson(normalizedScope),
    enabled: sample.enabled !== false,
    source: requiredText(sample.source, `Gold 样本 ${index + 1} source`),
    referenceTargets: referenceTargets(sample, index),
    requiredTerms: (sample.requiredTerms || []).map(normalizeRequiredTerm),
    forbiddenTranslations: normalizeStringList(sample.forbiddenTranslations, `Gold 样本 ${index + 1} forbiddenTranslations`),
    protectedTokens: normalizeStringList(sample.protectedTokens, `Gold 样本 ${index + 1} protectedTokens`),
    facts: (sample.facts || []).map(normalizeFact),
    riskLevel: optionalText(sample.riskLevel) || "normal",
    notes: optionalText(sample.notes),
    metadata: cloneJson(isPlainObject(sample.metadata) ? sample.metadata : {})
  };
  normalized.fingerprint = fingerprint({ ...normalized, fingerprint: undefined });
  return normalized;
}

/**
 * Normalize one versioned Gold Set. `seriesId` remains stable across versions;
 * `id` identifies this exact record. Only active versions may be enabled.
 */
export function normalizeGoldSet(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("Gold Set 必须是对象");
  const scope = normalizeLearningScope(input.scope || input);
  const id = requiredText(input.id, "Gold Set id");
  const lifecycle = normalizeLifecycle(input, GOLD_SET_STATUSES);
  const samplesInput = input.samples === undefined ? [] : input.samples;
  if (!Array.isArray(samplesInput)) throw new TypeError("Gold Set samples 必须是数组");
  const samples = samplesInput.map((sample, index) => normalizeGoldSample(sample, { scope, index }));
  const ids = samples.map((sample) => sample.id);
  if (new Set(ids).size !== ids.length) throw new RangeError("Gold Set 内存在重复样本 id");
  if (lifecycle.status === "active" && !samples.length) throw new RangeError("active Gold Set 不能是空集");
  const normalized = {
    schemaVersion: QUALITY_ASSET_SCHEMA_VERSION,
    kind: "gold_set",
    id,
    seriesId: optionalText(input.seriesId) || id,
    version: positiveVersion(input.version),
    parentVersionId: optionalText(input.parentVersionId),
    scope: cloneJson(scope),
    scopeKey: learningScopeKey(scope),
    name: requiredText(input.name, "Gold Set name"),
    description: optionalText(input.description),
    ...lifecycle,
    samples,
    createdAt: optionalText(input.createdAt),
    createdBy: optionalText(input.createdBy),
    changeNote: optionalText(input.changeNote),
    metadata: cloneJson(isPlainObject(input.metadata) ? input.metadata : {})
  };
  normalized.fingerprint = fingerprint({
    schemaVersion: normalized.schemaVersion,
    seriesId: normalized.seriesId,
    version: normalized.version,
    scope: normalized.scope,
    samples: normalized.samples
  });
  return normalized;
}

function selectLatestActive(records, normalize, { scope } = {}) {
  const normalizedScope = scope ? normalizeLearningScope(scope) : null;
  const latest = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const record = normalize(raw);
    if (!record.enabled || record.status !== "active") continue;
    if (normalizedScope && !scopesEqual(normalizedScope, record.scope)) continue;
    const current = latest.get(record.seriesId);
    if (!current || record.version > current.version) latest.set(record.seriesId, record);
  }
  return [...latest.values()].sort((left, right) => left.seriesId.localeCompare(right.seriesId));
}

/** Return only the latest enabled active version in every Gold Set series. */
export function selectActiveGoldSets(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("Gold Set 列表必须是数组");
  return selectLatestActive(records, normalizeGoldSet, options);
}

/** Flatten the exact benchmark cases while retaining version provenance. */
export function selectActiveGoldSamples(records, options = {}) {
  return selectActiveGoldSets(records, options).flatMap((set) => set.samples
    .filter((sample) => sample.enabled)
    .map((sample) => ({
      ...cloneJson(sample),
      goldSetId: set.id,
      goldSeriesId: set.seriesId,
      goldSetVersion: set.version,
      goldSetFingerprint: set.fingerprint
    })));
}

function normalizeIssue(issue, index) {
  if (!isPlainObject(issue)) throw new TypeError(`QA 问题第 ${index + 1} 项必须是对象`);
  const category = optionalText(issue.category || issue.type).toLowerCase();
  const message = optionalText(issue.message || issue.reason);
  if (!category && !message) throw new TypeError(`QA 问题第 ${index + 1} 项缺少 category 或 message`);
  const severity = optionalText(issue.severity || "major").toLowerCase();
  if (!ISSUE_SEVERITIES.has(severity)) throw new TypeError(`QA 问题第 ${index + 1} 项 severity 无效：${severity}`);
  return {
    dimension: optionalText(issue.dimension) || "quality",
    category: category || "other",
    severity,
    sourceSpan: optionalText(issue.sourceSpan),
    targetSpan: optionalText(issue.targetSpan || issue.span),
    message,
    suggestion: optionalText(issue.suggestion)
  };
}

function qaCaseWasHumanApproved(qaCase) {
  return qaCase.status === "human_approved"
    || qaCase.humanApproval?.approved === true
    || qaCase.approval?.decision === "approve";
}

/**
 * Turn a human-approved QA failure into a pending regression candidate. It is
 * deliberately not runnable yet: a second explicit approval promotes it.
 */
export function createRegressionCandidateFromQaCase(qaCase = {}, options = {}) {
  if (!isPlainObject(qaCase)) throw new TypeError("QA 案例必须是对象");
  if (!qaCaseWasHumanApproved(qaCase)) throw new RangeError("只有人工批准的 QA 失败案例才能生成回归候选");
  const qaCaseId = requiredText(qaCase.id, "QA 案例 id");
  const scope = normalizeLearningScope(options.scope || qaCase.scope || {
    locale: qaCase.locale,
    contentType: qaCase.contentType,
    domain: qaCase.domain,
    project: options.project || qaCase.project || "default"
  });
  const failingTranslation = requiredText(qaCase.rejectedTranslation ?? qaCase.initialTranslation, "QA 案例错误译文");
  const expectedTranslation = requiredText(qaCase.correctedTranslation ?? qaCase.finalTranslation, "QA 案例修正译文");
  if (failingTranslation === expectedTranslation) throw new RangeError("错误译文与修正译文相同，不能形成失败回归案例");
  const issues = (Array.isArray(qaCase.issues) ? qaCase.issues : []).map(normalizeIssue);
  if (!issues.length && !(Number(qaCase.scoreBefore) < Number(qaCase.scoreAfter))) {
    throw new RangeError("QA 失败案例缺少问题证据或明确的修复前后分数提升");
  }
  const normalized = {
    schemaVersion: QUALITY_ASSET_SCHEMA_VERSION,
    kind: "regression_candidate",
    id: optionalText(options.id) || `regression-candidate:${qaCaseId}`,
    status: "pending",
    scope: cloneJson(scope),
    scopeKey: learningScopeKey(scope),
    sourceQaCaseId: qaCaseId,
    sourceQaCaseStatus: optionalText(qaCase.status),
    source: requiredText(qaCase.source, "QA 案例 source"),
    failingTranslation,
    expectedTranslation,
    issues,
    requiredTerms: (qaCase.requiredTerms || []).map(normalizeRequiredTerm),
    facts: (qaCase.facts || []).map(normalizeFact),
    scoreBefore: Number.isFinite(Number(qaCase.scoreBefore)) ? Number(qaCase.scoreBefore) : null,
    scoreAfter: Number.isFinite(Number(qaCase.scoreAfter)) ? Number(qaCase.scoreAfter) : null,
    createdAt: optionalText(options.createdAt),
    createdBy: optionalText(options.createdBy),
    approval: null,
    metadata: cloneJson(isPlainObject(options.metadata) ? options.metadata : {})
  };
  normalized.fingerprint = fingerprint({
    scope: normalized.scope,
    sourceQaCaseId: normalized.sourceQaCaseId,
    source: normalized.source,
    failingTranslation: normalized.failingTranslation,
    expectedTranslation: normalized.expectedTranslation,
    issues: normalized.issues,
    requiredTerms: normalized.requiredTerms,
    facts: normalized.facts
  });
  return normalized;
}

export function normalizeRegressionCandidate(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("回归候选必须是对象");
  const status = optionalText(input.status).toLowerCase();
  if (!REGRESSION_CANDIDATE_STATUSES.includes(status)) throw new TypeError(`回归候选状态无效：${status || "空"}`);
  const scope = normalizeLearningScope(input.scope || input);
  const normalized = {
    ...cloneJson(input),
    schemaVersion: QUALITY_ASSET_SCHEMA_VERSION,
    kind: "regression_candidate",
    id: requiredText(input.id, "回归候选 id"),
    status,
    scope: cloneJson(scope),
    scopeKey: learningScopeKey(scope),
    sourceQaCaseId: requiredText(input.sourceQaCaseId, "回归候选 sourceQaCaseId"),
    source: requiredText(input.source, "回归候选 source"),
    failingTranslation: requiredText(input.failingTranslation, "回归候选 failingTranslation"),
    expectedTranslation: requiredText(input.expectedTranslation, "回归候选 expectedTranslation"),
    issues: (input.issues || []).map(normalizeIssue),
    requiredTerms: (input.requiredTerms || []).map(normalizeRequiredTerm),
    facts: (input.facts || []).map(normalizeFact),
    approval: input.approval ? cloneJson(input.approval) : null
  };
  if (normalized.failingTranslation === normalized.expectedTranslation) throw new RangeError("回归候选错误译文与期望译文不能相同");
  if (["approved", "rejected"].includes(status)) {
    if (!isPlainObject(normalized.approval)) throw new TypeError(`${status} 回归候选缺少人工审批记录`);
    requiredText(normalized.approval.reviewer, "回归候选审批人");
    const expectedDecision = status === "approved" ? "approve" : "reject";
    if (normalized.approval.decision !== expectedDecision) throw new RangeError(`回归候选状态与审批决定不一致：${status}`);
  }
  normalized.fingerprint = optionalText(input.fingerprint) || fingerprint({
    scope: normalized.scope,
    sourceQaCaseId: normalized.sourceQaCaseId,
    source: normalized.source,
    failingTranslation: normalized.failingTranslation,
    expectedTranslation: normalized.expectedTranslation,
    issues: normalized.issues,
    requiredTerms: normalized.requiredTerms,
    facts: normalized.facts
  });
  return normalized;
}

/** Apply the explicit second human gate required before suite admission. */
export function decideRegressionCandidate(input, { decision, reviewer, decidedAt = "", note = "" } = {}) {
  const candidate = normalizeRegressionCandidate(input);
  if (candidate.status !== "pending") throw new RangeError(`只能审批 pending 回归候选，当前为 ${candidate.status}`);
  const normalizedDecision = optionalText(decision).toLowerCase();
  if (!["approve", "reject"].includes(normalizedDecision)) throw new TypeError("回归候选审批决定只能是 approve 或 reject");
  const normalizedNote = optionalText(note);
  if (normalizedDecision === "reject" && !normalizedNote) throw new TypeError("拒绝回归候选时必须填写原因");
  return {
    ...candidate,
    status: normalizedDecision === "approve" ? "approved" : "rejected",
    approval: {
      decision: normalizedDecision,
      reviewer: requiredText(reviewer, "回归候选审批人"),
      decidedAt: optionalText(decidedAt),
      note: normalizedNote
    }
  };
}

function regressionCaseFromCandidate(candidate) {
  return {
    id: candidate.id,
    scope: cloneJson(candidate.scope),
    sourceQaCaseId: candidate.sourceQaCaseId,
    source: candidate.source,
    failingTranslation: candidate.failingTranslation,
    expectedTranslation: candidate.expectedTranslation,
    issues: cloneJson(candidate.issues),
    requiredTerms: cloneJson(candidate.requiredTerms),
    facts: cloneJson(candidate.facts),
    approval: cloneJson(candidate.approval),
    fingerprint: candidate.fingerprint
  };
}

/** Build a versioned suite; a pending/rejected candidate is a hard error. */
export function normalizeRegressionSuite(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("Regression Suite 必须是对象");
  const scope = normalizeLearningScope(input.scope || input);
  const id = requiredText(input.id, "Regression Suite id");
  const lifecycle = normalizeLifecycle(input, REGRESSION_SUITE_STATUSES);
  const rawCandidates = input.candidates ?? input.cases ?? [];
  if (!Array.isArray(rawCandidates)) throw new TypeError("Regression Suite candidates 必须是数组");
  const candidates = rawCandidates.map((candidate) => normalizeRegressionCandidate({
    ...candidate,
    status: candidate?.status || (candidate?.approval?.decision === "approve" ? "approved" : candidate?.approval?.decision === "reject" ? "rejected" : "pending")
  }));
  for (const candidate of candidates) {
    assertExactLearningScope(scope, candidate.scope, `回归候选 ${candidate.id} `);
    if (candidate.status !== "approved") throw new RangeError(`回归候选 ${candidate.id} 尚未人工批准，不能进入 Regression Suite`);
  }
  const qaIds = candidates.map((candidate) => candidate.sourceQaCaseId);
  if (new Set(qaIds).size !== qaIds.length) throw new RangeError("Regression Suite 内存在重复 QA 案例");
  if (lifecycle.status === "active" && !candidates.length) throw new RangeError("active Regression Suite 不能是空集");
  const cases = candidates.map(regressionCaseFromCandidate);
  const normalized = {
    schemaVersion: QUALITY_ASSET_SCHEMA_VERSION,
    kind: "regression_suite",
    id,
    seriesId: optionalText(input.seriesId) || id,
    version: positiveVersion(input.version),
    parentVersionId: optionalText(input.parentVersionId),
    scope: cloneJson(scope),
    scopeKey: learningScopeKey(scope),
    name: requiredText(input.name, "Regression Suite name"),
    description: optionalText(input.description),
    ...lifecycle,
    cases,
    createdAt: optionalText(input.createdAt),
    createdBy: optionalText(input.createdBy),
    changeNote: optionalText(input.changeNote),
    metadata: cloneJson(isPlainObject(input.metadata) ? input.metadata : {})
  };
  normalized.fingerprint = fingerprint({
    schemaVersion: normalized.schemaVersion,
    seriesId: normalized.seriesId,
    version: normalized.version,
    scope: normalized.scope,
    cases: normalized.cases
  });
  return normalized;
}

export const buildRegressionSuite = normalizeRegressionSuite;

/** Return only the latest enabled active version in every suite series. */
export function selectActiveRegressionSuites(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("Regression Suite 列表必须是数组");
  return selectLatestActive(records, normalizeRegressionSuite, options);
}

export function selectActiveRegressionCases(records, options = {}) {
  return selectActiveRegressionSuites(records, options).flatMap((suite) => suite.cases.map((item) => ({
    ...cloneJson(item),
    regressionSuiteId: suite.id,
    regressionSeriesId: suite.seriesId,
    regressionSuiteVersion: suite.version,
    regressionSuiteFingerprint: suite.fingerprint
  })));
}
