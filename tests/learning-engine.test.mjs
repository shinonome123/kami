import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIN_EVALUATION_SAMPLES,
  assertExactLearningScope,
  calculateSkillEvaluationMetrics,
  collectTrainingEvidenceIds,
  createDefaultTranslationSkill,
  evaluateSkillPromotion,
  learningScopeKey,
  mergeTranslationSkillPatch,
  normalizeLearningScope,
  normalizedEditDistance,
  pairedBenchmarkOrder,
  selectSkillHoldout,
  summarizeTrajectoryAttribution,
  validateCandidatePromotionState
} from "../src/learning-engine.mjs";

const scope = {
  locale: "ja-JP",
  contentType: "marketing",
  domain: "game",
  project: "wukong-global"
};

function sample(index, overrides = {}) {
  return {
    caseId: `case-${index}`,
    scope,
    requiredTermHits: 2,
    requiredTermTotal: 2,
    hardErrorCount: 0,
    qaScore: 92,
    humanEditDistance: 0.08,
    humanAccepted: index % 2 === 0,
    cost: 0.012,
    latencyMs: 900,
    ...overrides
  };
}

test("学习作用域强制包含 locale × contentType × domain × project", () => {
  assert.deepEqual(normalizeLearningScope(scope), scope);
  assert.match(learningScopeKey(scope), /ja-JP::marketing::game::wukong-global/);
  assert.throws(() => normalizeLearningScope({ ...scope, project: "" }), /缺少 project/);
  assert.throws(() => normalizeLearningScope({ ...scope, domain: "*" }), /不允许使用通配值/);
  assert.throws(
    () => assertExactLearningScope(scope, { ...scope, locale: "ko-KR" }, "候选技能"),
    /候选技能作用域不一致/
  );
});

test("默认翻译技能可被候选补丁深合并，且作用域和原对象保持不变", () => {
  const champion = createDefaultTranslationSkill({ id: "skill-ja-1", scope });
  const original = structuredClone(champion);
  const challenger = mergeTranslationSkillPatch(champion, {
    scope,
    changeReason: "减少过度修订并扩大前文窗口",
    strategy: {
      context: { includePreviousSegments: 4 },
      qa: { maximumRevisionAttempts: 3 }
    },
    metadata: { proposedBy: "background-review" }
  }, { candidateId: "skill-ja-2" });

  assert.deepEqual(champion, original, "纯函数不得修改 champion");
  assert.equal(challenger.id, "skill-ja-2");
  assert.equal(challenger.parentId, "skill-ja-1");
  assert.equal(challenger.version, 2);
  assert.equal(challenger.status, "challenger");
  assert.deepEqual(challenger.scope, scope);
  assert.equal(challenger.strategy.context.includePreviousSegments, 4);
  assert.equal(challenger.strategy.context.includeNextSegments, 1, "未打补丁的默认策略必须保留");
  assert.equal(challenger.strategy.qa.minimumScore, 90);
  assert.equal(challenger.strategy.qa.maximumRevisionAttempts, 3);

  assert.throws(() => mergeTranslationSkillPatch(champion, {
    scope: { ...scope, project: "another-project" },
    strategy: {}
  }), /作用域不一致/);
  assert.throws(() => mergeTranslationSkillPatch(champion, { version: 99 }), /不允许修改字段：version/);
});

test("候选训练集记录全部模型输入，留出集严格排除且保持四维作用域", () => {
  const training = [
    { id: "train-1" },
    { id: "train-2" },
    { id: "train-1" }
  ];
  const trainingEvidenceIds = collectTrainingEvidenceIds(training);
  assert.deepEqual(trainingEvidenceIds, ["train-1", "train-2"]);

  const eligible = (id, overrides = {}) => ({
    id,
    ...scope,
    status: "completed",
    finalTranslation: `译文 ${id}`,
    humanDecision: { accepted: true, finalTranslation: `终稿 ${id}` },
    ...overrides
  });
  const holdout = selectSkillHoldout([
    eligible("train-1"),
    eligible("holdout-1"),
    eligible("cross-project", { project: "another-project" }),
    eligible("not-approved", { humanDecision: { accepted: false } }),
    eligible("holdout-2")
  ], { scope, trainingEvidenceIds, limit: 10 });
  assert.deepEqual(holdout.map((item) => item.id), ["holdout-1", "holdout-2"]);
});

