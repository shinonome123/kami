import { createHash } from "node:crypto";
import { assertExactLearningScope, learningScopeKey, normalizeLearningScope, scopesEqual } from "./learning-engine.mjs";
import { normalizeSource } from "./text.mjs";

/**
 * Export human-owned outcomes as supervised (SFT) and preference (DPO) training
 * data. Every record must survive the same audit: it is human-accepted, it is
 * not a duplicate, and it does not overlap the fixed evaluation assets. A
 * dataset that silently contains its own benchmark cannot measure anything, so
 * leakage is a hard drop, never a warning.
 */
export const TRAINING_EXPORT_SCHEMA_VERSION = 1;
export const TRAINING_DATASET_KINDS = Object.freeze(["sft", "dpo"]);

export const DEFAULT_EXPORT_LIMITS = Object.freeze({
  minimumSourceLength: 2,
  minimumTargetLength: 1,
  maximumSourceLength: 4000,
  maximumTargetLength: 6000,
  minimumPreferenceDistance: 1
});

export const DROP_REASONS = Object.freeze({
  NOT_COMPLETED: "not_completed",
  NOT_HUMAN_ACCEPTED: "not_human_accepted",
  SCOPE_MISMATCH: "scope_mismatch",
  EMPTY_SOURCE: "empty_source",
  EMPTY_TARGET: "empty_target",
  TOO_SHORT: "too_short",
  TOO_LONG: "too_long",
  DUPLICATE: "duplicate",
  EVALUATION_LEAKAGE: "evaluation_leakage",
  NO_PREFERENCE_SIGNAL: "no_preference_signal",
  IDENTICAL_PAIR: "identical_pair"
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function fingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function humanFinalTranslation(trajectory) {
  return text(trajectory?.humanDecision?.finalTranslation) || text(trajectory?.finalTranslation);
}

function machineTranslation(trajectory) {
  return text(trajectory?.initialTranslation);
}

/**
 * Build the exclusion index from the fixed assets. Matching is on normalized
 * source text, because a benchmark case that was merely re-typed is still the
 * same test item.
 */
export function buildEvaluationIndex({ goldSamples = [], regressionCases = [] } = {}) {
  const sources = new Set();
  for (const sample of Array.isArray(goldSamples) ? goldSamples : []) {
    const key = normalizeSource(text(sample?.source));
    if (key) sources.add(key);
  }
  for (const item of Array.isArray(regressionCases) ? regressionCases : []) {
    const key = normalizeSource(text(item?.source));
    if (key) sources.add(key);
  }
  return sources;
}

function scopeOf(record) {
  return normalizeLearningScope({
    locale: record.locale,
    contentType: record.contentType,
    domain: record.domain,
    project: record.project
  });
}

function lengthVerdict(source, target, limits) {
  if (source.length < limits.minimumSourceLength || target.length < limits.minimumTargetLength) return DROP_REASONS.TOO_SHORT;
  if (source.length > limits.maximumSourceLength || target.length > limits.maximumTargetLength) return DROP_REASONS.TOO_LONG;
  return "";
}

function systemPrompt(scope, options = {}) {
  const parts = [
    `你是${scope.locale}本地化写作者。`,
    `内容语体：${scope.contentType}；业务领域：${scope.domain}；项目：${scope.project}。`,
    "严格保留数字、日期、平台、地区、URL 和占位符，遵循已批准术语与风格规则，输出可直接发布的译文。"
  ];
  if (options.instruction) parts.push(text(options.instruction));
  return parts.join("");
}

function auditor() {
  const dropped = [];
  return {
    dropped,
    drop(id, reason, detail = "") {
      dropped.push({ id: text(id), reason, detail: text(detail) });
    },
    report(kept, total) {
      const byReason = {};
      for (const item of dropped) byReason[item.reason] = (byReason[item.reason] || 0) + 1;
      return {
        input: total,
        kept,
        dropped: dropped.length,
        droppedByReason: byReason,
        samples: dropped.slice(0, 50)
      };
    }
  };
}

/**
 * Supervised dataset from accepted human final translations. The assistant turn
 * is always the human wording, never the machine draft.
 */
export function buildSftDataset(trajectories = [], { scope, evaluationIndex = null, limits = {}, instruction = "" } = {}) {
  if (!Array.isArray(trajectories)) throw new TypeError("训练轨迹必须是数组");
  const normalizedScope = scope ? normalizeLearningScope(scope) : null;
  const merged = { ...DEFAULT_EXPORT_LIMITS, ...(isPlainObject(limits) ? limits : {}) };
  const excluded = evaluationIndex instanceof Set ? evaluationIndex : buildEvaluationIndex(evaluationIndex || {});
  const audit = auditor();
  const seen = new Set();
  const records = [];

  for (const trajectory of trajectories) {
    if (!isPlainObject(trajectory)) continue;
    const id = text(trajectory.id);
    if (trajectory.status !== "completed") {
      audit.drop(id, DROP_REASONS.NOT_COMPLETED, text(trajectory.status));
      continue;
    }
    if (trajectory.humanDecision?.accepted !== true) {
      audit.drop(id, DROP_REASONS.NOT_HUMAN_ACCEPTED);
      continue;
    }
    let recordScope;
    try {
      recordScope = scopeOf(trajectory);
    } catch (error) {
      audit.drop(id, DROP_REASONS.SCOPE_MISMATCH, error.message);
      continue;
    }
    if (normalizedScope && !scopesEqual(normalizedScope, recordScope)) {
      audit.drop(id, DROP_REASONS.SCOPE_MISMATCH, learningScopeKey(recordScope));
      continue;
    }
    const source = text(trajectory.source).trim();
    const target = humanFinalTranslation(trajectory).trim();
    if (!source) {
      audit.drop(id, DROP_REASONS.EMPTY_SOURCE);
      continue;
    }
    if (!target) {
      audit.drop(id, DROP_REASONS.EMPTY_TARGET);
      continue;
    }
    const lengthDrop = lengthVerdict(source, target, merged);
    if (lengthDrop) {
      audit.drop(id, lengthDrop, `${source.length}/${target.length}`);
      continue;
    }
    const sourceKey = normalizeSource(source);
    if (excluded.has(sourceKey)) {
      audit.drop(id, DROP_REASONS.EVALUATION_LEAKAGE, source.slice(0, 60));
      continue;
    }
    const key = fingerprint([learningScopeKey(recordScope), sourceKey, normalizeSource(target)]);
    if (seen.has(key)) {
      audit.drop(id, DROP_REASONS.DUPLICATE, key);
      continue;
    }
    seen.add(key);
    records.push({
      id: id || key,
      fingerprint: key,
      scope: recordScope,
      scopeKey: learningScopeKey(recordScope),
      messages: [
        { role: "system", content: systemPrompt(recordScope, { instruction }) },
        { role: "user", content: source },
        { role: "assistant", content: target }
      ],
      metadata: {
        trajectoryId: id,
        batchId: text(trajectory.batchId),
        model: text(trajectory.model),
        promptVersion: text(trajectory.promptVersion),
        createdAt: text(trajectory.createdAt)
      }
    });
  }

  return {
    schemaVersion: TRAINING_EXPORT_SCHEMA_VERSION,
    kind: "sft",
    scope: normalizedScope,
    scopeKey: normalizedScope ? learningScopeKey(normalizedScope) : "",
    records,
    audit: audit.report(records.length, trajectories.length)
  };
}

function preferencePair({ source, chosen, rejected, limits }) {
  if (!source) return DROP_REASONS.EMPTY_SOURCE;
  if (!chosen) return DROP_REASONS.EMPTY_TARGET;
  if (!rejected) return DROP_REASONS.NO_PREFERENCE_SIGNAL;
  if (normalizeSource(chosen) === normalizeSource(rejected)) return DROP_REASONS.IDENTICAL_PAIR;
  return lengthVerdict(source, chosen, limits);
}

/**
 * Preference dataset. Two independent signals qualify: a human rewrote the
 * machine draft (chosen = human final), or a human approved a QA correction
 * (chosen = corrected wording). Both carry an explicit human decision.
 */
export function buildDpoDataset({ trajectories = [], qaCases = [] } = {}, { scope, evaluationIndex = null, limits = {}, instruction = "" } = {}) {
  const normalizedScope = scope ? normalizeLearningScope(scope) : null;
  const merged = { ...DEFAULT_EXPORT_LIMITS, ...(isPlainObject(limits) ? limits : {}) };
  const excluded = evaluationIndex instanceof Set ? evaluationIndex : buildEvaluationIndex(evaluationIndex || {});
  const audit = auditor();
  const seen = new Set();
  const records = [];
  const inputs = [];

  for (const trajectory of Array.isArray(trajectories) ? trajectories : []) {
    if (!isPlainObject(trajectory)) continue;
    inputs.push({
      id: text(trajectory.id),
      origin: "trajectory",
      record: trajectory,
      completed: trajectory.status === "completed",
      accepted: trajectory.humanDecision?.accepted === true,
      source: text(trajectory.source).trim(),
      chosen: humanFinalTranslation(trajectory).trim(),
      rejected: machineTranslation(trajectory).trim()
    });
  }
  for (const qaCase of Array.isArray(qaCases) ? qaCases : []) {
    if (!isPlainObject(qaCase)) continue;
    inputs.push({
      id: text(qaCase.id),
      origin: "qa_case",
      record: qaCase,
      completed: true,
      accepted: qaCase.status === "human_approved" || qaCase.approval?.decision === "approve",
      source: text(qaCase.source).trim(),
      chosen: text(qaCase.correctedTranslation ?? qaCase.corrected_translation).trim(),
      rejected: text(qaCase.rejectedTranslation ?? qaCase.rejected_translation).trim()
    });
  }

  for (const entry of inputs) {
    if (!entry.completed) {
      audit.drop(entry.id, DROP_REASONS.NOT_COMPLETED);
      continue;
    }
    if (!entry.accepted) {
      audit.drop(entry.id, DROP_REASONS.NOT_HUMAN_ACCEPTED);
      continue;
    }
    let recordScope;
    try {
      recordScope = scopeOf(entry.record);
    } catch (error) {
      audit.drop(entry.id, DROP_REASONS.SCOPE_MISMATCH, error.message);
      continue;
    }
    if (normalizedScope && !scopesEqual(normalizedScope, recordScope)) {
      audit.drop(entry.id, DROP_REASONS.SCOPE_MISMATCH, learningScopeKey(recordScope));
      continue;
    }
    const drop = preferencePair({ source: entry.source, chosen: entry.chosen, rejected: entry.rejected, limits: merged });
    if (drop) {
      audit.drop(entry.id, drop);
      continue;
    }
    const sourceKey = normalizeSource(entry.source);
    if (excluded.has(sourceKey)) {
      audit.drop(entry.id, DROP_REASONS.EVALUATION_LEAKAGE, entry.source.slice(0, 60));
      continue;
    }
    const key = fingerprint([learningScopeKey(recordScope), sourceKey, normalizeSource(entry.chosen), normalizeSource(entry.rejected)]);
    if (seen.has(key)) {
      audit.drop(entry.id, DROP_REASONS.DUPLICATE, key);
      continue;
    }
    seen.add(key);
    records.push({
      id: entry.id || key,
      fingerprint: key,
      scope: recordScope,
      scopeKey: learningScopeKey(recordScope),
      origin: entry.origin,
      system: systemPrompt(recordScope, { instruction }),
      prompt: entry.source,
      chosen: entry.chosen,
      rejected: entry.rejected,
      metadata: {
        sourceId: entry.id,
        model: text(entry.record.model),
        promptVersion: text(entry.record.promptVersion),
        scoreBefore: Number.isFinite(Number(entry.record.scoreBefore)) ? Number(entry.record.scoreBefore) : null,
        scoreAfter: Number.isFinite(Number(entry.record.scoreAfter)) ? Number(entry.record.scoreAfter) : null,
        createdAt: text(entry.record.createdAt)
      }
    });
  }

  return {
    schemaVersion: TRAINING_EXPORT_SCHEMA_VERSION,
    kind: "dpo",
    scope: normalizedScope,
    scopeKey: normalizedScope ? learningScopeKey(normalizedScope) : "",
    records,
    audit: audit.report(records.length, inputs.length)
  };
}

/** Serialize a dataset to JSONL in the shape each trainer actually consumes. */
export function datasetToJsonl(dataset) {
  if (!isPlainObject(dataset) || !Array.isArray(dataset.records)) throw new TypeError("导出数据集格式无效");
  if (!TRAINING_DATASET_KINDS.includes(dataset.kind)) throw new TypeError(`不支持的数据集类型：${dataset.kind}`);
  return dataset.records.map((record) => JSON.stringify(dataset.kind === "sft"
    ? { messages: record.messages }
    : { prompt: record.prompt, chosen: record.chosen, rejected: record.rejected, system: record.system }))
    .join("\n");
}

/**
 * One audited bundle for a scope. The manifest records exactly which fixed
 * assets were excluded, so a later reviewer can prove the training data and the
 * benchmark never overlapped.
 */
export function buildTrainingExport({ trajectories = [], qaCases = [], goldSamples = [], regressionCases = [] } = {}, options = {}) {
  const scope = options.scope ? normalizeLearningScope(options.scope) : null;
  if (scope) {
    for (const sample of goldSamples) {
      if (sample?.scope) assertExactLearningScope(scope, sample.scope, `Gold 样本 ${sample.id || ""} `);
    }
  }
  const evaluationIndex = buildEvaluationIndex({ goldSamples, regressionCases });
  const sft = buildSftDataset(trajectories, { ...options, scope, evaluationIndex });
  const dpo = buildDpoDataset({ trajectories, qaCases }, { ...options, scope, evaluationIndex });
  return {
    schemaVersion: TRAINING_EXPORT_SCHEMA_VERSION,
    scope,
    scopeKey: scope ? learningScopeKey(scope) : "",
    manifest: {
      excludedEvaluationSources: evaluationIndex.size,
      goldSampleCount: goldSamples.length,
      regressionCaseCount: regressionCases.length,
      trajectoryCount: trajectories.length,
      qaCaseCount: qaCases.length
    },
    sft,
    dpo
  };
}
