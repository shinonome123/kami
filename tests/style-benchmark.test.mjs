import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_STYLE_PROFILE_ID,
  STYLE_MATERIAL_GAIN_METRICS,
  STYLE_PROMOTION_GUARDRAILS,
  benchmarkStyleVariant,
  selectStyleHoldout,
  styleVariant,
  validateStylePromotionState
} from "../src/style-benchmark.mjs";
import { evaluateSkillPromotion } from "../src/learning-engine.mjs";

const scope = { locale: "ja-JP", contentType: "marketing", domain: "game", project: "default" };

function trajectory(id, source) {
  return {
    id,
    source,
    scope,
    status: "completed",
    finalTranslation: `訳${id}`,
    humanDecision: { accepted: true, finalTranslation: `訳${id}` }
  };
}

function samples(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `case-${index}`,
    scope,
    requiredTermHits: 1,
    requiredTermTotal: 1,
    hardErrorCount: 0,
    qaScore: 92,
    humanEditDistance: 0.3,
    humanAccepted: false,
    latencyMs: 1_000,
    costUsd: 0.001,
    ...overrides
  }));
}

test("风格评测只承认与人工终稿的距离等中立指标作为晋升理由", () => {
  assert.deepEqual([...STYLE_MATERIAL_GAIN_METRICS], ["humanEditDistance", "mandatoryTerms", "hardErrors"]);
  assert.equal(STYLE_MATERIAL_GAIN_METRICS.includes("qaScore"), false, "AIQA 会读风格规范，不能拿它当晋升理由");
  assert.equal(STYLE_MATERIAL_GAIN_METRICS.includes("humanAcceptance"), false, "合成接受率派生自 QA 分，同样不能作为理由");
});

test("QA 分变好但编辑距离没变时，风格草稿不得晋升", () => {
  const result = evaluateSkillPromotion({
    scope,
    champion: { id: "active", scope, samples: samples(12, { qaScore: 90 }) },
    challenger: { id: "draft", scope, samples: samples(12, { qaScore: 99 }) },
    minSamples: 12,
    guardrails: { ...STYLE_PROMOTION_GUARDRAILS, requireCost: false }
  });
  const materialGate = result.gates.find((item) => item.id === "material_gain");
  assert.equal(materialGate.passed, false);
  assert.equal(result.promotable, false);
  assert.match(materialGate.detail, /只认可 humanEditDistance、mandatoryTerms、hardErrors/);
  assert.equal(result.materialGains.qaScore, true, "QA 分确实变好了，只是不被算作晋升理由");
});

test("编辑距离明显靠近人工终稿时允许晋升", () => {
  const result = evaluateSkillPromotion({
    scope,
    champion: { id: "active", scope, samples: samples(12, { humanEditDistance: 0.30 }) },
    challenger: { id: "draft", scope, samples: samples(12, { humanEditDistance: 0.24 }) },
    minSamples: 12,
    guardrails: { ...STYLE_PROMOTION_GUARDRAILS, requireCost: false }
  });
  assert.equal(result.promotable, true);
  assert.match(result.gates.find((item) => item.id === "material_gain").detail, /humanEditDistance/);
});

test("编辑距离改善幅度不足风格阈值时不算收益", () => {
  const result = evaluateSkillPromotion({
    scope,
    champion: { id: "active", scope, samples: samples(12, { humanEditDistance: 0.300 }) },
    challenger: { id: "draft", scope, samples: samples(12, { humanEditDistance: 0.295 }) },
    minSamples: 12,
    guardrails: { ...STYLE_PROMOTION_GUARDRAILS, requireCost: false }
  });
  assert.equal(result.promotable, false, "0.005 的改善够技能门槛，但风格要求 0.01");
});