test("配对评测逐 case 交错 Champion / Challenger 先后顺序", () => {
  assert.deepEqual(pairedBenchmarkOrder(0), ["champion", "challenger"]);
  assert.deepEqual(pairedBenchmarkOrder(1), ["challenger", "champion"]);
  assert.deepEqual(pairedBenchmarkOrder(2), ["champion", "challenger"]);
  assert.throws(() => pairedBenchmarkOrder(-1), /非负整数/);
});

test("候选只能基于当前 Champion 评测和激活，过期父版本或错配评测会被拒绝", () => {
  const champion = { id: "champion-v2", ...scope, status: "champion" };
  const candidate = { id: "candidate-v3", parentId: champion.id, ...scope, status: "challenger" };
  const evaluation = {
    ...scope,
    championSkillId: champion.id,
    challengerSkillId: candidate.id,
    decision: "promote",
    report: { promotable: true }
  };
  assert.equal(validateCandidatePromotionState({ candidate, currentChampion: champion }).valid, true);
  assert.equal(validateCandidatePromotionState({ candidate, currentChampion: champion, evaluation, requireEvaluation: true }).valid, true);

  const stale = validateCandidatePromotionState({
    candidate: { ...candidate, parentId: "champion-v1" },
    currentChampion: champion,
    evaluation,
    requireEvaluation: true
  });
  assert.equal(stale.valid, false);
  assert.ok(stale.reasons.some((reason) => reason.includes("父版本")));

  const mismatched = validateCandidatePromotionState({
    candidate,
    currentChampion: champion,
    evaluation: { ...evaluation, championSkillId: "champion-v1" },
    requireEvaluation: true
  });
  assert.equal(mismatched.valid, false);
  assert.ok(mismatched.reasons.some((reason) => reason.includes("Champion 已过期")));

  const inactive = validateCandidatePromotionState({ candidate: { ...candidate, status: "inactive" }, currentChampion: champion });
  assert.equal(inactive.valid, false);
  assert.ok(inactive.reasons.some((reason) => reason.includes("候选状态")));
});

test("Unicode 人工编辑距离按码点计算", () => {
  assert.equal(normalizedEditDistance("孙悟空", "孙悟空"), 0);
  assert.equal(normalizedEditDistance("孙悟空", "孙行者"), 2 / 3);
  assert.equal(normalizedEditDistance("", "悟空"), 1);
});

test("轨迹归因区分改进信号、暴露资产和后续学习候选", () => {
  const result = summarizeTrajectoryAttribution({
    id: "trajectory-1",
    scope,
    initial: {
      translation: "デラックス版",
      requiredTermHits: 1,
      requiredTermTotal: 2,
      hardErrorCount: 1,
      qaScore: 61
    },
    final: {
      translation: "デジタルデラックス版",
      requiredTermHits: 2,
      requiredTermTotal: 2,
      hardErrorCount: 0,
      qaScore: 96
    },
    context: {
      requiredTerms: [{ source: "数字豪华版", target: "デジタルデラックス版" }],
      styleProfile: { id: "style-8", name: "日语宣发", version: 2 },
      translationReferences: [{ id: "tm-1" }, { id: "tm-2" }]
    },
    revisions: [{ type: "aiqa" }],
    humanFeedback: { accepted: true, editDistance: 0.01 }
  });

  assert.equal(result.outcome, "improved");
  assert.equal(result.deltas.qaScore, 35);
  assert.equal(result.deltas.hardErrorCount, -1);
  assert.equal(result.deltas.mandatoryTermAccuracy, 0.5);
  assert.ok(result.contributions.some((item) => item.factor === "terminology" && item.direction === "positive"));
  assert.ok(result.contributions.some((item) => item.factor === "style_profile" && item.direction === "exposed"));
  assert.ok(result.learningCandidates.some((item) => item.type === "positive_example"));
  assert.match(result.reportZh, /已有正向改进信号/);
  assert.match(result.reportZh, /AIQA 修订/);
});

test("轨迹仍有硬错误或人工拒绝时提出 QA 与策略学习候选", () => {
  const result = summarizeTrajectoryAttribution({
    id: "trajectory-rejected",
    scope,
    initial: { requiredTermHits: 0, requiredTermTotal: 1, hardErrorCount: 2, qaScore: 52 },
    final: { translation: "bad", requiredTermHits: 0, requiredTermTotal: 1, hardErrorCount: 1, qaScore: 63 },
    revisions: [{ type: "aiqa" }],
    humanFeedback: { accepted: false, finalTranslation: "completely revised" }
  });
  assert.equal(result.outcome, "needs_learning");
  assert.ok(result.learningCandidates.some((item) => item.type === "terminology_rule"));
  assert.ok(result.learningCandidates.some((item) => item.type === "qa_rule"));
  assert.ok(result.learningCandidates.some((item) => item.type === "style_or_prompt_patch"));
});

