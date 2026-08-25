import http from "node:http";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_TYPES, LOCALES, assertLocale } from "./src/config.mjs";
import { classifyContent, descriptorFromContext, resolveDomain } from "./src/classifier.mjs";
import { buildContextPack } from "./src/context-pack.mjs";
import { refineCorpus } from "./src/corpus.mjs";
import { matchTerms } from "./src/matcher.mjs";
import { adjudicatePotentialTermsWithModel, alignSegmentsWithModel, alignTermSuggestionsWithModel, analyzeSpreadsheetStructureWithModel, analyzeTermTableStructureWithModel, classifyWithModel, costPricingConfigured, embed, evaluateAutoQaWithModel, evaluateGrammarWithModel, evaluateTranslationWithModel, getProviderConfig, glossTranslationWithModel, isEmbeddingConfigured, probeModelAvailability, reviewTermCandidatesWithModel, reviseTranslationWithQa, translateWithReflection, updateProviderConfig } from "./src/provider.mjs";
import { DISTILL_THRESHOLD, distillBatchStyleLearning, distillStyleProfileIfReady, runEvolutionReview } from "./src/evolution.mjs";
import { calculateQaScore, presentAiQaIssues, runQa } from "./src/qa.mjs";
import { alignSegmentPairs, buildAlignmentIssues, calculateAutoQaScores, cosineSimilarity, createStructuralAlignmentScorer, dedupeIssues, normalizeQaInputText, runBasicQa, splitQaSegments, summarizeIssues } from "./src/auto-qa.mjs";
import { DATA_ROOT, completeImport, deleteAsset, getAssets, getAssetStats, getMemories, getQaCases, getQaRuns, getStoreFallbackInfo, getStoreMetadata, getStyleEvidence, getStyleLearningRuns, getStyleProfile, getUserProfile, initializeStore, rebuildEmbeddings, saveAsset, saveCorpus, saveImportPreview, saveMemory, saveQaCase, saveQaRun, saveStyleEvidence, saveStyleLearningRun, saveStyleProfileEvaluation, findStyleProfile, demoteMemories, approveQaCase, saveBatchRun, getBatchRun, listBatchRuns, listStyleProfiles, activateStyleProfile, rejectStyleProfile, listPendingQaCases, disposeQaCase, saveLearningTrajectory, listLearningTrajectories, getLearningTrajectory, updateLearningTrajectory, saveTranslationSkill, listTranslationSkills, getTranslationSkill, updateTranslationSkill, activateTranslationSkill, rollbackTranslationSkill, saveSkillEvaluation, listSkillEvaluations, saveQaTask, getQaTask, listQaTasks, deleteQaTask, saveShare, getShare, listShares, updateShare, deleteShare, saveBackgroundTask, getBackgroundTask, listBackgroundTasks, deleteBackgroundTask } from "./src/store.mjs";
import { applyModelDecisions, classifyImportCandidate, expandNestedTermCandidates, extractTermPairs } from "./src/table-term-extractor.mjs";
import { buildSuggestionCandidates, resolveTermSuggestions } from "./src/term-suggestions.mjs";
import { narrowByDomain, rankQaCases, rankTranslationMemories, splitReferenceAuthority } from "./src/translation-memory.mjs";
import { embedSource } from "./src/embedding.mjs";
import { exportBatchDocument, prepareBatchDocument } from "./src/batch-document.mjs";
import { runTaskPool } from "./src/task-pool.mjs";
import { createDefaultTranslationSkill, evaluateSkillPromotion, normalizedEditDistance, selectSkillHoldout, summarizeTrajectoryAttribution, validateCandidatePromotionState } from "./src/learning-engine.mjs";
import { benchmarkTranslationSkill } from "./src/skill-benchmark.mjs";
import { createEvaluationJobRunner } from "./src/evaluation-jobs.mjs";
import { detectBatchVerse } from "./src/batch-verse.mjs";
import { createAutoProposer } from "./src/auto-proposal.mjs";
import { classifyChange, isNegativeEvidence, positiveEvidenceOnly } from "./src/style-delta.mjs";
import { NO_STYLE_PROFILE_ID, STYLE_MIN_EVALUATION_SAMPLES, STYLE_PROMOTION_GUARDRAILS, benchmarkStyleVariant, selectStyleHoldout, styleVariant, validateStylePromotionState } from "./src/style-benchmark.mjs";
import { proposeChallengerSkill, selectProposalTrajectories } from "./src/skill-proposal.mjs";
import { finalizeShareGlossGeneration } from "./src/share-gloss.mjs";
import { buildAdoptedStyleEvidence, buildKnownIssueFeedbackRequest, presentKnownIssue, selectKnownIssues } from "./src/share-feedback.mjs";

