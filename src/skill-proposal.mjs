/**
 * Shared challenger proposal used by both the manual "生成候选技能" button and
 * the automatic proposer. Keeps the two paths on identical logic: trajectory
 * selection, model proposal, patch merge and persistence.
 */

import { collectTrainingEvidenceIds, mergeTranslationSkillPatch } from "./learning-engine.mjs";
import { getProviderConfig, proposeTranslationSkillWithModel } from "./provider.mjs";
import { saveTranslationSkill } from "./store.mjs";
import { sanitizeStrategyPatch } from "./strategy-patch.mjs";

/** Trajectories that can inform a proposal: finished or reviewed, with a final translation. */
export function selectProposalTrajectories(trajectories = [], limit = 40) {
  return trajectories
    .filter((item) => ["completed", "review"].includes(item.status) && item.finalTranslation)
    .slice(0, limit);
}

/**
 * Propose and persist a challenger for one exact scope. Throws the same 409 as
 * the manual endpoint when no usable trajectory exists.
 */
export async function proposeChallengerSkill({ scope, champion, trajectories = [], promptVersion = "kami-translation-v1" }) {
  const usable = selectProposalTrajectories(trajectories);
  if (!usable.length) {
    const error = new Error("当前语言和范围还没有可复盘的完成轨迹，请先完成几条翻译或人工采纳");
    error.statusCode = 409;
    throw error;
  }
  const trainingEvidenceIds = collectTrainingEvidenceIds(usable);
  const proposed = await proposeTranslationSkillWithModel({ ...scope, champion, trajectories: usable });
  // 模型返回的策略补丁是不可信输入：白名单校验、数值夹紧、长度截断与注入特征拦截。
  const sanitized = sanitizeStrategyPatch(proposed.strategyPatch);
  if (!Object.keys(sanitized.patch).length) {
    const error = new Error("模型返回的策略补丁未通过白名单校验，已拒绝生成候选");
    error.statusCode = 409;
    throw error;
  }
  const engineChampion = {
    id: champion.id,
    version: champion.version,
    status: champion.status,
    scope,
    name: champion.name,
    description: champion.description,
    strategy: champion.strategy || {},
    metadata: champion.metadata || {}
  };
  const sanitizationMetadata = sanitized.warnings.length
    ? { sanitization: { warnings: sanitized.warnings, sanitizedAt: new Date().toISOString() } }
    : {};
  const merged = mergeTranslationSkillPatch(engineChampion, {
    name: proposed.name,
    description: proposed.reason,
    changeReason: proposed.reason,
    strategy: sanitized.patch,
    metadata: { generatedBy: getProviderConfig().model, ...sanitizationMetadata }
  });
  return saveTranslationSkill({
    ...scope,
    name: merged.name,
    description: merged.description,
    changeReason: merged.changeReason,
    version: merged.version,
    parentId: champion.id,
    status: "challenger",
    strategy: merged.strategy,
    metadata: merged.metadata,
    // Every trajectory sent to the proposal model is training evidence. Keep
    // the complete set so none of it can later leak into the holdout pool.
    evidenceIds: trainingEvidenceIds,
    promptVersion,
    metrics: {}
  });
}