test("评测指标完整计算强制术语、硬错误、QA、人工、成本和延迟", () => {
  const samples = [
    sample(1, { requiredTermHits: 1, hardErrorCount: 1, qaScore: 80, humanEditDistance: 0.2, humanAccepted: false, cost: 0.01, latencyMs: 100 }),
    sample(2, { requiredTermHits: 2, hardErrorCount: 0, qaScore: 100, humanEditDistance: 0, humanAccepted: true, cost: 0.03, latencyMs: 300 })
  ];
  const metrics = calculateSkillEvaluationMetrics(samples, { scope, minSamples: 2 });
  assert.equal(metrics.status, "ready");
  assert.equal(metrics.mandatoryTermAccuracy, 0.75);
  assert.equal(metrics.hardErrorCount, 1);
  assert.equal(metrics.hardErrorsPerSample, 0.5);
  assert.equal(metrics.hardErrorFreeRate, 0.5);
  assert.equal(metrics.qaScore, 90);
  assert.equal(metrics.humanEditDistance, 0.1);
  assert.equal(metrics.humanAcceptanceRate, 0.5);
  assert.equal(metrics.cost.total, 0.04);
  assert.equal(metrics.cost.average, 0.02);
  assert.equal(metrics.latencyMs.average, 200);
  assert.equal(metrics.latencyMs.p95, 300);
  assert.deepEqual(Object.values(metrics.coverage), [1, 1, 1, 1, 1, 1, 1]);
});

test("人工编辑距离可由模型译文与人工终稿自动计算", () => {
  const metrics = calculateSkillEvaluationMetrics([
    sample(1, { humanEditDistance: undefined, translation: "abc", humanFinalTranslation: "adc" })
  ], { scope, minSamples: 1 });
  assert.equal(metrics.humanEditDistance, 1 / 3);
});

test("小样本明确标记 insufficient，默认门槛为 20", () => {
  const metrics = calculateSkillEvaluationMetrics([sample(1)], { scope });
  assert.equal(DEFAULT_MIN_EVALUATION_SAMPLES, 20);
  assert.equal(metrics.status, "insufficient");
  assert.match(metrics.insufficientReason, /少于门槛 20/);

  const promotion = evaluateSkillPromotion({
    scope,
    champion: { id: "v1", scope, samples: [sample(1)] },
    challenger: { id: "v2", scope, samples: [sample(1, { qaScore: 99 })] }
  });
  assert.equal(promotion.status, "insufficient");
  assert.equal(promotion.promotable, false);
  assert.match(promotion.reportZh, /证据不足/);
});

test("同范围同评测集、质量不退步且存在实质收益时允许晋升", () => {
  const championSamples = Array.from({ length: 10 }, (_, index) => sample(index, {
    requiredTermHits: index === 0 ? 1 : 2,
    hardErrorCount: index === 0 ? 1 : 0,
    qaScore: 91,
    humanEditDistance: 0.1,
    humanAccepted: index < 7,
    cost: 0.02,
    latencyMs: 1000
  }));
  const challengerSamples = Array.from({ length: 10 }, (_, index) => sample(index, {
    requiredTermHits: 2,
    hardErrorCount: 0,
    qaScore: 95,
    humanEditDistance: 0.05,
    humanAccepted: index < 9,
    cost: 0.018,
    latencyMs: 850
  }));
  const result = evaluateSkillPromotion({
    scope,
    minSamples: 10,
    champion: { id: "v1", scope, samples: championSamples },
    challenger: { id: "v2", scope, samples: challengerSamples }
  });
  assert.equal(result.status, "promote");
  assert.equal(result.promotable, true);
  assert.ok(result.gates.every((item) => item.passed));
  assert.match(result.reportZh, /建议晋升 Challenger/);
  assert.match(result.reportZh, /强制术语正确率/);
  assert.match(result.reportZh, /人工编辑距离/);
});

