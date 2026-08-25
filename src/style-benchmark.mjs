/**
 * Paired benchmark for style-profile drafts.
 *
 * Until now the promotion machinery only ever tested `translation_skills` —
 * retrieval limits, extra instructions, QA thresholds. The object that actually
 * carries the house style, `style_profiles`, was activated on a human eyeballing
 * two paragraphs of prose, with no holdout, no regression check and no rollback
 * signal. This module runs a draft profile against the active one through the
 * same paired-benchmark and gate machinery the skill loop already uses.
 *
 * Two rules make the comparison honest:
 *
 * 1. ONLY the style profile differs. Both variants use the current champion
 *    skill, the same holdout cases and the same isolated retrieval, so any
 *    metric delta is attributable to the profile text.
 *
 * 2. The AIQA judge keeps reading the ACTIVE profile for both variants. AIQA
 *    receives the style profile as its nuance yardstick, so letting the draft
 *    grade its own output would make "QA 分不得下降" self-fulfilling — a draft
 *    saying "be verbose" would score verbose output highly. Judging both by the
 *    incumbent standard keeps qa_score meaningful as a REGRESSION GUARD, and
 *    pushes the burden of proving improvement onto edit distance against the
 *    human final, which no profile can influence.
 */

import { benchmarkTranslationSkill } from "./skill-benchmark.mjs";
import { selectSkillHoldout } from "./learning-engine.mjs";
import { isSelfDerived } from "./benchmark-isolation.mjs";
import { normalizeSource } from "./text.mjs";

/** Id used for the "no distilled profile yet" baseline, matching the context pack default. */
export const NO_STYLE_PROFILE_ID = "content-type-default";

/**
 * Punctuation- and space-free skeleton of a source sentence.
 *
 * `isSelfDerived` uses a 0.95 similarity threshold, which is right for per-case
 * retrieval isolation but under-catches short sentences: one trailing 。 on a
 * ten-character line scores 0.909 and would slip into the holdout even though
 * the profile was distilled from that exact line. Holdout exclusion should err
 * toward removing too much — a holdout that ends up too small is reported by
 * the minimum-sample guard, whereas silent leakage just inflates the score.
 */
function sourceSkeleton(value) {
  return normalizeSource(value).replace(/[\p{P}\p{S}\s]/gu, "");
}

/**
 * Metrics allowed to justify activating a style draft.
 *
 * qaScore and humanAcceptance are deliberately absent: both are computed with a
 * model that reads a style profile, and humanAcceptance is itself derived from
 * qaScore. They remain as gates (must not regress) but cannot be the reason to
 * promote. Distance to the human final is the signal that survives.
 */
export const STYLE_MATERIAL_GAIN_METRICS = Object.freeze(["humanEditDistance", "mandatoryTerms", "hardErrors"]);

export const STYLE_PROMOTION_GUARDRAILS = Object.freeze({
  materialGainMetrics: STYLE_MATERIAL_GAIN_METRICS,
  // A style rewrite legitimately changes wording, so demand a clearly larger
  // move toward the human final than a skill tweak has to show.
  minimumEditDistanceGain: 0.01
});

/** Minimum holdout size before a style conclusion is allowed to mean anything. */
export const STYLE_MIN_EVALUATION_SAMPLES = 12;

/**
 * Wrap a style profile as a benchmark variant. `profile` may be null, which
 * means "no distilled profile" — the content-type default register.
 */
export function styleVariant({ id, scope, skill, profile, qaProfile }) {
  return {
    id: String(id || ""),
    scope,
    skill,
    styleProfile: profile ?? null,
    qaStyleProfile: qaProfile ?? null
  };
}

/**
 * Benchmark one holdout case against one style variant. Signature matches what
 * `runPairedSkillBenchmarks` passes so the existing pairing, alternating run
 * order and all-or-nothing pair admission are reused unchanged.
 */
export async function benchmarkStyleVariant(variant, trajectory) {
  if (!variant?.skill) throw new TypeError("风格评测变体缺少当前 champion 技能");
  const sample = await benchmarkTranslationSkill(variant.skill, trajectory, {
    styleProfileOverride: variant.styleProfile,
    qaStyleProfile: variant.qaStyleProfile
  });
  return { ...sample, variantId: variant.id };
}

/**
 * Confirm the draft is still activatable against the profile it was branched
 * from. Mirrors `validateCandidatePromotionState` for skills: a draft whose
 * parent stopped being the active version was distilled from a different
 * baseline and its评测 conclusion no longer describes the change on offer.
 */
export function validateStylePromotionState({ draft, activeProfile, evaluation = null, requireEvaluation = false } = {}) {
  const reasons = [];
  if (!draft) reasons.push("草稿不存在");
  else {
    if (draft.status !== "draft") reasons.push(`草稿状态为 ${draft.status}，只有 draft 可以评测或激活`);
    const parentId = String(draft.parentId || "");
    const activeId = String(activeProfile?.id || "");
    if (parentId && activeId && parentId !== activeId) {
      reasons.push("当前生效版本已经变化，本草稿基于旧版本蒸馏，请重新蒸馏后再评测");
    }
  }
  if (requireEvaluation) {
    if (!evaluation) reasons.push("尚未评测");
    else if (String(evaluation.draftProfileId || "") !== String(draft?.id || "")) reasons.push("评测结论不属于该草稿");
    else if (evaluation.promotable !== true) reasons.push(evaluation.conclusion || "评测结论不支持启用");
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Holdout for a style draft.
 *
 * On top of the skill holdout rules (completed, human-accepted, non-empty
 * final translation), every trajectory whose source produced one of the
 * evidence records this draft was distilled from is removed. Those sentences
 * shaped the profile text itself, so scoring the draft on them measures recall
 * of its own training data.
 *
 * Per-case clean-room isolation still runs inside the benchmark and removes the
 * matching memories, QA cases and profile examples; what it cannot remove is
 * the abstract preference already baked into the instruction text, which is
 * exactly why the source-level exclusion has to happen here.
 */
export function selectStyleHoldout(trajectories, { scope, distilledFromSources = [], limit = 40 } = {}) {
  const sources = (Array.isArray(distilledFromSources) ? distilledFromSources : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const skeletons = new Set(sources.map(sourceSkeleton).filter(Boolean));
  const unseen = (Array.isArray(trajectories) ? trajectories : []).filter((item) => {
    const source = String(item?.source || "").trim();
    if (!source) return false;
    if (skeletons.has(sourceSkeleton(source))) return false;
    return !sources.some((evidenceSource) => isSelfDerived(evidenceSource, source));
  });
  return selectSkillHoldout(unseen, { scope, limit });
}