const PUBLIC_ROOT = fileURLToPath(new URL("./public", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const AUTO_QA_EMBEDDING_SEGMENT_LIMIT = 80;
const AUTO_QA_MODEL_ALIGNMENT_SEGMENT_LIMIT = 24;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const TERM_AI_CONCURRENCY = 5;
const TERM_AI_BATCH_SIZE = 24;
const TRANSLATION_PROMPT_VERSION = "kami-translation-v3";
const importProgress = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

/** 本机局域网 IPv4 候选分享地址（同事在同一网络内可访问）。 */
function lanShareUrls(token) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${PORT}/share/${token}`);
    }
  }
  return [...new Set(urls)];
}

/** 把分享记录里的一条反馈组装成跨分享的统一条目。 */
function feedbackEntry(share, feedback) {
  const segment = (share.segments || []).find((item) => item.index === feedback.segmentIndex);
  return {
    id: feedback.id,
    token: share.token,
    filename: share.filename,
    locale: share.locale,
    contentType: share.contentType,
    domain: share.domain,
    segmentIndex: feedback.segmentIndex,
    source: segment?.source || "",
    translation: segment?.translation || "",
    request: feedback.request,
    suggestedTranslation: feedback.suggestedTranslation || "",
    reviewer: feedback.reviewer || "匿名",
    status: feedback.status || "pending",
    createdAt: feedback.createdAt,
    resolvedAt: feedback.resolvedAt || ""
  };
}

/** 单个分享最多生成的语素拆解段数。 */
const SHARE_GLOSS_LIMIT = 30;

/** 创建后台任务记录（术语导入 / Embedding 重建 / 批次导出）。 */
async function createBackgroundTask({ type, title, locale = "", progress = {} }) {
  return saveBackgroundTask({
    type,
    title: String(title || "后台任务").slice(0, 160),
    locale,
    status: "in_progress",
    progress: { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0, ...progress },
    payload: {}
  });
}

/** 更新后台任务进度；任务已被删除时返回 false，执行方据此停止后续工作。 */
async function updateBackgroundTaskProgress(id, update) {
  const task = await getBackgroundTask(id);
  if (!task) return false;
  await saveBackgroundTask({ ...task, ...update });
  return true;
}

/**
 * 后台生成分享的语素拆解：请求返回后异步执行，进度写回分享记录，
 * 服务重启后由启动恢复逻辑续跑未完成的分享。
 */
async function generateShareGlosses(token) {
  const share = await getShare(token);
  if (!share || share.status === "ready" || share.status === "failed") return;
  const targets = (share.segments || [])
    .slice(0, SHARE_GLOSS_LIMIT)
    .map((segment, index) => ({ index, segment }))
    .filter(({ segment }) => !segment.gloss);
  if (!targets.length) {
    await updateShare(token, (item) => finalizeShareGlossGeneration(item, { maxSegments: SHARE_GLOSS_LIMIT }));
    return;
  }
  try {
    await probeModelAvailability({ timeoutMs: 20_000 });
  } catch (error) {
    await updateShare(token, (item) => finalizeShareGlossGeneration(item, { failures: [error], maxSegments: SHARE_GLOSS_LIMIT }));
    return;
  }
  const flush = async (updates) => {
    await updateShare(token, (item) => {
      const nextSegments = item.segments.map((segment) => {
        const gloss = updates.get(segment.index);
        return gloss ? { ...segment, gloss } : segment;
      });
      const limit = Math.min(nextSegments.length, SHARE_GLOSS_LIMIT);
      const glossed = nextSegments.slice(0, limit).filter((segment) => segment.gloss).length;
      return { ...item, segments: nextSegments, glossedSegments: glossed, status: glossed >= limit ? "ready" : "generating" };
    });
  };
  const settled = await runTaskPool(
    targets.map(({ segment }) => ({ translation: segment.translation, locale: share.locale })),
    (target) => glossTranslationWithModel({ translation: target.translation, locale: target.locale }),
    { concurrency: 2 }
  );
  const updates = new Map();
  const failures = [];
  for (let index = 0; index < targets.length; index += 1) {
    const result = settled[index];
    if (result?.status === "fulfilled" && result.value) updates.set(targets[index].segment.index, result.value);
    else failures.push(result?.reason || "模型未返回有效的语素拆解结果");
    if (updates.size >= 5 || index === targets.length - 1) {
      await flush(updates);
      updates.clear();
    }
  }
  const final = await getShare(token);
  if (final) await updateShare(token, (item) => finalizeShareGlossGeneration(item, { failures, maxSegments: SHARE_GLOSS_LIMIT }));
}

/** 后台任务发生存储级/意外错误时也必须离开 generating，避免永久假进度。 */
function startShareGlossGeneration(token, label = "分享拆解生成失败") {
  generateShareGlosses(token).catch(async (error) => {
    console.error(`${label} ${token}:`, error.message);
    try {
      await updateShare(token, (item) => finalizeShareGlossGeneration(item, { failures: [error], maxSegments: SHARE_GLOSS_LIMIT }));
    } catch (updateError) {
      console.error(`分享拆解失败状态写回失败 ${token}:`, updateError.message);
    }
  });
}

function learningScope({ locale, contentType = "general", domain = "general", project = "default" }) {
  return { locale: assertLocale(locale), contentType: String(contentType || "general"), domain: String(domain || "general"), project: String(project || "default") };
}

async function ensureChampionTranslationSkill(scope) {
  const template = createDefaultTranslationSkill({ scope });
  const runtimeDefault = {
    ...scope,
    id: template.id,
    name: template.name,
    description: template.description,
    changeReason: template.changeReason,
    version: template.version,
    status: "champion",
    strategy: template.strategy,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    evidenceIds: [],
    metrics: {}
  };
  try {
    const [champion] = await listTranslationSkills({ ...scope, status: "champion", limit: 1 });
    if (champion) return champion;
    const { id: _runtimeId, ...persistableDefault } = runtimeDefault;
    return await saveTranslationSkill(persistableDefault);
  } catch (error) {
    // Learning storage is observational infrastructure. A temporary Directus
    // failure must never take the production translation path down with it.
    return { ...runtimeDefault, persistenceStatus: "unavailable", persistenceError: error.message };
  }
}

function assertTrajectoryBinding(existing, { locale, source, contentType, domain, project = "default", batchId = "" }) {
  if (!existing) {
    const error = new Error("未找到对应的学习轨迹");
    error.statusCode = 404;
    throw error;
  }
  const sameScope = existing.locale === locale
    && String(existing.contentType || "general") === String(contentType || "general")
    && String(existing.domain || "general") === String(domain || "general")
    && String(existing.project || "default") === String(project || "default");
  const sameSource = String(existing.source || "").trim() === String(source || "").trim();
  const sameBatch = !batchId || !existing.batchId || String(existing.batchId) === String(batchId);
  if (!sameScope || !sameSource || !sameBatch) {
    const error = new Error("学习轨迹与当前原文、语种或业务范围不一致，已拒绝写入");
    error.statusCode = 409;
    throw error;
  }
  return existing;
}

function trajectoryMetricsFromIssues(issues = [], score = null, matches = []) {
  const required = matches.filter((item) => item.mode === "exact" && item.term?.enforcement === "required");
  const missing = new Set(issues.filter((item) => item.type === "required_term").map((item) => item.message));
  return {
    qaScore: Number.isFinite(score) ? score : null,
    hardErrorCount: issues.filter((item) => item.severity === "error").length,
    requiredTermTotal: required.length,
    requiredTermHits: Math.max(0, required.length - missing.size)
  };
}

function trajectoryToEvaluationSample(trajectory, { variant = "champion" } = {}) {
  const metrics = variant === "challenger" ? (trajectory.qaAfter || {}) : (trajectory.qaBefore || trajectory.qaAfter || {});
  const human = trajectory.humanDecision || {};
  const latency = (trajectory.events || []).findLast?.((item) => Number.isFinite(Number(item.latencyMs)))?.latencyMs;
  return {
    caseId: trajectory.id,
    scope: learningScope(trajectory),
    requiredTermHits: Number(metrics.requiredTermHits) || 0,
    requiredTermTotal: Number(metrics.requiredTermTotal) || 0,
    hardErrorCount: Number(metrics.hardErrorCount) || 0,
    qaScore: Number.isFinite(Number(metrics.qaScore)) ? Number(metrics.qaScore) : 0,
    humanEditDistance: Number.isFinite(Number(human.editDistance)) ? Number(human.editDistance) : 0,
    humanAccepted: human.accepted === true || trajectory.status === "completed",
    cost: Number.isFinite(Number(trajectory.costUsd)) ? Number(trajectory.costUsd) : undefined,
    latencyMs: Number(latency || 0)
  };
}

function learningEvaluationUiReport(result) {
  return {
    promotable: result.promotable,
    status: result.status,
    conclusion: result.reportZh,
    gates: result.gates,
    evaluationBasis: "同一人工批准留出集上的 Champion / Challenger 隔离重跑；重跑前剔除与留出原文同源的翻译记忆、QA 案例和风格/画像正反例，防止标准答案泄漏进评测上下文；人工采纳率为相对人工终稿的自动近似指标，不冒充新增人工投票；模型调用成本尚未计量，成本门禁暂不参与（requireCost=false）。",
    metrics: [
      { key: "termAccuracy", label: "强制术语正确率", unit: "%", higherIsBetter: true, champion: result.championMetrics.mandatoryTermAccuracy, candidate: result.challengerMetrics.mandatoryTermAccuracy, delta: result.deltas.mandatoryTermAccuracy },
      { key: "hardErrors", label: "硬错误数", unit: "", higherIsBetter: false, champion: result.championMetrics.hardErrorCount, candidate: result.challengerMetrics.hardErrorCount, delta: result.deltas.hardErrorCount },
      { key: "qaScore", label: "AIQA 平均分", unit: "分", higherIsBetter: true, champion: result.championMetrics.qaScore, candidate: result.challengerMetrics.qaScore, delta: result.deltas.qaScore },
      { key: "editDistance", label: "人工编辑距离", unit: "%", higherIsBetter: false, champion: result.championMetrics.humanEditDistance, candidate: result.challengerMetrics.humanEditDistance, delta: result.deltas.humanEditDistance },
      { key: "acceptanceRate", label: "人工采纳率", unit: "%", higherIsBetter: true, champion: result.championMetrics.humanAcceptanceRate, candidate: result.challengerMetrics.humanAcceptanceRate, delta: result.deltas.humanAcceptanceRate }
    ]
  };
}

function assertCurrentCandidate(candidate, currentChampion, evaluation = null, { requireEvaluation = false } = {}) {
  const state = validateCandidatePromotionState({ candidate, currentChampion, evaluation, requireEvaluation });
  if (!state.valid) {
    const error = new Error(state.reasons.join("；"));
    error.statusCode = 409;
    throw error;
  }
  return state;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求内容超过 15MB 限制");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求 JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

async function classify(body) {
  // 表格自带的"位置/描述"列是比正文更强的用途信号，优先于文本启发式。
  const { descriptor, location } = descriptorFromContext(body.neighborContext);
  const heuristic = classifyContent(body.text, body.hint, { descriptor, location });
  if (!body.useModel || heuristic.source === "manual" || heuristic.confidence >= 0.86) return heuristic;
  try {
    const model = await classifyWithModel(body.text, { descriptor, location });
    if (!Object.hasOwn(CONTENT_TYPES, model.contentType)) throw new Error("模型返回不支持的内容类型");
    return model;
  } catch (error) {
    return { ...heuristic, fallbackReason: error.message };
  }
}

/**
 * 界面上「业务领域」现在可以是 auto，但写入与检索都需要一个具体值：
 * 存下 "auto" 会污染作用域，让这条资产永远匹配不上任何真实领域。
 * 所有入口统一经过这里落到具体领域。
 */
function concreteDomain(value, { text = "", contentType = "general" } = {}) {
  return resolveDomain(text, value, { contentType }).domain;
}


async function runAiQaLoop({ contextPack, initialTranslation, matches, locale, contentType, domain, batchId, providedReferences = null, humanDecisions = [], passScore = 90, maxRevisions = 2 }) {
  const queryEmbedding = await embedSource(contextPack.source);
  const references = providedReferences || rankTranslationMemories(contextPack.source, await getMemories(locale, { contentType, domain, limit: -1 }), { limit: 5, queryEmbedding });
  // 审校环节只能引用人工批准的译例；本系统自己 QA 通过后写回的机器译文另开一档，
  // 否则一次错误会在下一次审校里被当成"已批准"的规范。
  const { approved: approvedReferences, machineDrafts } = splitReferenceAuthority(references);
  const qaCases = contextPack.qaGuidance || [];
  let translation = initialTranslation;
  let hardIssues = runQa({ source: contextPack.source, translation, matches, locale });
  let aiIssues = [];
  let score = calculateQaScore({ hardIssues, aiIssues });
  let initialScore = score;
  let iterations = 0;
  let used = false;
  let fallbackReason = "";
  let termDecisions = [];

  try {
    const potentialIssues = hardIssues.filter((issue) => issue.type === "potential_term");
    if (potentialIssues.length) {
      try {
        const adjudication = await adjudicatePotentialTermsWithModel({ contextPack, translation, issues: potentialIssues });
        translation = adjudication.translation;
        termDecisions = adjudication.decisions;
      } catch {
        translation = await reviseTranslationWithQa({
          contextPack,
          translation,
          issues: potentialIssues.map((issue) => ({
            severity: "major",
            category: "terminology",
            message: `${issue.message}。请结合原文语义判断：若为同一概念则自然采用正式译法；若不是同一概念则保持原译，不得强行替换。`
          })),
          references,
          qaCases
        });
        termDecisions = potentialIssues.map((issue) => ({
          officialSource: issue.sourceTerm,
          matchedSource: issue.matchedSource,
          officialTarget: issue.targetTerm,
          decision: translation.includes(issue.targetTerm) ? "apply" : "not_applicable",
          reason: translation.includes(issue.targetTerm) ? "模型已在完整译文中采用正式术语" : "模型判断当前表达不应强制替换"
        }));
      }
      iterations += 1;
      hardIssues = runQa({ source: contextPack.source, translation, matches, locale });
      const notApplicable = new Set(termDecisions.filter((item) => item.decision === "not_applicable").map((item) => `${item.officialSource}\u0000${item.officialTarget}`));
      hardIssues = hardIssues.filter((issue) => issue.type !== "potential_term" || !notApplicable.has(`${issue.sourceTerm}\u0000${issue.targetTerm}`));
      for (const issue of hardIssues) {
        if (issue.type !== "potential_term") continue;
        const decision = termDecisions.find((item) => item.officialSource === issue.sourceTerm && item.officialTarget === issue.targetTerm);
        if (decision?.decision === "apply") {
          issue.severity = "error";
          issue.message = `术语裁决要求采用正式译法，但修订结果仍未生效：${issue.sourceTerm} → ${issue.targetTerm}`;
        }
      }
    }
    aiIssues = await evaluateTranslationWithModel({ contextPack, translation, references: approvedReferences, machineDrafts, qaCases });
    used = true;
    score = calculateQaScore({ hardIssues, aiIssues });
    initialScore = score;
    while (score < passScore && iterations < maxRevisions) {
      const actionable = [...hardIssues.map((issue) => ({ severity: "critical", category: issue.type, message: issue.message })), ...aiIssues];
      translation = await reviseTranslationWithQa({ contextPack, translation, issues: actionable, references, qaCases });
      iterations += 1;
      hardIssues = runQa({ source: contextPack.source, translation, matches, locale });
      aiIssues = await evaluateTranslationWithModel({ contextPack, translation, references: approvedReferences, machineDrafts, qaCases });
      score = calculateQaScore({ hardIssues, aiIssues });
    }
  } catch (error) {
    fallbackReason = error.message;
  }

  if (!used) score = null;
  const passed = used && score >= passScore && !hardIssues.some((issue) => issue.severity === "error");
  const issues = [...hardIssues, ...presentAiQaIssues(aiIssues)];
  const status = passed ? "passed" : "review";
  const provider = getProviderConfig();
  await saveQaRun({
    locale, contentType, domain, source: contextPack.source, initialTranslation, finalTranslation: translation,
    score, status, iterations, issues, references: [...references, ...qaCases.map((item) => ({ ...item, kind: "qa_case" }))], styleProfileId: contextPack.styleProfile?.id,
    model: provider.model, batchId, fallbackReason, termDecisions, humanDecisions
  });
  const translationChanged = translation !== initialTranslation;
  if (used && (translationChanged || !passed)) {
    await saveQaCase({
      locale, contentType, domain, source: contextPack.source, rejectedTranslation: initialTranslation,
      correctedTranslation: translation, issues, scoreBefore: initialScore, scoreAfter: score,
      status: passed ? "machine_verified" : "review"
    });
  }
  if (passed) {
    await saveMemory(locale, {
      source: contextPack.source, target: translation, domain, contentType,
      styleProfileId: contextPack.styleProfile?.id, qualityStatus: "machine_verified", qaScore: score,
      provenance: iterations ? "aiqa-corrected" : "aiqa-passed", batchId
    });
  }
  return { translation, issues, score, status, iterations, used, fallbackReason, references, qaCases, termDecisions, humanDecisions };
}

function importStatistics(candidates) {
  return {
    candidates: candidates.length,
    ready: candidates.filter((item) => item.decision === "ready").length,
    review: candidates.filter((item) => item.decision === "review").length,
    excluded: candidates.filter((item) => item.decision === "excluded").length,
    existing: candidates.filter((item) => item.existing).length,
    locales: Object.fromEntries(Object.keys(LOCALES).map((locale) => [locale, candidates.filter((item) => item.locale === locale).length]))
  };
}

function reportImportProgress(id, update) {
  if (!id) return;
  const previous = importProgress.get(id) || {};
  importProgress.set(id, { ...previous, ...update, id, updatedAt: new Date().toISOString() });
}

function scheduleImportProgressCleanup(id) {
  if (!id) return;
  const timer = setTimeout(() => importProgress.delete(id), 5 * 60_000);
  timer.unref?.();
}

function validModelDecisionCount(decisions, expected) {
  if (!Array.isArray(decisions)) return 0;
  return new Set(decisions
    .map((item) => Number(item?.index))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < expected)).size;
}

async function reviewCandidateGroup(locale, candidates) {
  let decisions;
  try {
    decisions = await reviewTermCandidatesWithModel(locale, candidates);
  } catch (error) {
    if (candidates.length === 1) {
      return {
        candidates,
        reviewed: 0,
        missing: 1,
        retries: 0,
        failures: [error.message]
      };
    }
    const middle = Math.ceil(candidates.length / 2);
    const left = await reviewCandidateGroup(locale, candidates.slice(0, middle));
    const right = await reviewCandidateGroup(locale, candidates.slice(middle));
    return {
      candidates: [...left.candidates, ...right.candidates],
      reviewed: left.reviewed + right.reviewed,
      missing: left.missing + right.missing,
      retries: left.retries + right.retries + 1,
      failures: [...(left.failures || []), ...(right.failures || [])]
    };
  }
  const applied = validModelDecisionCount(decisions, candidates.length);
  if (applied < candidates.length && candidates.length > 1) {
    const middle = Math.ceil(candidates.length / 2);
    const left = await reviewCandidateGroup(locale, candidates.slice(0, middle));
    const right = await reviewCandidateGroup(locale, candidates.slice(middle));
    return {
      candidates: [...left.candidates, ...right.candidates],
      reviewed: left.reviewed + right.reviewed,
      missing: left.missing + right.missing,
      retries: left.retries + right.retries + 1,
      failures: [...(left.failures || []), ...(right.failures || [])]
    };
  }
  return {
    candidates: applyModelDecisions(candidates, decisions),
    reviewed: applied,
    missing: Math.max(0, candidates.length - applied),
    retries: 0,
    failures: []
  };
}

function markExistingTermCandidates(candidates, assetsByLocale) {
  return candidates.map((candidate) => {
    if (candidate.assetType !== "term") return candidate;
    const sameSource = (assetsByLocale[candidate.locale] || []).filter((term) => term.source.trim().toLocaleLowerCase() === candidate.source.toLocaleLowerCase());
    const exact = sameSource.find((term) => term.target.trim().toLocaleLowerCase() === candidate.target.toLocaleLowerCase());
    if (exact) return { ...candidate, existing: true, existingId: exact.id, decision: "excluded", reasons: [...(candidate.reasons || []), "当前语言库已存在相同对照"] };
    if (sameSource.length) return { ...candidate, conflict: true, existingTarget: sameSource[0].target, decision: "review", score: Math.min(candidate.score, 0.67), reasons: [...(candidate.reasons || []), `当前语言库已有译法：${sameSource[0].target}`] };
    return candidate;
  });
}

async function previewTermImport(body, onProgress = () => {}) {
  onProgress({ phase: "structure", message: "正在解析表格并识别中外文列", percent: 5, completed: 0, total: 1 });
  const useModel = body.useModel !== false;
  const analyzeStructure = useModel ? (snapshot, requestedLocale) => analyzeTermTableStructureWithModel(snapshot, requestedLocale) : undefined;
  const extracted = await extractTermPairs(body, { analyzeStructure });
  onProgress({ phase: "assets", message: "正在读取四个独立术语库", percent: 24, completed: 1, total: 1 });
  let candidates = extracted.candidates.map(classifyImportCandidate);
  const assetsByLocale = {};
  const locales = [...new Set(candidates.map((candidate) => candidate.locale))];
  await Promise.all(locales.map(async (locale) => { assetsByLocale[locale] = (await getAssets(locale)).terms; }));

  const ai = { requested: useModel, used: false, reviewed: 0, total: candidates.length, missing: candidates.length, retries: 0, fallbackReason: "" };
  if (useModel) {
    const groups = locales.flatMap((locale) => {
      const indexes = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidate.locale === locale && !candidate.existing);
      const batches = [];
      for (let offset = 0; offset < indexes.length; offset += TERM_AI_BATCH_SIZE) {
        batches.push({ locale, indexes: indexes.slice(offset, offset + TERM_AI_BATCH_SIZE) });
      }
      return batches;
    });
    let completed = 0;
    onProgress({ phase: "ai-cleaning", message: `AI 五路并发清洗：0 / ${groups.length} 批`, percent: groups.length ? 30 : 86, completed, total: groups.length, concurrency: TERM_AI_CONCURRENCY });
    const results = await runTaskPool(groups, async ({ locale, indexes }) => {
      const result = await reviewCandidateGroup(locale, indexes.map(({ candidate }) => candidate));
      indexes.forEach(({ index }, localIndex) => { candidates[index] = result.candidates[localIndex]; });
      return { reviewed: result.reviewed, missing: result.missing, retries: result.retries, failures: result.failures };
    }, {
      concurrency: TERM_AI_CONCURRENCY,
      onSettled: () => {
        completed += 1;
        const percent = groups.length ? 30 + Math.round((completed / groups.length) * 56) : 86;
        onProgress({ phase: "ai-cleaning", message: `AI 五路并发清洗：${completed} / ${groups.length} 批`, percent, completed, total: groups.length, concurrency: TERM_AI_CONCURRENCY });
      }
    });
    const failures = [
      ...results.filter((result) => result.status === "rejected").map((result) => result.reason?.message || String(result.reason)),
      ...results.filter((result) => result.status === "fulfilled").flatMap((result) => result.value.failures || [])
    ];
    ai.reviewed = results.filter((result) => result.status === "fulfilled").reduce((sum, result) => sum + result.value.reviewed, 0);
    ai.missing = candidates.length - ai.reviewed;
    ai.retries = results.filter((result) => result.status === "fulfilled").reduce((sum, result) => sum + result.value.retries, 0);
    ai.used = ai.reviewed > 0;
    const incomplete = ai.missing ? `模型仅返回 ${ai.reviewed}/${candidates.length} 条有效判断，缺失项保留安全规则并标记未覆盖` : "";
    ai.fallbackReason = [...new Set([...failures, incomplete].filter(Boolean))].join("；");
  }
  const nestedTerms = expandNestedTermCandidates(candidates);
  candidates = markExistingTermCandidates([...candidates, ...nestedTerms], assetsByLocale);
  ai.nestedTerms = nestedTerms.length;
  ai.candidateTotal = candidates.length;
  extracted.candidates = candidates;
  extracted.statistics = { ...extracted.statistics, ...importStatistics(candidates) };
  extracted.ai = ai;
  onProgress({ phase: "saving", message: "正在写入 Directus 审核队列", percent: 92, completed: 0, total: 1 });
  const saved = await saveImportPreview(extracted);
  onProgress({ phase: "completed", message: "识别与清洗完成", percent: 100, completed: 1, total: 1 });
  return { ...extracted, ...saved };
}

async function commitTermImport(body, onProgress = null) {
  if (!body.batchId || !Array.isArray(body.candidates)) {
    const error = new Error("导入批次或候选数据无效");
    error.statusCode = 400;
    throw error;
  }
  const report = (update) => {
    if (typeof onProgress === "function") onProgress(update);
  };
  const total = body.candidates.length;
  let done = 0;
  const imported = [];
  const skipped = [];
  const decisions = [];
  const styleEvidenceByScope = new Map();
  for (const candidate of body.candidates) {
    const decision = { candidateId: candidate.candidateId, status: "rejected", decision: candidate.decision };
    if (!candidate.selected || candidate.existing || candidate.decision === "excluded") {
      skipped.push({ source: candidate.source, locale: candidate.locale, reason: candidate.existing ? "已存在" : "未选择" });
      decisions.push(decision);
      continue;
    }
    try {
      const locale = assertLocale(candidate.locale);
      const source = String(candidate.source || "").trim();
      const target = String(candidate.target || "").trim();
      if (!source || !target) throw new Error("源词或译法为空");
      const fallback = classifyImportCandidate({ ...candidate, source, target });
      const requestedContentType = String(body.contentType || "auto");
      const contentType = requestedContentType !== "auto" && Object.hasOwn(CONTENT_TYPES, requestedContentType)
        ? requestedContentType
        : (Object.hasOwn(CONTENT_TYPES, candidate.contentType) ? candidate.contentType : fallback.contentType);
      const domain = ["game", "marketing", "community", "general"].includes(String(body.domain || ""))
        ? String(body.domain)
        : (["game", "marketing", "community", "general"].includes(candidate.domain) ? candidate.domain : fallback.domain);
      const enforcement = ["required", "preferred"].includes(String(body.enforcement || ""))
        ? String(body.enforcement)
        : (["required", "preferred"].includes(candidate.enforcement) ? candidate.enforcement : fallback.enforcement);
      if (candidate.assetType === "memory") {
        const memory = await saveMemory(locale, {
          source, target, domain, contentType,
          qualityStatus: "human_approved", qaScore: 100, provenance: "table-import", sourceFile: body.filename,
          batchId: body.batchId, sourceRow: candidate.rowNumber
        });
        const evidence = await saveStyleEvidence({
          locale, source, target, contentType, domain,
          batchId: body.batchId, sourceFile: body.filename, sourceRow: candidate.rowNumber, status: "accepted", provenance: "table-import"
        });
        const scopeKey = `${locale}\u0000${contentType}\u0000${domain}`;
        const evidenceGroup = styleEvidenceByScope.get(scopeKey) || [];
        evidenceGroup.push({ ...candidate, evidenceId: evidence.id });
        styleEvidenceByScope.set(scopeKey, evidenceGroup);
        imported.push({ id: memory.id, source, target, locale, assetType: "memory", contentType, domain });
      } else {
        const current = (await getAssets(locale)).terms.filter((term) => term.source.toLocaleLowerCase() === source.toLocaleLowerCase());
        if (current.some((term) => term.target.toLocaleLowerCase() === target.toLocaleLowerCase())) {
          skipped.push({ source, locale, reason: "已存在相同对照" });
          decisions.push(decision);
          continue;
        }
        if (current.length) {
          skipped.push({ source, locale, reason: `库内已有译法：${current[0].target}` });
          decisions.push(decision);
          continue;
        }
        const term = await saveAsset(locale, {
          source, target, aliases: [], forbidden: [], domains: [domain], contentTypes: ["general"],
          enforcement, status: "approved",
          provenance: `table-import:${String(body.filename || "unknown").slice(0, 120)}`,
          note: `批次 ${body.batchId} · 原表第 ${candidate.rowNumber || "?"} 行 · 清洗分 ${candidate.score ?? "-"}`
        });
        imported.push({ id: term.id, source, target, locale, assetType: "term", domain, enforcement });
      }
      decision.status = "accepted";
      decision.decision = "ready";
      decisions.push(decision);
    } catch (error) {
      skipped.push({ source: candidate.source, locale: candidate.locale, reason: error.message });
      decisions.push(decision);
    }
    done += 1;
    if (done % 10 === 0 || done === total) {
      report({ phase: "importing", message: `正在入库：${done} / ${total}`, percent: 10 + Math.round((done / Math.max(total, 1)) * 70), completed: done, total });
    }
  }
  report({ phase: "distilling", message: "风格学习与蒸馏", percent: 88, completed: done, total });
  const styleProfiles = [];
  const batchLearning = [];
  const styleFallbacks = [];
  for (const [scopeKey, currentEvidence] of styleEvidenceByScope.entries()) {
    const [locale, contentType, domain] = scopeKey.split("\u0000");
    let learning = null;
    try {
      learning = await distillBatchStyleLearning({
        batchId: body.batchId,
        filename: body.filename,
        locale,
        contentType,
        domain,
        evidence: currentEvidence
      });
      if (learning) batchLearning.push(learning);
    } catch (error) {
      styleFallbacks.push({ locale, contentType, domain, stage: "batch-learning", reason: `本批风格浓缩失败：${error.message}` });
    }
    try {
      const { distilled, ...pending } = await distillStyleProfileIfReady({
        locale,
        contentType,
        domain,
        sourceBatchId: body.batchId,
        learningRunId: learning?.id || ""
      });
      if (distilled) {
        styleProfiles.push(distilled);
        if (learning?.id) {
          const promoted = await saveStyleLearningRun({ ...learning, id: learning.id, status: "promoted", promotedProfileId: distilled.id });
          const index = batchLearning.findIndex((item) => item.id === learning.id);
          if (index >= 0) batchLearning[index] = promoted;
        }
      }
      else styleFallbacks.push({ locale, contentType, domain, ...pending });
    } catch (error) {
      styleFallbacks.push({ locale, contentType, domain, reason: error.message });
    }
  }
  const summary = {
    imported: imported.length,
    terms: imported.filter((item) => item.assetType === "term").length,
    memories: imported.filter((item) => item.assetType === "memory").length,
    styleLearningRuns: batchLearning.length,
    styleProfiles: styleProfiles.length,
    skipped: skipped.length,
    completedAt: new Date().toISOString()
  };
  await completeImport(body.batchId, decisions, summary);
  return { batchId: body.batchId, imported, skipped, batchLearning, styleProfiles, styleFallbacks, summary };
}

async function apiHandler(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, version: "0.7.0", locales: Object.keys(LOCALES), backend: getStoreMetadata(), storeFallback: getStoreFallbackInfo() });
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const assets = {};
    for (const locale of Object.keys(LOCALES)) {
      const stats = await getAssetStats(locale);
      assets[locale] = { revision: stats.revision, termCount: stats.termCount };
    }
    return json(res, 200, { locales: LOCALES, contentTypes: CONTENT_TYPES, provider: getProviderConfig(), backend: getStoreMetadata(), storeFallback: getStoreFallbackInfo(), assets });
  }
  if (req.method === "GET" && url.pathname === "/api/assets") {
    const locale = assertLocale(url.searchParams.get("locale"));
    return json(res, 200, await getAssets(locale));
  }
  if (req.method === "POST" && url.pathname === "/api/assets") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    return json(res, 201, await saveAsset(locale, body.term || {}));
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/assets/")) {
    const locale = assertLocale(url.searchParams.get("locale"));
    const id = decodeURIComponent(url.pathname.slice("/api/assets/".length));
    const deleted = await deleteAsset(locale, id);
    return json(res, deleted ? 200 : 404, { deleted });
  }
  if (req.method === "POST" && url.pathname === "/api/classify") {
    const body = await readJsonBody(req);
    const classification = await classify(body);
    // 领域与语体一起返回，界面在开始翻译前就能看出「自动识别」会落到哪里。
    return json(res, 200, {
      ...classification,
      domainResolution: resolveDomain(body.text, body.domain, { contentType: classification.contentType })
    });
  }
  if (req.method === "POST" && url.pathname === "/api/match") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const assets = await getAssets(locale);
    return json(res, 200, {
      locale,
      matches: matchTerms(body.text, assets, { contentType: body.contentType, domain: body.domain })
    });
  }
  if (req.method === "POST" && url.pathname === "/api/corpus/refine") {
    const body = await readJsonBody(req);
    const refined = refineCorpus(body.text, body.options);
    return json(res, 200, refined);
  }
  if (req.method === "POST" && url.pathname === "/api/corpus") {
    const body = await readJsonBody(req);
    const refined = refineCorpus(body.text, body.options);
    return json(res, 201, await saveCorpus({ ...body, ...refined }));
  }
  if (req.method === "POST" && url.pathname === "/api/term-import/preview") {
    const body = await readJsonBody(req);
    const progressId = String(body.progressId || "").trim();
    const task = await createBackgroundTask({
      type: "term_import",
      title: String(body.filename || "术语导入表格").slice(0, 120),
      locale: body.locale || ""
    });
    const progress = (update) => {
      reportImportProgress(progressId, { status: "running", ...update });
      updateBackgroundTaskProgress(task.id, { progress: update }).catch(() => {});
    };
    try {
      const result = await previewTermImport(body, progress);
      reportImportProgress(progressId, { status: "completed", phase: "completed", message: "识别与清洗完成", percent: 100 });
      await updateBackgroundTaskProgress(task.id, {
        progress: { phase: "pending-commit", message: "识别完成，等待确认入库", percent: 100, completed: 1, total: 1 }
      });
      return json(res, 200, { ...result, backgroundTaskId: task.id });
    } catch (error) {
      reportImportProgress(progressId, { status: "failed", phase: "failed", message: error.message, error: error.message });
      await updateBackgroundTaskProgress(task.id, {
        status: "failed",
        progress: { phase: "failed", message: error.message, percent: 100, completed: 0, total: 0 },
        payload: { error: error.message }
      });
      throw error;
    } finally {
      scheduleImportProgressCleanup(progressId);
    }
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/term-import/progress/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/term-import/progress/".length));
    const progress = importProgress.get(id);
    return json(res, progress ? 200 : 404, progress || { error: "识别任务尚未开始" });
  }
  if (req.method === "POST" && url.pathname === "/api/term-import/commit") {
    const body = await readJsonBody(req);
    const backgroundTaskId = String(body.backgroundTaskId || "");
    const onProgress = (update) => {
      if (!backgroundTaskId) return;
      updateBackgroundTaskProgress(backgroundTaskId, { progress: update }).catch(() => {});
    };
    const result = await commitTermImport(body, onProgress);
    if (backgroundTaskId) {
      await updateBackgroundTaskProgress(backgroundTaskId, {
        status: "completed",
        progress: { phase: "completed", message: "导入完成", percent: 100, completed: 1, total: 1 },
        payload: { summary: result.summary }
      });
    }
    return json(res, 201, { ...result, backgroundTaskId });
  }
  if (req.method === "GET" && url.pathname === "/api/provider") {
    return json(res, 200, getProviderConfig());
  }
  if (req.method === "POST" && url.pathname === "/api/provider") {
    return json(res, 200, updateProviderConfig(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/embedding/rebuild") {
    const body = await readJsonBody(req);
    const locale = body.locale ? assertLocale(body.locale) : null;
    const locales = locale ? [locale] : Object.keys(LOCALES);
    const task = await createBackgroundTask({
      type: "embedding_rebuild",
      title: `Embedding 重建 · ${locale || "全部语言"}`,
      locale: locale || ""
    });
    (async () => {
      let externalEmbeddingWorking = false;
      try {
        await embed("重建探针");
        externalEmbeddingWorking = true;
      } catch {
        // 外部向量服务不可用：整轮重建使用本地词面向量，避免每条都撞超时
      }
      const results = {};
      let failure = "";
      for (let index = 0; index < locales.length; index += 1) {
        const target = locales[index];
        const alive = await updateBackgroundTaskProgress(task.id, {
          progress: { phase: "rebuilding", message: `正在重建 ${target}（${index + 1} / ${locales.length}）${externalEmbeddingWorking ? "" : "· 本地词面向量"}`, percent: Math.round((index / Math.max(locales.length, 1)) * 90), completed: index, total: locales.length }
        });
        if (!alive) return;
        try {
          results[target] = await rebuildEmbeddings(target, { forceLocal: !externalEmbeddingWorking });
        } catch (error) {
          failure += `${target}: ${error.message}；`;
        }
      }
      await updateBackgroundTaskProgress(task.id, {
        status: failure ? "failed" : "completed",
        progress: { phase: failure ? "failed" : "completed", message: failure ? "部分语言重建失败" : "重建完成", percent: 100, completed: locales.length, total: locales.length },
        payload: { embeddingModel: getProviderConfig().embeddingModel || null, externalEmbeddingWorking, results, error: failure }
      });
    })().catch((error) => console.error("Embedding 重建后台任务失败", error));
    return json(res, 202, { backgroundTaskId: task.id, message: "Embedding 重建已进入任务中心后台执行" });
  }
  if (req.method === "POST" && url.pathname === "/api/feedback/accept") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const source = String(body.source || "").trim();
    const translation = String(body.translation || "").trim();
    if (!source || !translation) {
      const error = new Error("原文与采纳译文不能为空");
      error.statusCode = 400;
      throw error;
    }
    const contentType = body.contentType || "general";
    const domain = concreteDomain(body.domain, { text: source, contentType });
    const project = body.project || "default";
    let linkedTrajectory = null;
    if (body.trajectoryId) {
      linkedTrajectory = assertTrajectoryBinding(
        await getLearningTrajectory(String(body.trajectoryId)),
        { locale, source, contentType, domain, project, batchId: body.batchId || "" }
      );
    }
    const memory = await saveMemory(locale, {
      source, target: translation, domain, contentType,
      qualityStatus: "human_approved", qaScore: 100, provenance: "human-accept",
      styleProfileId: body.styleProfileId || "", batchId: body.batchId || "",
      sourceFile: body.sourceFile || "", sourceRow: body.sourceRow || null
    });
    const demoted = await demoteMemories(locale, source, memory.id);
    // 机器初稿只从轨迹取，不接受客户端提交：与终稿的差异是风格信号本身，
    // 必须来自服务端记录的那一版，否则蒸馏学到的是可以被伪造的"改动"。
    const machineTranslation = linkedTrajectory
      ? String(linkedTrajectory.finalTranslation || linkedTrajectory.initialTranslation || "").trim()
      : "";
    const evidence = await saveStyleEvidence({
      locale, source, target: translation, contentType, domain,
      machineTranslation, polarity: "positive",
      status: "accepted", provenance: "human-accept",
      sourceFile: body.sourceFile || "", sourceRow: body.sourceRow || null
    });
    const qaCaseApproved = body.qaCaseId ? await approveQaCase(String(body.qaCaseId)) : false;
    let trajectory = null;
    if (linkedTrajectory) {
        const humanDecision = {
          accepted: true,
          finalTranslation: translation,
          editDistance: normalizedEditDistance(linkedTrajectory.finalTranslation || linkedTrajectory.initialTranslation || "", translation),
          decidedAt: new Date().toISOString(),
          source: "human-accept"
        };
        trajectory = await updateLearningTrajectory(linkedTrajectory.id, {
          finalTranslation: translation,
          humanDecision,
          status: "completed",
          events: [...(Array.isArray(linkedTrajectory.events) ? linkedTrajectory.events : []), { type: "human_accepted", at: humanDecision.decidedAt, editDistance: humanDecision.editDistance }]
        });
    }
    if (trajectory) triggerAutoProposal({ locale, contentType, domain, project });
    return json(res, 201, { memory, demoted, evidence, qaCaseApproved, trajectory });
  }
  if (req.method === "GET" && url.pathname === "/api/style-profiles") {
    const locale = assertLocale(url.searchParams.get("locale"));
    const status = String(url.searchParams.get("status") || "").trim() || null;
    const [profiles, evidence, qaRuns, learningRuns] = await Promise.all([
      listStyleProfiles(locale, status),
      getStyleEvidence(locale, { limit: 1_000 }),
      getQaRuns(locale, { limit: 500 }),
      getStyleLearningRuns(locale, { limit: 30 })
    ]);
    const pools = new Map();
    const ensurePool = (contentType, domain) => {
      const key = `${contentType || "general"}\u0000${domain || "general"}`;
      if (!pools.has(key)) pools.set(key, {
        contentType: contentType || "general", domain: domain || "general", evidenceCount: 0,
        threshold: DISTILL_THRESHOLD, sources: { tableImport: 0, humanAccept: 0, qaReview: 0, revised: 0, negative: 0, other: 0 }
      });
      return pools.get(key);
    };
    for (const item of evidence) {
      const pool = ensurePool(item.contentType, item.domain);
      pool.evidenceCount += 1;
      if (isNegativeEvidence(item)) pool.sources.negative += 1;
      else if (item.provenance === "table-import" || (!item.provenance && item.sourceFile)) pool.sources.tableImport += 1;
      else if (item.provenance === "human-accept") pool.sources.humanAccept += 1;
      else pool.sources.other += 1;
      // 改写证据带着机器初稿，是信息量最高的一类，单独计数便于判断这个池子够不够"有话可说"。
      if (!isNegativeEvidence(item) && classifyChange(item) === "revised") pool.sources.revised += 1;
    }
    for (const item of qaRuns) ensurePool(item.contentType, item.domain).sources.qaReview += 1;
    return json(res, 200, {
      ...profiles,
      learningRuns,
      evidencePools: [...pools.values()].sort((a, b) => b.evidenceCount - a.evidenceCount)
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/style-profiles/evaluation-jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/style-profiles/evaluation-jobs/".length));
    const job = styleEvaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到该风格评测任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, job);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/evaluate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/evaluate".length));
    const body = await readJsonBody(req);
    const draft = await findStyleProfile(id);
    if (!draft || !draft.contentType) {
      const error = new Error("未找到该风格草稿");
      error.statusCode = 404;
      throw error;
    }
    const scope = learningScope({
      locale: draft.locale,
      contentType: draft.contentType,
      domain: draft.domain || "general",
      project: body.project || "default"
    });
    const activeProfile = await getStyleProfile(scope.locale, scope.contentType, scope.domain);
    const state = validateStylePromotionState({ draft, activeProfile });
    if (!state.valid) {
      const error = new Error(state.reasons.join("；"));
      error.statusCode = 409;
      throw error;
    }
    const running = styleEvaluationJobs.findActiveForChallenger(id);
    if (running) return json(res, 200, running);

    // 草稿是从这些原文蒸馏出来的，留出集必须把它们排除，否则评测的是背诵而不是泛化。
    const evidenceIds = new Set((draft.evidenceIds || []).map(String));
    const distilledFromSources = evidenceIds.size
      ? (await getStyleEvidence(scope.locale, { contentType: scope.contentType, domain: scope.domain, exactScope: true, limit: 1_000 }))
        .filter((item) => evidenceIds.has(String(item.id))).map((item) => item.source)
      : [];
    const holdout = selectStyleHoldout(await listLearningTrajectories({ ...scope, limit: 500 }), { scope, distilledFromSources });
    if (holdout.length < STYLE_MIN_EVALUATION_SAMPLES) {
      const error = new Error(`可用留出终稿 ${holdout.length} 条，未达风格评测所需的 ${STYLE_MIN_EVALUATION_SAMPLES} 条（已排除蒸馏用过的 ${distilledFromSources.length} 条原文）`);
      error.statusCode = 409;
      throw error;
    }
    const provider = getProviderConfig();
    return json(res, 202, await styleEvaluationJobs.create({
      scope,
      champion: { id: activeProfile?.id || NO_STYLE_PROFILE_ID },
      challenger: { id: draft.id },
      trajectories: holdout,
      requireCost: Number.isFinite(provider.inputPricePerMTok) && Number.isFinite(provider.outputPricePerMTok)
    }));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/activate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/activate".length));
    const body = await readJsonBody(req).catch(() => ({}));
    const located = await findStyleProfile(id);
    // 有评测结论且结论反对时必须显式 force，并把这次越过闸门的事实记在规范上。
    if (located?.evaluation && located.evaluation.promotable !== true && body.force !== true) {
      const error = new Error(`评测结论不支持启用：${located.evaluation.conclusion || "未达晋升门槛"}。确认仍要启用请勾选“忽略评测结论”。`);
      error.statusCode = 409;
      throw error;
    }
    const activated = await activateStyleProfile(id);
    if (!activated) {
      const error = new Error("未找到该风格规范");
      error.statusCode = 404;
      throw error;
    }
    if (located) {
      const basis = !located.evaluation ? "unevaluated" : located.evaluation.promotable === true ? "evaluated" : "forced";
      await saveStyleProfileEvaluation(id, { ...(located.evaluation || {}), activationBasis: basis, activatedAt: new Date().toISOString() });
      activated.evaluation = { ...(located.evaluation || {}), activationBasis: basis };
    }
    return json(res, 200, activated);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/style-profiles/") && url.pathname.endsWith("/reject")) {
    const id = decodeURIComponent(url.pathname.slice("/api/style-profiles/".length, -"/reject".length));
    const rejected = await rejectStyleProfile(id);
    if (!rejected) {
      const error = new Error("无法拒绝该风格规范（可能已激活或不存在）");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, rejected);
  }
  if (req.method === "GET" && url.pathname === "/api/qa-cases/pending") {
    const locale = assertLocale(url.searchParams.get("locale"));
    return json(res, 200, await listPendingQaCases(locale));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/qa-cases/") && url.pathname.endsWith("/approve")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-cases/".length, -"/approve".length));
    const approved = await approveQaCase(id);
    if (!approved) {
      const error = new Error("未找到该 QA 案例");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { id, status: "human_approved" });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/qa-cases/") && url.pathname.endsWith("/dispose")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-cases/".length, -"/dispose".length));
    const disposed = await disposeQaCase(id);
    if (!disposed) {
      const error = new Error("未找到该 QA 案例");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { id, disposed });
  }
  if (req.method === "POST" && url.pathname === "/api/evolution/review") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const result = await runEvolutionReview({
      locale,
      contentType: body.contentType || "general",
      domain: body.domain || "general",
      batchId: body.batchId || ""
    });
    return json(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/learning") {
    const locale = assertLocale(url.searchParams.get("locale"));
    const requestedScope = learningScope({
      locale,
      contentType: url.searchParams.get("contentType") || "general",
      domain: url.searchParams.get("domain") || "game",
      project: url.searchParams.get("project") || "default"
    });
    await ensureChampionTranslationSkill(requestedScope);
    const [skills, trajectories, evaluations] = await Promise.all([
      listTranslationSkills({ ...requestedScope, limit: 500 }),
      listLearningTrajectories({ ...requestedScope, limit: 500 }),
      listSkillEvaluations({ ...requestedScope, limit: 500 })
    ]);
    const champion = skills.find((item) => item.status === "champion"
      && item.contentType === requestedScope.contentType
      && item.domain === requestedScope.domain
      && item.project === requestedScope.project) || null;
    const candidates = skills.filter((item) => ["challenger", "draft"].includes(item.status));
    const evidence = trajectories.map((item) => ({
      ...item,
      attribution: (() => {
        try {
          return summarizeTrajectoryAttribution({
            id: item.id,
            scope: learningScope(item),
            initial: item.qaBefore || {},
            final: item.qaAfter || {},
            context: item.contextPack || {},
            revisions: (item.events || []).filter((event) => /revision/u.test(event.type || "")),
            humanFeedback: item.humanDecision || {}
          });
        } catch { return null; }
      })()
    }));
    return json(res, 200, {
      overview: { trajectoryCount: trajectories.length, skillCount: skills.length, pendingCount: candidates.filter((item) => !evaluations.some((evaluation) => evaluation.challengerSkillId === item.id)).length },
      champion,
      skills,
      candidates,
      evaluations: evaluations.map((item) => ({ ...item, result: item.report || {} })),
      evidence,
      trajectories
    });
  }
  if (req.method === "POST" && url.pathname === "/api/learning/skills/generate") {
    const body = await readJsonBody(req);
    const scope = learningScope(body);
    const champion = await ensureChampionTranslationSkill(scope);
    const trajectories = await listLearningTrajectories({ ...scope, limit: 100 });
    // 手动与自动提议共用同一实现，保证轨迹筛选、补丁合并与证据隔离完全一致。
    const skill = await proposeChallengerSkill({ scope, champion, trajectories, promptVersion: TRANSLATION_PROMPT_VERSION });
    return json(res, 201, { skill, candidate: skill });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/evaluate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/evaluate".length));
    const challenger = await getTranslationSkill(id);
    if (!challenger || !["challenger", "draft"].includes(challenger.status)) {
      const error = new Error("未找到可评测的候选技能");
      error.statusCode = 404;
      throw error;
    }
    const scope = learningScope(challenger);
    const champion = await ensureChampionTranslationSkill(scope);
    assertCurrentCandidate(challenger, champion);
    const trajectories = await listLearningTrajectories({ ...scope, limit: 500 });
    const evaluationPool = selectSkillHoldout(trajectories, { scope, trainingEvidenceIds: challenger.evidenceIds || [], limit: 60 });
    if (evaluationPool.length < 20) {
      // 证据不足：不发起任何模型调用，直接生成可审计的 insufficient 结论。
      const championSamples = evaluationPool.map((item) => trajectoryToEvaluationSample(item, { variant: "champion" }));
      const challengerSamples = evaluationPool.map((item) => trajectoryToEvaluationSample(item, { variant: "champion" }));
      const result = evaluateSkillPromotion({
        scope,
        champion: { id: champion.id, scope, samples: championSamples },
        challenger: { id: challenger.id, scope, samples: challengerSamples },
        minSamples: 20,
        minimumCoverage: 0.8,
        guardrails: { requireCost: false }
      });
      const report = learningEvaluationUiReport(result);
      report.conclusion = `证据不足：当前只有 ${evaluationPool.length} 条未参与本候选学习的人工批准终稿，至少需要 20 条才会真正重跑 Champion / Challenger 并开放晋升。`;
      report.benchmark = {
        requestedPairs: evaluationPool.length,
        completedPairs: 0,
        failedPairs: 0,
        failures: [],
        isolation: { excludedMemories: 0, excludedQaCases: 0, excludedStyleExamples: 0, excludedUserProfileExamples: 0, totalExcluded: 0 }
      };
      const evaluation = await saveSkillEvaluation({
        ...scope,
        championSkillId: champion.id,
        challengerSkillId: challenger.id,
        sampleCount: championSamples.length,
        championMetrics: result.championMetrics,
        challengerMetrics: result.challengerMetrics,
        metricDeltas: result.deltas,
        decision: "needs_review",
        report,
        evaluator: "kami-learning-engine-v1"
      });
      return json(res, 200, { evaluation: { ...evaluation, result: report }, result: report });
    }
    // 评测转入后台任务：同一候选已有排队/运行中的任务时直接复用，避免重复烧钱。
    const active = evaluationJobs.findActiveForChallenger(challenger.id);
    if (active) return json(res, 200, { jobId: active.jobId, job: active, alreadyRunning: true });
    const job = await evaluationJobs.create({
      scope,
      champion,
      challenger,
      trajectories: evaluationPool,
      // 定价配置完整时启用真实成本门禁；否则保持跳过，避免空数据锁死晋升。
      requireCost: costPricingConfigured()
    });
    return json(res, 202, { jobId: job.jobId, job });
  }
  if (req.method === "GET" && url.pathname === "/api/learning/evaluation-jobs") {
    const scope = url.searchParams.get("locale")
      ? learningScope({
        locale: url.searchParams.get("locale"),
        contentType: url.searchParams.get("contentType") || "general",
        domain: url.searchParams.get("domain") || "general",
        project: url.searchParams.get("project") || "default"
      })
      : null;
    return json(res, 200, { jobs: evaluationJobs.list(scope) });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/evaluation-jobs/") && url.pathname.endsWith("/resume")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/learning/evaluation-jobs/".length, -("/resume".length)));
    const job = evaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到评测任务");
      error.statusCode = 404;
      throw error;
    }
    const candidate = await getTranslationSkill(job.challengerId);
    const [currentChampion] = await listTranslationSkills({ ...learningScope(job.scope), status: "champion", limit: 1 });
    try {
      assertCurrentCandidate(candidate, currentChampion);
    } catch (error) {
      return json(res, 409, { error: `无法续跑：${error.message}` });
    }
    await evaluationJobs.resume(jobId);
    return json(res, 200, { job: evaluationJobs.get(jobId) });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/learning/evaluation-jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/learning/evaluation-jobs/".length));
    const job = evaluationJobs.get(jobId);
    if (!job) {
      const error = new Error("未找到评测任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { job });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/activate")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/activate".length));
    const skill = await getTranslationSkill(id);
    if (!skill) {
      const error = new Error("未找到候选技能");
      error.statusCode = 404;
      throw error;
    }
    const scope = learningScope(skill);
    const [currentChampion] = await listTranslationSkills({ ...scope, status: "champion", limit: 1 });
    const [latest] = await listSkillEvaluations({ challengerSkillId: id, limit: 1 });
    assertCurrentCandidate(skill, currentChampion, latest, { requireEvaluation: true });
    return json(res, 200, { skill: await activateTranslationSkill(id) });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/reject")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/reject".length));
    const skill = await updateTranslationSkill(id, { status: "rejected" });
    if (!skill) {
      const error = new Error("未找到候选技能");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { skill });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/learning/skills/") && url.pathname.endsWith("/rollback")) {
    const id = decodeURIComponent(url.pathname.slice("/api/learning/skills/".length, -"/rollback".length));
    return json(res, 200, await rollbackTranslationSkill(id));
  }
  if (req.method === "POST" && url.pathname === "/api/batch/prepare") {
    const body = await readJsonBody(req);
    const analyzeSpreadsheet = body.useAiStructure === false ? undefined : (snapshot, ruleAnalysis) => analyzeSpreadsheetStructureWithModel(snapshot, ruleAnalysis, body.locale || "ja-JP");
    const prepared = await prepareBatchDocument(body, { analyzeSpreadsheet });
    const { batchId } = await saveBatchRun({ ...prepared, locale: assertLocale(body.locale || "ja-JP"), contentType: body.contentType || "general", domain: concreteDomain(body.domain, { contentType: body.contentType || "general" }), segments: prepared.segments });
    return json(res, 200, { ...prepared, batchId });
  }
  if (req.method === "POST" && url.pathname === "/api/batch/run") {
    const body = await readJsonBody(req);
    const saved = await saveBatchRun(body);
    return json(res, 200, saved);
  }
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const type = url.searchParams.get("type") || "";
    const locale = url.searchParams.get("locale") || "";
    const status = url.searchParams.get("status") || "";
    const search = url.searchParams.get("search") || "";
    const limit = Number(url.searchParams.get("limit")) || 200;
    const batches = type === "autoqa" || type === "share" || type === "background" ? [] : await listBatchRuns({ locale, status, search, limit });
    const qaTasks = type === "batch" || type === "share" || type === "background" ? [] : await listQaTasks({ locale, status, search, limit });
    const shares = type === "batch" || type === "autoqa" || type === "background" ? [] : (await listShares({})).map((share) => ({
      id: share.token,
      type: "share",
      title: share.filename,
      locale: share.locale,
      contentType: share.contentType || "general",
      domain: share.domain || "general",
      status: share.status === "generating" ? "in_progress" : share.status === "failed" ? "needs_attention" : (share.feedbacks || []).some((feedback) => feedback.status === "pending") ? "review" : "completed",
      overallScore: null,
      totalSegments: Number(share.totalSegments) || share.segments.length,
      completedSegments: Number(share.glossedSegments) || 0,
      failedSegments: share.status === "failed" ? Math.max(0, (Number(share.totalSegments) || share.segments.length) - (Number(share.glossedSegments) || 0)) : 0,
      qaPending: (share.feedbacks || []).filter((feedback) => feedback.status === "pending").length,
      sharePath: `/share/${share.token}`,
      createdAt: share.createdAt,
      updatedAt: share.updatedAt
    })).filter((item) => (!locale || item.locale === locale) && (!status || item.status === status) && (!search || item.title.toLowerCase().includes(String(search).toLowerCase())));
    const backgroundTasks = type === "batch" || type === "autoqa" || type === "share" ? [] : (await listBackgroundTasks({ locale, search, limit })).map((task) => ({
      id: task.id,
      type: "background",
      taskType: task.type,
      title: task.title,
      locale: task.locale || "",
      contentType: "general",
      domain: "general",
      status: task.status === "in_progress" ? "in_progress" : task.status === "failed" ? "needs_attention" : "completed",
      overallScore: null,
      totalSegments: Number(task.progress?.total) || 0,
      completedSegments: Number(task.progress?.completed) || 0,
      failedSegments: 0,
      qaPending: 0,
      progress: task.progress || null,
      payload: task.payload || null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    })).filter((item) => (!status || item.status === status));
    const merged = [...batches.map((item) => ({ ...item, type: "batch" })), ...qaTasks, ...shares, ...backgroundTasks]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, limit);
    return json(res, 200, merged);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/export")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/export".length));
    const run = await getBatchRun(batchId);
    if (!run) {
      const error = new Error("未找到该翻译任务");
      error.statusCode = 404;
      throw error;
    }
    const task = await createBackgroundTask({ type: "batch_export", title: `导出 · ${run.filename}`, locale: run.locale });
    (async () => {
      try {
        await updateBackgroundTaskProgress(task.id, { progress: { phase: "exporting", message: "正在合并导出文件", percent: 40, completed: 0, total: 1 } });
        const exported = await exportBatchDocument({ filename: run.filename, locale: run.locale, format: "task-xlsx", segments: run.segments });
        await updateBackgroundTaskProgress(task.id, { progress: { phase: "saving", message: "正在保存文件", percent: 85, completed: 0, total: 1 } });
        const directory = join(DATA_ROOT, "exports");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${task.id}.xlsx`), Buffer.from(exported.base64, "base64"));
        await updateBackgroundTaskProgress(task.id, {
          status: "completed",
          progress: { phase: "completed", message: "导出完成", percent: 100, completed: 1, total: 1 },
          payload: { filename: exported.filename, mimeType: exported.mimeType, bytes: exported.bytes, downloadUrl: `/api/export-tasks/${task.id}/download` }
        });
      } catch (error) {
        await updateBackgroundTaskProgress(task.id, {
          status: "failed",
          progress: { phase: "failed", message: error.message, percent: 100, completed: 0, total: 1 },
          payload: { error: error.message }
        });
      }
    })().catch((error) => console.error("批次导出后台任务失败", error));
    return json(res, 202, { backgroundTaskId: task.id, message: "导出已进入任务中心后台处理" });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/export-tasks/") && url.pathname.endsWith("/download")) {
    const id = decodeURIComponent(url.pathname.slice("/api/export-tasks/".length, -"/download".length));
    const task = await getBackgroundTask(id);
    if (!task || task.type !== "batch_export" || task.payload?.downloadUrl !== `/api/export-tasks/${id}/download`) {
      const error = new Error("导出任务不存在或尚未完成");
      error.statusCode = 404;
      throw error;
    }
    try {
      const body = await readFile(join(DATA_ROOT, "exports", `${id}.xlsx`));
      res.writeHead(200, {
        "content-type": task.payload.mimeType || "application/octet-stream",
        "content-length": body.length,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(task.payload.filename || `${id}.xlsx`)}`
      });
      res.end(body);
      return true;
    } catch {
      const error = new Error("导出文件已丢失，请重新导出");
      error.statusCode = 404;
      throw error;
    }
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/background-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/background-tasks/".length));
    const deleted = await deleteBackgroundTask(id);
    if (!deleted) {
      const error = new Error("后台任务不存在");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/batch/run/")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/batch/run/".length));
    const run = await getBatchRun(batchId);
    if (!run) {
      const error = new Error("未找到该批次的保存进度");
      error.statusCode = 404;
      throw error;
    }
    const [assets, qaRuns] = await Promise.all([
      getAssets(run.locale),
      getQaRuns(run.locale, { contentType: run.contentType, domain: run.domain, batchId: run.batchId, limit: 500 })
    ]);
    const latestRunBySource = new Map();
    for (const qaRun of qaRuns) if (!latestRunBySource.has(qaRun.source)) latestRunBySource.set(qaRun.source, qaRun);
    const segments = run.segments.map((segment) => {
      const qaRun = latestRunBySource.get(segment.source);
      if (!qaRun) return segment;
      const references = (qaRun.references || []).filter((item) => item.kind !== "qa_case");
      const qaCases = (qaRun.references || []).filter((item) => item.kind === "qa_case");
      const matches = matchTerms(segment.source, assets, { contentType: run.contentType, domain: run.domain });
      return {
        ...segment,
        translation: segment.translation || qaRun.finalTranslation,
        status: segment.status === "pending" ? "done" : segment.status,
        result: {
          ...(segment.result || {}),
          translation: segment.translation || qaRun.finalTranslation,
          matches,
          issues: qaRun.issues || [],
          qaScore: qaRun.score,
          aiQa: { ...(segment.result?.aiQa || {}), score: qaRun.score, status: qaRun.status, iterations: qaRun.iterations, used: qaRun.score != null, fallbackReason: qaRun.fallbackReason, references, qaCases, termDecisions: qaRun.termDecisions || [], humanDecisions: qaRun.humanDecisions || [] }
        }
      };
    });
    return json(res, 200, { ...run, segments });
  }
  if (req.method === "POST" && url.pathname === "/api/batch/export") {
    return json(res, 200, await exportBatchDocument(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/qa/resolve") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const source = String(body.source || "").trim();
    const translation = String(body.translation || "").trim();
    const action = String(body.action || "");
    const issueIndex = Number(body.issueIndex);
    const currentIssues = Array.isArray(body.issues) ? body.issues.slice(0, 30) : [];
    const issue = Number.isInteger(issueIndex) ? currentIssues[issueIndex] : null;
    if (!source || !translation || !issue || !["approve", "revise"].includes(action)) {
      const error = new Error("QA 决定缺少原文、译文、问题或有效操作");
      error.statusCode = 400;
      throw error;
    }
    if (action === "approve" && issue.severity === "error" && issue.mqmSeverity !== "minor") {
      const error = new Error("阻断级 QA 问题不能直接批准，请先让 AI 修订或人工编辑译文");
      error.statusCode = 409;
      throw error;
    }

    const contentType = body.contentType || "general";
    const domain = concreteDomain(body.domain, { text: source, contentType });
    const project = body.project || "default";
    const batchId = body.batchId || "manual-review";
    let linkedTrajectory = null;
    if (body.trajectoryId) {
      linkedTrajectory = assertTrajectoryBinding(
        await getLearningTrajectory(String(body.trajectoryId)),
        { locale, source, contentType, domain, project, batchId: body.batchId || "" }
      );
    }
    const assets = await getAssets(locale);
    const matches = matchTerms(source, assets, { contentType, domain });
    const classification = await classify({ text: source, hint: contentType, useModel: false });
    const styleProfile = await getStyleProfile(locale, contentType, domain);
    const translationSkill = await ensureChampionTranslationSkill(learningScope({ locale, contentType, domain, project }));
    const qaGuidance = rankQaCases(source, await getQaCases(locale, { contentType, domain, limit: -1 }), { limit: 3, queryEmbedding: await embedSource(source) });
    const contextPack = buildContextPack({ source, locale, classification, matches, domain, styleProfile, translationSkill, qaGuidance });
    const priorDecisions = Array.isArray(body.humanDecisions) ? body.humanDecisions.slice(0, 30) : [];
    const decision = {
      decision: action === "approve" ? "approved_as_is" : "revision_requested",
      issue: {
        type: issue.type || "qa",
        category: issue.category || "other",
        severity: issue.mqmSeverity || issue.severity || "warning",
        message: issue.message || "",
        suggestion: issue.suggestion || ""
      },
      reason: action === "approve" ? "人工确认当前译文可接受" : "人工要求翻译模型按该建议修订",
      decidedAt: new Date().toISOString()
    };
    const humanDecisions = [...priorDecisions, decision];

    if (action === "revise") {
      const revisedTranslation = await reviseTranslationWithQa({
        contextPack, translation, issues: [issue],
        references: Array.isArray(body.references) ? body.references : [], qaCases: qaGuidance
      });
      decision.beforeTranslation = translation;
      decision.afterTranslation = revisedTranslation;
      const aiQa = await runAiQaLoop({
        contextPack, initialTranslation: revisedTranslation, matches, locale, contentType, domain, batchId, humanDecisions
      });
      if (linkedTrajectory) {
        await updateLearningTrajectory(linkedTrajectory.id, {
          finalTranslation: aiQa.translation,
          qaAfter: { ...trajectoryMetricsFromIssues(aiQa.issues, aiQa.score, matches), issues: aiQa.issues, iterations: aiQa.iterations },
          humanDecision: { accepted: false, action: "revision_requested", decisions: humanDecisions, decidedAt: decision.decidedAt },
          status: aiQa.status === "passed" ? "completed" : "review",
          events: [...(Array.isArray(linkedTrajectory.events) ? linkedTrajectory.events : []), { type: "human_revision_requested", at: decision.decidedAt }]
        });
      }
      return json(res, 200, { matches, translation: aiQa.translation, issues: aiQa.issues, qaScore: aiQa.score, aiQa, styleProfile: contextPack.styleProfile, trajectoryId: body.trajectoryId || "" });
    }

    const remainingIssues = currentIssues.filter((_, index) => index !== issueIndex);
    const score = remainingIssues.length ? (Number.isFinite(Number(body.qaScore)) ? Number(body.qaScore) : 90) : 100;
    const status = remainingIssues.some((item) => item.severity === "error") || score < 90 ? "review" : "passed";
    const provider = getProviderConfig();
    const references = Array.isArray(body.references) ? body.references.slice(0, 12) : [];
    const termDecisions = Array.isArray(body.termDecisions) ? body.termDecisions.slice(0, 20) : [];
    await saveQaRun({
      locale, contentType, domain, source, initialTranslation: translation, finalTranslation: translation,
      score, status, iterations: Number(body.iterations) || 0, issues: remainingIssues, references,
      styleProfileId: contextPack.styleProfile?.id || "", model: provider.model, batchId,
      fallbackReason: "", termDecisions, humanDecisions
    });
    if (linkedTrajectory) {
      await updateLearningTrajectory(linkedTrajectory.id, {
        finalTranslation: translation,
        qaAfter: { ...trajectoryMetricsFromIssues(remainingIssues, score, matches), issues: remainingIssues, iterations: Number(body.iterations) || 0 },
        humanDecision: { accepted: true, action: "qa_issue_approved", decisions: humanDecisions, decidedAt: decision.decidedAt },
        status: status === "passed" ? "completed" : "review",
        events: [...(Array.isArray(linkedTrajectory.events) ? linkedTrajectory.events : []), { type: "qa_issue_approved", at: decision.decidedAt }]
      });
      triggerAutoProposal({ locale, contentType, domain, project });
    }
    return json(res, 200, {
      matches, translation, issues: remainingIssues, qaScore: score,
      aiQa: {
        score, status, iterations: Number(body.iterations) || 0, used: true, fallbackReason: "",
        references: references.filter((item) => item.kind !== "qa_case"),
        qaCases: references.filter((item) => item.kind === "qa_case"), termDecisions, humanDecisions
      },
      styleProfile: contextPack.styleProfile,
      trajectoryId: body.trajectoryId || ""
    });
  }
  if (req.method === "POST" && url.pathname === "/api/qa") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const assets = await getAssets(locale);
    const contentType = body.contentType || "general";
    const domain = concreteDomain(body.domain, { text: body.source || "", contentType });
    const matches = matchTerms(body.source || "", assets, { contentType, domain });
    if (body.aiQa !== true) return json(res, 200, { matches, issues: runQa({ source: body.source || "", translation: body.translation || "", matches, locale }) });
    const classification = await classify({ text: body.source || "", hint: contentType, useModel: false });
    const styleProfile = await getStyleProfile(locale, contentType, domain);
    const translationSkill = await ensureChampionTranslationSkill(learningScope({ locale, contentType, domain, project: body.project || "default" }));
    const qaGuidance = rankQaCases(body.source || "", await getQaCases(locale, { contentType, domain, limit: -1 }), { limit: 3, queryEmbedding: await embedSource(body.source || "") });
    const contextPack = buildContextPack({ source: body.source || "", locale, classification, matches, domain, styleProfile, translationSkill, qaGuidance });
    const aiQa = await runAiQaLoop({ contextPack, initialTranslation: body.translation || "", matches, locale, contentType, domain, batchId: body.batchId || "manual-recheck" });
    return json(res, 200, { matches, translation: aiQa.translation, issues: aiQa.issues, qaScore: aiQa.score, aiQa, styleProfile: contextPack.styleProfile });
  }
  if (req.method === "POST" && url.pathname === "/api/auto-qa") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const source = String(body.source || "").trim();
    const translation = String(body.translation || "").trim();
    if (!source || !translation) {
      const error = new Error("请同时提供中文原文与译文");
      error.statusCode = 400;
      throw error;
    }
    const contentType = body.contentType || "general";
    // 网页粘贴常带 HTML 标签：剥离后参与分析，但必须保留换行作为多语言段落边界。
    const stripTags = normalizeQaInputText;
    const tagsStripped = /<[^>]*>/u.test(source) || /<[^>]*>/u.test(translation);
    const cleanSource = stripTags(source);
    const cleanTranslation = stripTags(translation);
    if (!cleanSource || !cleanTranslation) {
      const error = new Error("剥离 HTML 标签后没有可用文本");
      error.statusCode = 400;
      throw error;
    }
    const assets = await getAssets(locale);
    const classification = await classify({ text: cleanSource, hint: contentType, useModel: false });
    const scopeContentType = classification.contentType || "general";
    const domainResolution = resolveDomain(cleanSource, body.domain, { contentType: scopeContentType });
    const domain = domainResolution.domain;
    // 术语匹配放在识别之后，用真正生效的语体与领域加权，而不是界面提交的原始值。
    const matches = matchTerms(cleanSource, assets, { contentType: scopeContentType, domain });
    const styleProfile = await getStyleProfile(locale, scopeContentType, domain);
    const queryEmbedding = await embedSource(cleanSource);
    const narrowedMemories = narrowByDomain(await getMemories(locale, { contentType: scopeContentType, domain: "general", limit: -1 }), domain);
    const narrowedQaCases = narrowByDomain(await getQaCases(locale, { contentType: scopeContentType, domain: "general", limit: -1 }), domain);
    domainResolution.relaxedRetrieval = narrowedMemories.relaxed || narrowedQaCases.relaxed;
    const references = rankTranslationMemories(cleanSource, narrowedMemories.items, { limit: 5, queryEmbedding });
    const qaCases = rankQaCases(cleanSource, narrowedQaCases.items, { limit: 3, queryEmbedding });
    const evidence = positiveEvidenceOnly(await getStyleEvidence(locale, { contentType: scopeContentType, domain, limit: 12 })).slice(0, 6);
    // 只有人工批准的译例能充当"标准"；机器译文另开一档，仅供一致性参考。
    const { approved: approvedReferences, machineDrafts } = splitReferenceAuthority(references);
    const sourceSegments = splitQaSegments(cleanSource);
    const translationSegments = splitQaSegments(cleanTranslation);

    // 逐句对齐三级降级：语义向量 DP 对齐（支持 1:N / N:1 合并）→ 模型逐句对齐 → 按位置近似配对。
    // 本地词面向量跨语言无意义，绝不能拿来做中↔外对齐。
    let alignmentNote = "";
    let pairPlan = null;
    let alignmentMethod = "position";
    if (isEmbeddingConfigured() && (sourceSegments.length + translationSegments.length) <= AUTO_QA_EMBEDDING_SEGMENT_LIMIT) {
      try {
        await embed("对齐探针");
        const embedSegments = async (segments) => {
          const settledEmbeddings = await runTaskPool(segments, (segment) => embedSource(segment), { concurrency: 6 });
          return settledEmbeddings.map((result) => result.status === "fulfilled" ? result.value : null);
        };
        const [sourceEmbeddings, translationEmbeddings] = await Promise.all([
          embedSegments(sourceSegments),
          embedSegments(translationSegments)
        ]);
        if ([...sourceEmbeddings, ...translationEmbeddings].every((embedding) => embedding && !embedding.local)) {
          const scoreMatrix = sourceEmbeddings.map((sourceEmbedding) =>
            translationEmbeddings.map((translationEmbedding) => cosineSimilarity(sourceEmbedding?.vector, translationEmbedding?.vector)));
          const maxScore = Math.max(0, ...scoreMatrix.flat());
          if (maxScore >= 0.1) {
            pairPlan = alignSegmentPairs(sourceSegments.length, translationSegments.length, (i, j) => scoreMatrix[i][j]);
            alignmentMethod = "embedding";
          }
        }
      } catch {
        // Embedding 服务异常，继续降级
      }
    }
    if (!pairPlan && sourceSegments.length !== translationSegments.length && (sourceSegments.length + translationSegments.length) <= AUTO_QA_MODEL_ALIGNMENT_SEGMENT_LIMIT) {
      try {
        const plan = await alignSegmentsWithModel({ sourceSegments, translationSegments, locale });
        if (plan) {
          pairPlan = plan;
          alignmentMethod = "model";
        }
      } catch {
        // 模型对齐失败，按位置配对
      }
    }
    if (!pairPlan) {
      pairPlan = alignSegmentPairs(
        sourceSegments.length,
        translationSegments.length,
        createStructuralAlignmentScorer(sourceSegments, translationSegments)
      );
      alignmentMethod = "structural";
    }
    // 句数相同也可能存在漏句/错位（译文把后面的句子提前、或整句删掉）：非一一对应即给出对齐说明
    const identityAlignment = pairPlan.pairs.length === sourceSegments.length
      && pairPlan.unmatchedSource.length === 0
      && pairPlan.unmatchedTranslation.length === 0
      && pairPlan.pairs.every((pair, index) => pair.sourceIndices.length === 1 && pair.translationIndices.length === 1 && pair.sourceIndices[0] === index && pair.translationIndices[0] === index);
    if (!identityAlignment) {
      const counts = `原文 ${sourceSegments.length} 句 / 译文 ${translationSegments.length} 句`;
      alignmentNote = alignmentMethod === "embedding"
        ? `${counts}，已按语义向量自动对齐（可合并相邻句、标出漏译/增译）。`
        : alignmentMethod === "model"
          ? `${counts}，已由模型逐句对齐（可合并相邻句、标出漏译/增译）。`
          : `${counts}，语义对齐不可用，已按数字、专名与位置锚点近似对齐，请人工核对。`;
    }

    // 每个对齐组独立执行：语言正确性专项（拼写/语法）+ 三层检查，两路并行（并发 2 组）
    const pairTasks = pairPlan.pairs.map((pair) => async () => {
      const pairSource = pair.sourceIndices.map((index) => sourceSegments[index]).join("\n");
      const pairTranslation = pair.translationIndices.map((index) => translationSegments[index]).join("\n");
      const segmentMatches = matchTerms(pairSource, assets, { contentType: scopeContentType, domain });
      const basicIssues = runBasicQa({ source: pairSource, translation: pairTranslation, matches: segmentMatches, locale });
      const [grammarResult, aiResult] = await Promise.allSettled([
        evaluateGrammarWithModel({ translation: pairTranslation, locale, contentType: scopeContentType }),
        evaluateAutoQaWithModel({
          source: pairSource, translation: pairTranslation, locale, contentType: scopeContentType, domain,
          styleProfile, references: approvedReferences, machineDrafts, qaCases, evidence
        })
      ]);
      const failures = [];
      let grammarIssues = [];
      if (grammarResult.status === "fulfilled") grammarIssues = grammarResult.value;
      else failures.push(`语法专项失败：${String(grammarResult.reason?.message || grammarResult.reason)}`);
      let aiIssues = [];
      if (aiResult.status === "fulfilled") aiIssues = aiResult.value;
      else failures.push(`三层检查失败：${String(aiResult.reason?.message || aiResult.reason)}`);
      const issues = dedupeIssues([...grammarIssues, ...basicIssues, ...aiIssues]);
      return {
        index: 0,
        sourceIndices: pair.sourceIndices,
        translationIndices: pair.translationIndices,
        source: pairSource,
        translation: pairTranslation,
        issues,
        scores: calculateAutoQaScores(issues),
        summary: summarizeIssues(issues),
        // 每段的扣分只能记在自己头上，文档级打分才能按段封顶后再平均。
        fallbackReason: failures.join("；")
      };
    });
    const settled = await runTaskPool(pairTasks, (task) => task(), { concurrency: 2 });
    const segments = settled
      .filter((result) => result.status === "fulfilled")
      .map((result, index) => ({ ...result.value, index: index + 1 }));
    const alignmentIssues = buildAlignmentIssues({
      sourceSegments, translationSegments,
      unmatchedSource: pairPlan.unmatchedSource,
      unmatchedTranslation: pairPlan.unmatchedTranslation
    });
    const allIssues = [
      ...segments.flatMap((segment) => segment.issues.map((issue) => ({ ...issue, segmentIndex: segment.index }))),
      ...alignmentIssues.map((issue, index) => ({ ...issue, segmentIndex: `alignment-${index}` }))
    ];
    const scores = calculateAutoQaScores(allIssues, { segmentCount: Math.max(1, segments.length) });
    const summary = summarizeIssues(allIssues);
    const fallbackReason = segments
      .filter((segment) => segment.fallbackReason)
      .map((segment) => `第 ${segment.index} 组模型检查失败：${segment.fallbackReason}`)
      .join("；");
    const report = {
      locale, matches, tagsStripped, alignmentNote,
      segmentCounts: { source: sourceSegments.length, translation: translationSegments.length },
      segments, alignmentIssues,
      scores, summary,
      classification, domainResolution, styleProfile,
      references: references.filter((item) => item.kind !== "qa_case"),
      qaCases,
      fallbackReason
    };
    const task = await saveQaTask({
      locale,
      contentType: scopeContentType,
      domain,
      sourceText: cleanSource,
      translationText: cleanTranslation,
      title: cleanSource.slice(0, 40),
      segmentCounts: report.segmentCounts,
      overallScore: scores.overall,
      dimensionScores: scores.dimensions,
      summary,
      alignmentNote,
      model: getProviderConfig().model,
      report
    });
    return json(res, 200, { ...report, taskId: task.id });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/qa-tasks/") && url.pathname.endsWith("/share")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-tasks/".length, -"/share".length));
    const task = await getQaTask(id);
    if (!task) {
      const error = new Error("未找到该质检任务");
      error.statusCode = 404;
      throw error;
    }
    const report = task.report || {};
    const reportSegments = Array.isArray(report.segments) ? report.segments : [];
    if (!reportSegments.length) {
      const error = new Error("该质检报告没有可分享的句子");
      error.statusCode = 400;
      throw error;
    }
    // 链接立即可用：语素拆解由后台任务异步生成（任务中心可见进度，服务重启后续跑）
    const segments = reportSegments.map((segment, index) => ({
      index: index + 1,
      source: segment.source,
      translation: segment.translation,
      sourceIndices: segment.sourceIndices || [],
      translationIndices: segment.translationIndices || [],
      qaScore: Number.isFinite(segment.scores?.overall) ? segment.scores.overall : null,
      dimensionScores: segment.scores?.dimensions || null,
      issues: (segment.issues || []).slice(0, 30).map((issue) => ({
        severity: issue.severity || "warning",
        type: issue.type || "qa",
        category: issue.category || "other",
        dimension: issue.dimension || "basic",
        message: String(issue.message || ""),
        suggestion: String(issue.suggestion || ""),
        sourceSpan: String(issue.sourceSpan || ""),
        targetSpan: String(issue.targetSpan || "")
      })),
      gloss: null
    }));
    const meta = {
      source: "autoqa",
      overallScore: Number.isFinite(report.scores?.overall) ? report.scores.overall : null,
      dimensionScores: report.scores?.dimensions || null,
      summary: report.summary || null,
      alignmentNote: String(report.alignmentNote || ""),
      alignmentIssues: Array.isArray(report.alignmentIssues) ? report.alignmentIssues : [],
      segmentCounts: report.segmentCounts || {},
      tagsStripped: Boolean(report.tagsStripped),
      fallbackReason: String(report.fallbackReason || "")
    };
    const share = await saveShare({
      qaTaskId: id,
      filename: `Auto QA · ${task.title || "未命名质检"}`,
      locale: task.locale,
      contentType: task.contentType || "general",
      domain: task.domain || "general",
      meta,
      segments,
      status: "generating",
      glossedSegments: 0,
      totalSegments: segments.length
    });
    startShareGlossGeneration(share.token);
    return json(res, 200, {
      token: share.token,
      sharePath: `/share/${share.token}`,
      shareUrls: lanShareUrls(share.token),
      status: "generating",
      glossedSegments: 0,
      totalSegments: segments.length
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/qa-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-tasks/".length));
    const task = await getQaTask(id);
    if (!task) {
      const error = new Error("未找到该质检任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, {
      task: {
        id: task.id, title: task.title, locale: task.locale, contentType: task.contentType, domain: task.domain,
        sourceText: task.sourceText, translationText: task.translationText, segmentCounts: task.segmentCounts,
        overallScore: task.overallScore, dimensionScores: task.dimensionScores, summary: task.summary,
        alignmentNote: task.alignmentNote, model: task.model, createdAt: task.createdAt, updatedAt: task.updatedAt
      },
      report: task.report
    });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/qa-tasks/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/qa-tasks/".length));
    const deleted = await deleteQaTask(id);
    if (!deleted) {
      const error = new Error("未找到该质检任务");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/share")) {
    const batchId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/share".length));
    const run = await getBatchRun(batchId);
    if (!run) {
      const error = new Error("未找到该翻译任务");
      error.statusCode = 404;
      throw error;
    }
    const doneSegments = (run.segments || []).filter((segment) => segment.selected !== false && segment.status === "done" && segment.translation);
    if (!doneSegments.length) {
      const error = new Error("该任务还没有已完成的译文段落，无法分享");
      error.statusCode = 400;
      throw error;
    }
    // 链接立即可用：语素拆解由后台任务异步生成（任务中心可见进度，服务重启后续跑）
    const segments = doneSegments.map((segment, index) => ({
      index: index + 1,
      source: segment.source,
      translation: segment.translation,
      locator: segment.locator || "",
      context: segment.context || "",
      qaScore: Number.isFinite(segment.result?.qaScore) ? segment.result.qaScore : null,
      issues: (segment.result?.issues || []).slice(0, 30).map((issue) => ({
        severity: issue.severity || "warning",
        type: issue.type || "qa",
        category: issue.category || "other",
        message: String(issue.message || ""),
        suggestion: String(issue.suggestion || "")
      })),
      gloss: null
    }));
    const share = await saveShare({
      batchId, filename: run.filename, locale: run.locale, contentType: run.contentType || "general", domain: run.domain || "general",
      segments, status: "generating", glossedSegments: 0, totalSegments: segments.length
    });
    startShareGlossGeneration(share.token);
    return json(res, 200, {
      token: share.token,
      sharePath: `/share/${share.token}`,
      shareUrls: lanShareUrls(share.token),
      status: "generating",
      glossedSegments: 0,
      totalSegments: segments.length
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/share/")) {
    const token = decodeURIComponent(url.pathname.slice("/api/share/".length));
    const share = await getShare(token);
    if (!share) {
      const error = new Error("分享链接无效或已删除");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, {
      token: share.token,
      filename: share.filename,
      locale: share.locale,
      contentType: share.contentType,
      domain: share.domain,
      qaTaskId: share.qaTaskId || "",
      meta: share.meta ? {
        ...share.meta,
        alignmentIssues: Array.isArray(share.meta.alignmentIssues)
          ? share.meta.alignmentIssues.map((issue) => presentKnownIssue(issue))
          : []
      } : null,
      segments: (share.segments || []).map((segment) => ({
        ...segment,
        issues: (segment.issues || []).map((issue) => presentKnownIssue(issue))
      })),
      feedbackCount: share.feedbacks.length,
      status: share.status || "ready",
      glossedSegments: Number(share.glossedSegments) || 0,
      totalSegments: Number(share.totalSegments) || share.segments.length,
      generationError: String(share.meta?.generationError || ""),
      createdAt: share.createdAt
    });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/share/")) {
    const token = decodeURIComponent(url.pathname.slice("/api/share/".length));
    const deleted = await deleteShare(token);
    if (!deleted) {
      const error = new Error("分享不存在或已删除");
      error.statusCode = 404;
      throw error;
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/share/") && url.pathname.endsWith("/feedback")) {
    const token = decodeURIComponent(url.pathname.slice("/api/share/".length, -"/feedback".length));
    const share = await getShare(token);
    if (!share) {
      const error = new Error("分享链接无效或已删除");
      error.statusCode = 404;
      throw error;
    }
    const body = await readJsonBody(req);
    const segmentIndex = Number(body.segmentIndex);
    const segment = (share.segments || []).find((item) => item.index === segmentIndex);
    if (!segment) {
      const error = new Error("段落不存在");
      error.statusCode = 400;
      throw error;
    }
    const knownIssues = selectKnownIssues(segment.issues, body.knownIssueIndexes);
    const request = buildKnownIssueFeedbackRequest(knownIssues, body.request);
    if (!request) {
      const error = new Error("请勾选仍需上报的已知问题，或填写新的具体要求");
      error.statusCode = 400;
      throw error;
    }
    const feedback = {
      id: randomUUID(),
      segmentIndex,
      request,
      knownIssueIndexes: knownIssues.map((issue) => issue.issueIndex),
      knownIssues,
      suggestedTranslation: String(body.suggestedTranslation || "").trim().slice(0, 2_000),
      reviewer: String(body.reviewer || "匿名").trim().slice(0, 80),
      status: "pending",
      createdAt: new Date().toISOString()
    };
    await updateShare(token, (item) => ({ ...item, feedbacks: [...(item.feedbacks || []), feedback] }));
    return json(res, 200, { ok: true, message: "已提交，感谢反馈！" });
  }
  if (req.method === "GET" && url.pathname === "/api/feedback/pending") {
    const shares = await listShares({});
    const pending = [];
    for (const share of shares) {
      for (const feedback of share.feedbacks || []) {
        if (feedback.status !== "pending") continue;
        pending.push(feedbackEntry(share, feedback));
      }
    }
    pending.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return json(res, 200, pending);
  }
  if (req.method === "GET" && url.pathname === "/api/feedback") {
    const status = url.searchParams.get("status") || "";
    const shares = await listShares({});
    const entries = [];
    for (const share of shares) {
      for (const feedback of share.feedbacks || []) {
        if (status && feedback.status !== status) continue;
        entries.push(feedbackEntry(share, feedback));
      }
    }
    entries.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return json(res, 200, entries.slice(0, Number(url.searchParams.get("limit")) || 500));
  }
  if (req.method === "GET" && url.pathname === "/api/shares") {
    const batchId = url.searchParams.get("batchId") || "";
    const qaTaskId = url.searchParams.get("qaTaskId") || "";
    const shares = await listShares({ batchId, qaTaskId });
    return json(res, 200, shares.map((share) => ({
      token: share.token,
      batchId: share.batchId,
      qaTaskId: share.qaTaskId || "",
      filename: share.filename,
      locale: share.locale,
      contentType: share.contentType,
      domain: share.domain,
      meta: share.meta || null,
      segmentCount: share.segments.length,
      feedbacks: share.feedbacks || [],
      createdAt: share.createdAt,
      updatedAt: share.updatedAt
    })));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/share/") && url.pathname.endsWith("/resolve")) {
    const token = decodeURIComponent(url.pathname.slice("/api/share/".length, -"/resolve".length));
    const share = await getShare(token);
    if (!share) {
      const error = new Error("分享链接无效或已删除");
      error.statusCode = 404;
      throw error;
    }
    const body = await readJsonBody(req);
    const feedbackId = String(body.feedbackId || "");
    const action = body.action === "adopt" ? "adopt" : body.action === "ignore" ? "ignore" : "";
    if (!feedbackId || !action) {
      const error = new Error("缺少意见 ID 或有效操作");
      error.statusCode = 400;
      throw error;
    }
    const index = (share.feedbacks || []).findIndex((item) => item.id === feedbackId);
    if (index < 0) {
      const error = new Error("该意见不存在");
      error.statusCode = 404;
      throw error;
    }
    const feedback = share.feedbacks[index];
    if (feedback.status !== "pending") {
      const error = new Error("该意见已处理过");
      error.statusCode = 409;
      throw error;
    }
    if (action === "adopt") {
      const segment = (share.segments || []).find((item) => item.index === feedback.segmentIndex);
      await saveStyleEvidence(buildAdoptedStyleEvidence({ share, feedback, segment }));
      try {
        // distillStyleProfileIfReady 内部已经落盘草稿；saveStyleProfile 不是 upsert，
        // 再存一次会生成第二个内容相同、版本号 +1 的草稿。
        await distillStyleProfileIfReady({
          locale: share.locale,
          contentType: share.contentType,
          domain: share.domain,
          sourceBatchId: share.batchId
        });
      } catch {
        // 未达阈值或蒸馏失败不阻断采纳
      }
    }
    const resolvedAt = new Date().toISOString();
    await updateShare(token, (item) => ({
      ...item,
      feedbacks: item.feedbacks.map((entry) => entry.id === feedbackId ? { ...entry, status: action === "adopt" ? "adopted" : "ignored", resolvedAt } : entry)
    }));
    return json(res, 200, { ok: true, status: action === "adopt" ? "adopted" : "ignored" });
  }
  if (req.method === "POST" && url.pathname === "/api/translate") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    if (!String(body.source || "").trim()) {
      const error = new Error("请输入中文原文");
      error.statusCode = 400;
      throw error;
    }
    const classification = await classify({ text: body.source, hint: body.contentType, useModel: body.useModelClassification, neighborContext: body.neighborContext });
    const assets = await getAssets(locale);
    const domainResolution = resolveDomain(body.source, body.domain, { contentType: classification.contentType });
    const domain = domainResolution.domain;
    const scope = learningScope({ locale, contentType: classification.contentType, domain, project: body.project || "default" });
    const translationSkill = await ensureChampionTranslationSkill(scope);
    const memoryLimit = Math.min(10, Math.max(1, Number(translationSkill.strategy?.retrieval?.translationMemory?.limit) || 5));
    const qaCaseLimit = Math.min(10, Math.max(1, Number(translationSkill.strategy?.retrieval?.qaCases?.limit) || 3));
    const passScore = Math.min(100, Math.max(70, Number(translationSkill.strategy?.qa?.minimumScore) || 90));
    const maxRevisions = Math.min(4, Math.max(0, Number(translationSkill.strategy?.qa?.maximumRevisionAttempts) ?? 2));
    const matches = matchTerms(body.source, assets, {
      contentType: classification.contentType,
      domain
    });
    const queryEmbedding = await embedSource(body.source);
    const [storedStyleProfile, localeQaCases, localeMemories, userProfile] = await Promise.all([
      getStyleProfile(locale, classification.contentType, domain),
      getQaCases(locale, { contentType: classification.contentType, domain: "general", limit: -1 }),
      getMemories(locale, { contentType: classification.contentType, domain: "general", limit: -1 }),
      getUserProfile(locale)
    ]);
    const narrowedQaCases = narrowByDomain(localeQaCases, domain);
    const narrowedMemories = narrowByDomain(localeMemories, domain);
    domainResolution.relaxedRetrieval = narrowedMemories.relaxed || narrowedQaCases.relaxed;
    const qaGuidance = rankQaCases(body.source, narrowedQaCases.items, { limit: qaCaseLimit, queryEmbedding });
    const translationReferences = rankTranslationMemories(body.source, narrowedMemories.items, { limit: memoryLimit, queryEmbedding });
    // 批次排比/韵文检测：同一批次的多行共用一种句式时，注入模板约束；
    // 客户端顺序翻译时还会带上本批已定稿译文作为风格锚点。
    let batchVerse = null;
    if (body.batchId) {
      try {
        const batchRun = await getBatchRun(String(body.batchId));
        batchVerse = detectBatchVerse(batchRun?.segments || []);
      } catch { /* 批次记录不可用不影响翻译 */ }
    }
    const contextPack = buildContextPack({
      source: body.source,
      locale,
      classification,
      matches,
      domain,
      neighborContext: body.neighborContext || "",
      styleProfile: storedStyleProfile || body.styleProfile || null,
      translationSkill,
      qaGuidance,
      userProfile,
      translationReferences,
      batchVerse,
      batchReferences: body.batchReferences || []
    });
    const startedAt = Date.now();
    let trajectory = null;
    let learningCaptureError = translationSkill.persistenceError || "";
    try {
      trajectory = await saveLearningTrajectory({
        ...scope, batchId: body.batchId || "", segmentId: body.segmentId || "", source: body.source,
        contextPack, assetRefs: {
          translationSkillId: translationSkill.id,
          styleProfileId: contextPack.styleProfile?.id || "",
          termIds: matches.map((item) => item.term?.id).filter(Boolean),
          memoryIds: translationReferences.map((item) => item.id).filter(Boolean),
          qaCaseIds: qaGuidance.map((item) => item.id).filter(Boolean)
        },
        model: getProviderConfig().model, promptVersion: TRANSLATION_PROMPT_VERSION,
        status: "running", events: [{ type: "started", at: new Date().toISOString() }]
      });
    } catch (error) {
      learningCaptureError = error.message;
    }
    try {
      const aiQaEnabled = body.aiQa !== false;
      const result = await translateWithReflection(contextPack, { reflect: !aiQaEnabled && body.reflect !== false });
      const aiQa = aiQaEnabled
        ? await runAiQaLoop({
          contextPack, initialTranslation: result.translation, matches, locale,
          contentType: classification.contentType, domain, batchId: body.batchId || "",
          providedReferences: translationReferences, passScore, maxRevisions
        })
        : { translation: result.translation, issues: runQa({ source: body.source, translation: result.translation, matches, locale }), score: null, status: "disabled", iterations: 0, used: false, fallbackReason: "", references: [] };
      const suggestionCandidates = buildSuggestionCandidates(aiQa.translation, matches);
      let alignment = { requested: suggestionCandidates.length > 0, used: false, fallbackReason: "" };
      let modelSuggestions = [];
      if (suggestionCandidates.length) {
        try {
          modelSuggestions = await alignTermSuggestionsWithModel(locale, aiQa.translation, suggestionCandidates);
          alignment.used = true;
        } catch (error) {
          alignment.fallbackReason = error.message;
        }
      }
      const termSuggestions = resolveTermSuggestions(aiQa.translation, suggestionCandidates, modelSuggestions);
      const initialIssues = runQa({ source: body.source, translation: result.initial || result.translation, matches, locale });
      let completedTrajectory = trajectory;
      if (trajectory) {
        try {
          completedTrajectory = await updateLearningTrajectory(trajectory.id, {
            initialTranslation: result.initial || result.translation,
            finalTranslation: aiQa.translation,
            termDecisions: aiQa.termDecisions || [],
            qaBefore: { ...trajectoryMetricsFromIssues(initialIssues, calculateQaScore({ hardIssues: initialIssues }), matches), issues: initialIssues },
            qaAfter: { ...trajectoryMetricsFromIssues(aiQa.issues, aiQa.score, matches), issues: aiQa.issues, iterations: aiQa.iterations },
            events: [
              { type: "started", at: trajectory.createdAt },
              { type: "completed", at: new Date().toISOString(), latencyMs: Date.now() - startedAt, aiQaIterations: aiQa.iterations }
            ],
            status: aiQa.status === "review" ? "review" : "completed",
            error: aiQa.fallbackReason || ""
          });
        } catch (error) {
          learningCaptureError = error.message;
        }
      }
      return json(res, 200, {
        locale,
        classification,
        domainResolution,
        matches,
        contextPack,
        ...result,
        translation: aiQa.translation,
        issues: aiQa.issues,
        qaScore: aiQa.score,
        aiQa,
        styleProfile: contextPack.styleProfile,
        translationSkill: { id: translationSkill.id, name: translationSkill.name, version: translationSkill.version, status: translationSkill.status },
        trajectoryId: completedTrajectory?.id || "",
        learningCapture: { captured: Boolean(completedTrajectory?.id) && !learningCaptureError, warning: learningCaptureError },
        termSuggestions,
        suggestionAlignment: alignment
      });
    } catch (error) {
      if (trajectory) {
        await updateLearningTrajectory(trajectory.id, {
          status: "failed",
          error: error.message,
          events: [{ type: "started", at: trajectory.createdAt }, { type: "failed", at: new Date().toISOString(), latencyMs: Date.now() - startedAt, error: error.message }]
        }).catch(() => undefined);
      }
      throw error;
    }
  }
  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  // 分享验证页：/share 与 /share/<token> 都渲染独立的轻量页面
  if (pathname === "/share" || pathname.startsWith("/share/")) pathname = "/share.html";
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const path = join(PUBLIC_ROOT, safePath);
  if (!path.startsWith(PUBLIC_ROOT)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(path)] || "application/octet-stream",
      "content-length": body.length
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

await initializeStore();

// 恢复未完成任务，并修复旧版本错误写成 ready、实际却没有完成拆解的历史记录。
try {
  const shares = await listShares({});
  for (const share of shares) {
    const expected = Math.min((share.segments || []).length, SHARE_GLOSS_LIMIT);
    const glossed = (share.segments || []).slice(0, expected).filter((segment) => segment.gloss).length;
    if (share.status === "ready" && (glossed < expected || Number(share.glossedSegments) !== glossed)) {
      await updateShare(share.token, (item) => finalizeShareGlossGeneration(item, {
        failures: glossed < expected ? [share.meta?.fallbackReason || "历史后台拆解未完成"] : [],
        maxSegments: SHARE_GLOSS_LIMIT
      }));
      continue;
    }
    if (share.status === "generating") {
      startShareGlossGeneration(share.token, "分享拆解恢复失败");
    }
  }
} catch (error) {
  console.error("恢复分享拆解任务失败", error);
}

// 技能评测后台任务队列：同一时刻只跑一个评测，逐对持久化检查点，重启后可续跑。
const evaluationJobs = createEvaluationJobRunner({
  benchmark: benchmarkTranslationSkill,
  jobsDirectory: join(DATA_ROOT, "learning", "jobs"),
  concurrency: 5,
  deps: {
    getSkill: getTranslationSkill,
    getCurrentChampion: async (scope) => (await listTranslationSkills({ ...scope, status: "champion", limit: 1 }))[0] || null,
    validatePromotionState: (input) => validateCandidatePromotionState(input),
    saveEvaluation: saveSkillEvaluation,
    updateSkillMetrics: (id, metrics) => updateTranslationSkill(id, { metrics }),
    buildUiReport: learningEvaluationUiReport
  }
});
await evaluationJobs.initialize();

/** 同一作用域的风格规范列表（含草稿与停用版本），供风格评测解析变体。 */
async function styleProfilesInScope(scope) {
  const { styleProfiles } = await listStyleProfiles(scope.locale, null, { contentType: scope.contentType, domain: scope.domain });
  return styleProfiles;
}

async function resolveStyleVariant(id, scope) {
  const profiles = await styleProfilesInScope(scope);
  const profile = String(id) === NO_STYLE_PROFILE_ID ? null : profiles.find((item) => item.id === String(id)) || null;
  if (String(id) !== NO_STYLE_PROFILE_ID && !profile) return null;
  const [skill, activeProfile] = await Promise.all([
    ensureChampionTranslationSkill(scope),
    getStyleProfile(scope.locale, scope.contentType, scope.domain)
  ]);
  // AIQA 始终看当前生效版本，否则草稿会用自己的标准给自己打分。
  return styleVariant({ id, scope, skill, profile, qaProfile: activeProfile });
}

// 风格草稿评测：唯一变量是风格规范本身，技能、留出集与检索隔离两边完全一致。
const styleEvaluationJobs = createEvaluationJobRunner({
  benchmark: benchmarkStyleVariant,
  jobsDirectory: join(DATA_ROOT, "learning", "jobs"),
  concurrency: 5,
  kind: "style-evaluation",
  guardrails: STYLE_PROMOTION_GUARDRAILS,
  deps: {
    getSkill: resolveStyleVariant,
    getCurrentChampion: async (scope) => {
      const active = await getStyleProfile(scope.locale, scope.contentType, scope.domain);
      return resolveStyleVariant(active?.id || NO_STYLE_PROFILE_ID, scope);
    },
    validatePromotionState: ({ candidate, currentChampion }) => validateStylePromotionState({
      draft: candidate?.styleProfile,
      activeProfile: currentChampion?.styleProfile
    }),
    saveEvaluation: async (payload) => {
      const evaluation = {
        draftProfileId: String(payload.challengerSkillId || ""),
        activeProfileId: String(payload.championSkillId || ""),
        sampleCount: payload.sampleCount,
        decision: payload.decision,
        promotable: payload.report?.promotable === true,
        conclusion: payload.report?.conclusion || "",
        report: payload.report,
        evaluatedAt: new Date().toISOString(),
        evaluator: "kami-style-benchmark-v1"
      };
      await saveStyleProfileEvaluation(evaluation.draftProfileId, evaluation);
      return { id: evaluation.draftProfileId };
    },
    updateSkillMetrics: async () => undefined,
    buildUiReport: learningEvaluationUiReport
  }
});
await styleEvaluationJobs.initialize();

// 自动候选生成：人工批准终稿达到阈值后，在后台提议 challenger；评测与激活仍走人工闸门。
const autoProposer = createAutoProposer({
  threshold: Math.max(1, Number(process.env.KAMI_AUTO_PROPOSE_THRESHOLD) || 10),
  growthWindow: Math.max(1, Number(process.env.KAMI_AUTO_PROPOSE_GROWTH_WINDOW) || 10),
  deps: {
    getCurrentChampion: async (scope) => (await listTranslationSkills({ ...scope, status: "champion", limit: 1 }))[0] || null,
    countAcceptedTrajectories: async (scope) => {
      const trajectories = await listLearningTrajectories({ ...scope, limit: 500 });
      return trajectories.filter((item) => item.status === "completed" && item.humanDecision?.accepted === true && String(item.finalTranslation || "").trim()).length;
    },
    listActiveCandidates: async (scope) => {
      const skills = await listTranslationSkills({ ...scope, limit: 20 });
      return skills.filter((item) => ["challenger", "draft"].includes(item.status));
    },
    listTrajectories: async (scope) => listLearningTrajectories({ ...scope, limit: 200 }),
    selectTrajectories: (trajectories) => selectProposalTrajectories(trajectories),
    propose: ({ scope, champion, trajectories }) => proposeChallengerSkill({ scope, champion, trajectories, promptVersion: TRANSLATION_PROMPT_VERSION }),
    recordMetadata: async (championId, existingMetadata, autoPropose) => {
      try {
        await updateTranslationSkill(championId, { metadata: { ...(existingMetadata || {}), autoPropose } });
      } catch (error) {
        // Directus 尚未 provision metadata 字段时记账失败不应阻断候选生成本身。
        console.error(`记录自动候选生成状态失败（可能需要先执行 npm run directus:provision）：${error.message}`);
      }
    }
  }
});

function triggerAutoProposal(scope) {
  autoProposer.maybePropose(scope)
    .then((result) => {
      if (result?.proposed) {
        console.log(`已自动生成候选技能：${result.candidateId}（${result.reason}）`);
        return;
      }
      // 阈值未到/窗口防抖/已有候选等是正常不提议；其他原因按异常记录，避免被静默吞掉。
      const reason = String(result?.reason || "");
      if (!/^(人工批准终稿|自上次自动提议后|当前作用域已有待评测候选|作用域尚无 Champion|没有可复盘的完成轨迹)/u.test(reason)) {
        console.error(`自动候选生成检查异常：${reason}`);
      }
    })
    .catch((error) => console.error("自动候选生成检查失败", error));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await apiHandler(req, res, url);
      if (handled === false) json(res, 404, { error: "API not found" });
      return;
    }
    if (!(await serveStatic(req, res, url))) json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]`, error);
    json(res, error.statusCode || 500, { error: error.message || "Internal server error" });
  }
});

const HOST = process.env.KAMI_HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`Kami Localization Workbench: http://127.0.0.1:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    for (const url of lanShareUrls("")) console.log(`局域网访问（分享给同事可用）：${url.replace(/\/share\/$/, "")}`);
  }
});