test("强制术语回退是一票否决，即使 QA、人工、成本和延迟都变好", () => {
  const championSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
    requiredTermHits: 2,
    qaScore: 90,
    humanEditDistance: 0.1,
    humanAccepted: index < 3,
    cost: 0.02,
    latencyMs: 1000
  }));
  const challengerSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
    requiredTermHits: index === 0 ? 1 : 2,
    qaScore: 99,
    humanEditDistance: 0.01,
    humanAccepted: true,
    cost: 0.005,
    latencyMs: 200
  }));
  const result = evaluateSkillPromotion({
    scope,
    minSamples: 5,
    champion: { scope, samples: championSamples },
    challenger: { scope, samples: challengerSamples }
  });
  assert.equal(result.status, "reject");
  assert.equal(result.promotable, false);
  assert.equal(result.gates.find((item) => item.id === "mandatory_terms").status, "failed");
  assert.match(result.reportZh, /强制术语不得回退/);
});

test("硬错误增加是一票否决，成本和延迟超限也分别阻止晋升", () => {
  const championSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
    qaScore: 90,
    humanEditDistance: 0.1,
    humanAccepted: false,
    cost: 0.01,
    latencyMs: 100
  }));
  const challengerSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
    hardErrorCount: index === 0 ? 1 : 0,
    qaScore: 95,
    humanEditDistance: 0.05,
    humanAccepted: true,
    cost: 0.02,
    latencyMs: 200
  }));
  const result = evaluateSkillPromotion({
    scope,
    minSamples: 5,
    champion: { scope, samples: championSamples },
    challenger: { scope, samples: challengerSamples }
  });
  assert.equal(result.status, "reject");
  assert.equal(result.gates.find((item) => item.id === "hard_errors").status, "failed");
  assert.equal(result.gates.find((item) => item.id === "cost").status, "failed");
  assert.equal(result.gates.find((item) => item.id === "latency").status, "failed");
});

test("成本未知时默认保持严格不足，但 requireCost=false 可跳过成本覆盖和门禁", () => {
  const championSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
    qaScore: 90,
    humanEditDistance: 0.1,
    humanAccepted: index < 3,
    cost: undefined,
    latencyMs: 500
  }));
  const challengerSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
    qaScore: 95,
    humanEditDistance: 0.05,
    humanAccepted: index < 4,
    cost: undefined,
    latencyMs: 500
  }));
  const input = {
    scope,
    minSamples: 5,
    champion: { scope, samples: championSamples },
    challenger: { scope, samples: challengerSamples }
  };

  const strict = evaluateSkillPromotion(input);
  assert.equal(strict.status, "insufficient");
  assert.ok(strict.insufficientReasons.some((reason) => reason.includes("成本")));

  const relaxed = evaluateSkillPromotion({ ...input, guardrails: { requireCost: false } });
  assert.equal(relaxed.status, "promote");
  assert.equal(relaxed.promotable, true);
  assert.equal(relaxed.championMetrics.cost.average, null);
  assert.equal(relaxed.challengerMetrics.cost.average, null);
  assert.equal(relaxed.gates.some((item) => item.id === "cost"), false);
  assert.equal(relaxed.insufficientReasons.some((reason) => reason.includes("成本")), false);
});

test("评测集不一致或关键指标覆盖不足时不作晋升判断", () => {
  const championSamples = Array.from({ length: 5 }, (_, index) => sample(index));
  const challengerSamples = Array.from({ length: 5 }, (_, index) => ({
    caseId: `other-${index}`,
    scope,
    requiredTermHits: 2,
    requiredTermTotal: 2,
    hardErrorCount: 0,
    qaScore: 99
  }));
  const result = evaluateSkillPromotion({
    scope,
    minSamples: 5,
    champion: { scope, samples: championSamples },
    challenger: { scope, samples: challengerSamples }
  });
  assert.equal(result.status, "insufficient");
  assert.ok(result.insufficientReasons.some((reason) => reason.includes("同一组评测样本")));
  assert.ok(result.insufficientReasons.some((reason) => reason.includes("人工编辑距离")));
  assert.ok(result.insufficientReasons.some((reason) => reason.includes("成本")));
});

test("晋升评测拒绝跨项目或跨语种混用", () => {
  assert.throws(() => evaluateSkillPromotion({
    scope,
    minSamples: 1,
    champion: { scope, samples: [sample(1)] },
    challenger: { scope: { ...scope, locale: "ko-KR" }, samples: [sample(1)] }
  }), /Challenger 作用域不一致/);
});