test("QA 分下降仍然一票否决，即使编辑距离变好", () => {
  const result = evaluateSkillPromotion({
    scope,
    champion: { id: "active", scope, samples: samples(12, { qaScore: 95, humanEditDistance: 0.30 }) },
    challenger: { id: "draft", scope, samples: samples(12, { qaScore: 80, humanEditDistance: 0.20 }) },
    minSamples: 12,
    guardrails: { ...STYLE_PROMOTION_GUARDRAILS, requireCost: false }
  });
  assert.equal(result.gates.find((item) => item.id === "qa_score").passed, false, "QA 分仍是回归护栏");
  assert.equal(result.promotable, false);
});

test("留出集排除蒸馏用过的原文，近似变体同样排除", () => {
  const trajectories = [
    trajectory("t1", "高级通行证现已开放购买"),
    trajectory("t2", "限定皮肤将于本周上线"),
    trajectory("t3", "活动规则请以游戏内公告为准")
  ];
  const holdout = selectStyleHoldout(trajectories, {
    scope,
    distilledFromSources: ["高级通行证现已开放购买", "限定皮肤将于本周上线。"],
    limit: 40
  });
  assert.deepEqual(holdout.map((item) => item.id), ["t3"]);
});

test("没有蒸馏来源时留出集等价于技能留出集", () => {
  const trajectories = [trajectory("t1", "甲"), trajectory("t2", "乙")];
  assert.equal(selectStyleHoldout(trajectories, { scope }).length, 2);
});

test("未完成或未经人工批准的轨迹不进入风格留出集", () => {
  const holdout = selectStyleHoldout([
    { ...trajectory("t1", "甲"), status: "review" },
    { ...trajectory("t2", "乙"), humanDecision: { accepted: false } },
    trajectory("t3", "丙")
  ], { scope });
  assert.deepEqual(holdout.map((item) => item.id), ["t3"]);
});

test("草稿状态与血缘校验：父版本已被换掉时拒绝评测和激活", () => {
  const draft = { id: "d1", status: "draft", parentId: "v1" };
  assert.equal(validateStylePromotionState({ draft, activeProfile: { id: "v1" } }).valid, true);
  const stale = validateStylePromotionState({ draft, activeProfile: { id: "v2" } });
  assert.equal(stale.valid, false);
  assert.match(stale.reasons[0], /当前生效版本已经变化/);
});

test("非草稿状态不可评测", () => {
  const result = validateStylePromotionState({ draft: { id: "d1", status: "active" }, activeProfile: { id: "d1" } });
  assert.equal(result.valid, false);
  assert.match(result.reasons[0], /只有 draft/);
});

test("首个版本没有父版本时可以直接评测", () => {
  assert.equal(validateStylePromotionState({ draft: { id: "d1", status: "draft", parentId: null }, activeProfile: null }).valid, true);
});

test("要求评测时：缺结论、结论张冠李戴、结论反对都会被拦下", () => {
  const draft = { id: "d1", status: "draft", parentId: "" };
  assert.match(validateStylePromotionState({ draft, activeProfile: null, requireEvaluation: true }).reasons[0], /尚未评测/);
  assert.match(validateStylePromotionState({
    draft, activeProfile: null, requireEvaluation: true,
    evaluation: { draftProfileId: "other", promotable: true }
  }).reasons[0], /不属于该草稿/);
  const rejected = validateStylePromotionState({
    draft, activeProfile: null, requireEvaluation: true,
    evaluation: { draftProfileId: "d1", promotable: false, conclusion: "与当前版本持平" }
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reasons[0], "与当前版本持平");
});

test("变体包装保留技能与两个风格规范槽位，空规范表示语体默认", () => {
  const variant = styleVariant({ id: NO_STYLE_PROFILE_ID, scope, skill: { id: "skill-1" }, profile: null, qaProfile: { id: "active" } });
  assert.equal(variant.styleProfile, null);
  assert.equal(variant.qaStyleProfile.id, "active");
  assert.equal(variant.skill.id, "skill-1");
});

test("变体缺少 champion 技能时立刻报错，不静默跑出无意义样本", async () => {
  await assert.rejects(
    () => benchmarkStyleVariant({ id: "d1", styleProfile: null }, trajectory("t1", "甲")),
    /缺少当前 champion 技能/
  );
});
