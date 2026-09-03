import { createHash } from "node:crypto";
import { learningScopeKey, normalizeLearningScope } from "./learning-engine.mjs";

/**
 * Fine-tune / distillation pipeline.
 *
 * The GPU step happens outside this repo — that is the one part a localization
 * workbench should not own. Everything that makes such a run trustworthy does
 * live here: the dataset is frozen and fingerprinted before submission, the
 * recipe is recorded, the resulting model is registered as an artifact, and it
 * cannot serve production traffic until it has passed the same fixed Gold Set
 * and failure-regression gate every other candidate must pass.
 *
 * A run therefore carries its own provenance: which scope, which dataset
 * fingerprint, which base model, which recipe, and which gate result.
 */
export const TRAINING_PIPELINE_SCHEMA_VERSION = 1;
export const TRAINING_METHODS = Object.freeze(["sft", "dpo", "distillation"]);
export const TRAINING_STATUSES = Object.freeze([
  "draft",
  "frozen",
  "submitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "registered",
  "promoted"
]);

/** 合法状态迁移。任何一步都不允许跳过冻结数据集和门禁。 */
const TRANSITIONS = Object.freeze({
  draft: ["frozen", "cancelled"],
  frozen: ["submitted", "cancelled"],
  submitted: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: ["registered", "failed"],
  failed: [],
  cancelled: [],
  registered: ["promoted", "failed"],
  promoted: []
});

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const result = text(value);
  if (!result) throw new TypeError(`${label}不能为空`);
  return result;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label}必须是正整数`);
  return number;
}

/**
 * Freeze a dataset for training. The fingerprint covers the serialized content,
 * so anyone can recompute it from the exported file and prove the run used
 * exactly this data. An empty dataset is refused: an unreproducible run with no
 * examples is worse than no run.
 */
export function freezeTrainingDataset({ kind, jsonl = "", audit = null, manifest = null, scope } = {}) {
  const normalizedKind = requiredText(kind, "数据集类型").toLowerCase();
  if (!["sft", "dpo"].includes(normalizedKind)) throw new TypeError(`不支持的数据集类型：${normalizedKind}`);
  const content = String(jsonl ?? "");
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new RangeError("空数据集不能冻结用于训练");
  for (const [index, line] of lines.entries()) {
    try {
      JSON.parse(line);
    } catch {
      throw new TypeError(`数据集第 ${index + 1} 行不是合法 JSON`);
    }
  }
  const normalizedScope = normalizeLearningScope(scope);
  return {
    schemaVersion: TRAINING_PIPELINE_SCHEMA_VERSION,
    kind: normalizedKind,
    scope: cloneJson(normalizedScope),
    scopeKey: learningScopeKey(normalizedScope),
    recordCount: lines.length,
    byteSize: Buffer.byteLength(content, "utf8"),
    // 指纹算在序列化内容上：拿到导出文件的人可以自己复算并核对。
    contentFingerprint: createHash("sha256").update(content, "utf8").digest("hex"),
    audit: isPlainObject(audit) ? cloneJson(audit) : null,
    manifest: isPlainObject(manifest) ? cloneJson(manifest) : null
  };
}

function normalizeRecipe(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("训练配方必须是对象");
  const method = requiredText(input.method, "训练方法").toLowerCase();
  if (!TRAINING_METHODS.includes(method)) throw new TypeError(`不支持的训练方法：${method}`);
  const recipe = {
    method,
    baseModel: requiredText(input.baseModel, "基座模型"),
    // 蒸馏必须写清教师模型，否则没法解释学生模型的能力从哪来。
    teacherModel: text(input.teacherModel),
    epochs: input.epochs === undefined ? 3 : positiveInteger(input.epochs, "训练轮数"),
    learningRate: input.learningRate === undefined ? 0.0001 : Number(input.learningRate),
    batchSize: input.batchSize === undefined ? 8 : positiveInteger(input.batchSize, "批大小"),
    loraRank: input.loraRank === undefined ? null : positiveInteger(input.loraRank, "LoRA 秩"),
    extra: isPlainObject(input.extra) ? cloneJson(input.extra) : {}
  };
  if (!Number.isFinite(recipe.learningRate) || recipe.learningRate <= 0) throw new TypeError("学习率必须是正数");
  if (method === "distillation" && !recipe.teacherModel) throw new TypeError("蒸馏必须指定教师模型");
  return recipe;
}

/** Create a training run. It starts in `draft` and owns no artifact yet. */
export function createTrainingRun({ scope, name = "", recipe, datasets = [], createdBy = "", createdAt = "", note = "" } = {}) {
  const normalizedScope = normalizeLearningScope(scope);
  const normalizedRecipe = normalizeRecipe(recipe);
  const frozen = (Array.isArray(datasets) ? datasets : []).map((dataset, index) => {
    if (!isPlainObject(dataset) || !dataset.contentFingerprint) throw new TypeError(`数据集第 ${index + 1} 项必须是已冻结的数据集`);
    return cloneJson(dataset);
  });
  if (!frozen.length) throw new RangeError("训练任务至少需要一个已冻结的数据集");
  if (normalizedRecipe.method === "dpo" && !frozen.some((dataset) => dataset.kind === "dpo")) {
    throw new RangeError("DPO 训练必须包含偏好数据集");
  }
  if (normalizedRecipe.method !== "dpo" && !frozen.some((dataset) => dataset.kind === "sft")) {
    throw new RangeError("监督微调与蒸馏必须包含 SFT 数据集");
  }
  const run = {
    schemaVersion: TRAINING_PIPELINE_SCHEMA_VERSION,
    kind: "training_run",
    scope: cloneJson(normalizedScope),
    scopeKey: learningScopeKey(normalizedScope),
    name: text(name) || `${normalizedScope.locale} ${normalizedRecipe.method} 训练`,
    status: "draft",
    recipe: normalizedRecipe,
    datasets: frozen,
    totalRecords: frozen.reduce((sum, dataset) => sum + dataset.recordCount, 0),
    artifact: null,
    gate: null,
    externalJobId: "",
    error: "",
    note: text(note),
    createdBy: text(createdBy),
    createdAt: text(createdAt),
    history: []
  };
  run.fingerprint = fingerprint({
    scope: run.scope,
    recipe: run.recipe,
    datasets: frozen.map((dataset) => ({ kind: dataset.kind, contentFingerprint: dataset.contentFingerprint }))
  });
  return run;
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Advance a run. Every transition is recorded with its reason, so a promoted
 * model can always be traced back through its gate result, its artifact, its
 * dataset fingerprints and its recipe.
 */
export function advanceTrainingRun(run, { status, at = "", by = "", note = "", externalJobId, artifact, gate, error } = {}) {
  if (!isPlainObject(run)) throw new TypeError("训练任务必须是对象");
  const from = text(run.status) || "draft";
  const to = requiredText(status, "目标状态").toLowerCase();
  if (!TRAINING_STATUSES.includes(to)) throw new TypeError(`不支持的训练状态：${to}`);
  if (!canTransition(from, to)) throw new RangeError(`训练任务不能从 ${from} 直接进入 ${to}`);

  const next = { ...cloneJson(run), status: to };
  if (externalJobId !== undefined) next.externalJobId = text(externalJobId);
  if (error !== undefined) next.error = text(error);

  if (to === "registered") {
    if (!isPlainObject(artifact)) throw new TypeError("登记训练产物必须提供 artifact");
    next.artifact = {
      modelId: requiredText(artifact.modelId, "产出模型 ID"),
      modelRole: text(artifact.modelRole) || "candidate",
      adapterUri: text(artifact.adapterUri),
      baseModel: text(artifact.baseModel) || next.recipe.baseModel,
      registeredAt: text(artifact.registeredAt) || text(at),
      registeredBy: text(artifact.registeredBy) || text(by),
      metrics: isPlainObject(artifact.metrics) ? cloneJson(artifact.metrics) : {}
    };
  }

  if (to === "promoted") {
    if (!next.artifact) throw new RangeError("尚未登记训练产物，不能投入生产");
    // 微调模型和其它候选走同一道门：固定 Gold Set 与失败回归必须先通过。
    if (!isPlainObject(gate)) throw new TypeError("投入生产必须提供质量门禁结果");
    if (gate.decision !== "pass") throw new RangeError(`质量门禁未通过（${gate.decision || "未知"}），微调模型不能投入生产`);
    next.gate = {
      decision: "pass",
      runId: text(gate.runId),
      regressionPassRate: Number.isFinite(Number(gate.regressionPassRate)) ? Number(gate.regressionPassRate) : null,
      goldTermAccuracy: Number.isFinite(Number(gate.goldTermAccuracy)) ? Number(gate.goldTermAccuracy) : null,
      checkedAt: text(gate.checkedAt) || text(at)
    };
  }

  next.history = [...(Array.isArray(run.history) ? run.history : []), {
    from,
    to,
    at: text(at),
    by: text(by),
    note: text(note)
  }];
  return next;
}

/**
 * The hand-off manifest for the external trainer. It deliberately contains no
 * credentials and no raw data — only what identifies the run and lets the
 * trainer verify it received the exact dataset that was frozen.
 */
export function buildTrainingManifest(run) {
  if (!isPlainObject(run)) throw new TypeError("训练任务必须是对象");
  return {
    schemaVersion: TRAINING_PIPELINE_SCHEMA_VERSION,
    runFingerprint: run.fingerprint,
    name: run.name,
    scope: cloneJson(run.scope),
    scopeKey: run.scopeKey,
    recipe: cloneJson(run.recipe),
    datasets: (run.datasets || []).map((dataset) => ({
      kind: dataset.kind,
      recordCount: dataset.recordCount,
      byteSize: dataset.byteSize,
      contentFingerprint: dataset.contentFingerprint,
      filename: `kami-${dataset.kind}-${dataset.scopeKey || run.scopeKey}.jsonl`
    })),
    totalRecords: run.totalRecords,
    createdAt: run.createdAt,
    createdBy: run.createdBy,
    verification: "对每个数据集文件计算 sha256，应与 contentFingerprint 完全一致；不一致说明训练用的数据不是这次冻结的数据。"
  };
}
