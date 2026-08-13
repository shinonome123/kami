import { distillBatchStyleLearningWithModel, distillStyleProfileWithModel, distillUserProfileWithModel, getProviderConfig, reviewEvolutionWithModel } from "./provider.mjs";
import { getQaRuns, getStyleEvidence, getStyleProfile, saveStyleLearningRun, saveStyleProfile, saveUserProfile } from "./store.mjs";

export const DISTILL_THRESHOLD = 8;
export const PROFILE_THRESHOLD = 3;

function sampleEvidence(evidence) {
  const human = evidence.filter((item) => item.provenance === "human-accept");
  const rest = evidence.filter((item) => item.provenance !== "human-accept");
  return [...human, ...rest].slice(0, 30).map((item) => ({ source: item.source, target: item.target }));
}

function dedupeQaRuns(runs) {
  const seen = new Set();
  return runs.filter((run) => {
    if (seen.has(run.source)) return false;
    seen.add(run.source);
    return true;
  });
}

function batchExamples(evidence = []) {
  const seen = new Set();
  return evidence.filter((item) => {
    const key = `${item.source}\u0000${item.target}`;
    if (!item.source || !item.target || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30).map((item) => ({ source: item.source, target: item.target, sourceRow: item.rowNumber || item.sourceRow || null }));
}

function fallbackBatchLearning(examples, contentType) {
  const sourceAverage = examples.reduce((sum, item) => sum + [...item.source].length, 0) / examples.length;
  const targetAverage = examples.reduce((sum, item) => sum + [...item.target].length, 0) / examples.length;
  const hasDialoguePunctuation = examples.filter((item) => /[，,。！？!?…]/u.test(item.source)).length;
  return {
    summary: `本批已收集 ${examples.length} 组${contentType === "dialogue" ? "剧情对白" : "同类"}双语证据，主要呈现短句节奏、称谓关系与语气对应；正式规则仍需结合更多证据或模型复核。`,
    rules: [
      { category: "长度与节奏", observation: `中文平均 ${sourceAverage.toFixed(1)} 字，目标译文平均 ${targetAverage.toFixed(1)} 字`, guidance: "后续翻译优先保持信息密度与停顿节奏，不机械追求逐字等长。", confidence: 0.55 },
      { category: "标点与语气", observation: `${hasDialoguePunctuation}/${examples.length} 条中文证据包含对话停顿或句末标点`, guidance: "依据角色语气保留停顿与情绪强度，并遵循目标语言自然标点。", confidence: 0.5 }
    ],
    examples: examples.slice(0, 3).map((item) => ({ type: "positive", source: item.source, target: item.target, reason: "本批已对齐译例" })),
    caveat: "模型浓缩暂不可用，本记录由本地统计生成，仅作为可见学习记录，不直接启用。",
    confidence: 0.5
  };
}

export async function distillBatchStyleLearning({ batchId, filename, locale, contentType, domain, evidence = [] }) {
  const examples = batchExamples(evidence);
  if (!examples.length) return null;
  let learning;
  try {
    learning = await distillBatchStyleLearningWithModel({
      batchId, filename, locale, contentType, domain, examples
    });
  } catch {
    learning = fallbackBatchLearning(examples, contentType);
  }
  return saveStyleLearningRun({
    batchId,
    filename,
    locale,
    contentType,
    domain,
    evidenceCount: evidence.length,
    summary: learning.summary,
    rules: learning.rules,
    examples: learning.examples,
    caveat: learning.caveat,
    confidence: learning.confidence,
    status: "observed",
    promotedProfileId: "",
    generatedBy: getProviderConfig().model
  });
}

export async function distillStyleProfileIfReady({ locale, contentType, domain, sourceBatchId = "", learningRunId = "" }) {
  const evidence = await getStyleEvidence(locale, { contentType, domain, exactScope: true, limit: 1_000 });
  if (evidence.length < DISTILL_THRESHOLD) return { distilled: null, evidenceCount: evidence.length, threshold: DISTILL_THRESHOLD };
  const previousProfile = await getStyleProfile(locale, contentType, domain);
  const distilled = await distillStyleProfileWithModel({ locale, contentType, domain, examples: sampleEvidence(evidence), previousProfile });
  const profile = await saveStyleProfile({
    locale, contentType, domain, ...distilled,
    evidenceCount: evidence.length,
    evidenceIds: evidence.slice(0, 200).map((item) => item.id),
    generatedBy: getProviderConfig().model,
    sourceBatchId,
    learningRunId,
    status: "draft"
  });
  return { distilled: profile, evidenceCount: evidence.length, threshold: DISTILL_THRESHOLD };
}

export async function distillUserProfileIfReady(locale) {
  const evidence = await getStyleEvidence(locale, { limit: 1_000 });
  const accepted = evidence.filter((item) => item.provenance === "human-accept");
  if (accepted.length < PROFILE_THRESHOLD) return { profile: null, acceptedCount: accepted.length, threshold: PROFILE_THRESHOLD };
  const distilled = await distillUserProfileWithModel({ locale, examples: sampleEvidence(accepted) });
  const profile = await saveUserProfile({ locale, ...distilled, evidenceCount: accepted.length, status: "draft" });
  return { profile, acceptedCount: accepted.length, threshold: PROFILE_THRESHOLD };
}

export async function runEvolutionReview({ locale, contentType, domain, batchId = "" }) {
  const evidence = await getStyleEvidence(locale, { contentType, domain, exactScope: true, limit: 1_000 });
  const qaRuns = dedupeQaRuns(await getQaRuns(locale, { contentType, domain, limit: 60 }));
  const previousProfile = await getStyleProfile(locale, contentType, domain);
  const result = {
    locale, contentType, domain, batchId,
    evidenceCount: evidence.length,
    qaRunsReviewed: qaRuns.length,
    distilled: null,
    profile: null,
    review: null,
    fallbackReasons: {}
  };
  try {
    result.review = await reviewEvolutionWithModel({ locale, contentType, domain, qaRuns, evidence, previousProfile });
  } catch (error) {
    result.fallbackReasons.review = error.message;
  }
  if (result.review?.stylePatch) {
    try {
      result.distilled = await saveStyleProfile({
        locale, contentType, domain,
        name: `${previousProfile?.name || `${locale} ${contentType} 风格`} 复盘修订`,
        instruction: result.review.stylePatch.instruction,
        examples: result.review.stylePatch.examples,
        evidenceCount: evidence.length,
        evidenceIds: evidence.slice(0, 200).map((item) => item.id),
        generatedBy: getProviderConfig().model,
        status: "draft"
      });
    } catch (error) {
      result.fallbackReasons.stylePatch = error.message;
    }
  } else {
    try {
      const distilled = await distillStyleProfileIfReady({ locale, contentType, domain });
      if (distilled.distilled) result.distilled = distilled.distilled;
      else result.distillPending = { evidenceCount: distilled.evidenceCount, threshold: distilled.threshold };
    } catch (error) {
      result.fallbackReasons.distill = error.message;
    }
  }
  try {
    const profileResult = await distillUserProfileIfReady(locale);
    if (profileResult.profile) result.profile = profileResult.profile;
    else result.profilePending = { acceptedCount: profileResult.acceptedCount, threshold: profileResult.threshold };
  } catch (error) {
    result.fallbackReasons.profile = error.message;
  }
  return result;
}
