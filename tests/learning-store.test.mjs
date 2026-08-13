import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KAMI_DATA_DIR = mkdtempSync(join(tmpdir(), "kami-learning-store-"));
delete process.env.KAMI_STORE;
delete process.env.EMBEDDING_MODEL;

const {
  activateTranslationSkill,
  getLearningTrajectory,
  getSkillEvaluation,
  getTranslationSkill,
  initializeStore,
  listLearningTrajectories,
  listSkillEvaluations,
  listTranslationSkills,
  rollbackTranslationSkill,
  saveLearningTrajectory,
  saveSkillEvaluation,
  saveTranslationSkill,
  updateLearningTrajectory,
  updateSkillEvaluation,
  updateTranslationSkill
} = await import("../src/store.mjs");

await initializeStore();

test("JSON learning trajectories preserve the complete translation decision trail", async () => {
  const created = await saveLearningTrajectory({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    project: "wukong",
    batchId: "batch-1",
    segmentId: "segment-7",
    source: "去水帘洞看看。",
    initialTranslation: "水簾洞へ行ってみよう。",
    finalTranslation: "水簾洞を見に行こう。",
    contextPack: { styleSkillId: "skill-1", contextBefore: ["前文"] },
    assetRefs: [{ kind: "term", id: "term-1" }],
    termDecisions: [{ source: "水帘洞", target: "水簾洞", decision: "required" }],
    qaBefore: { score: 86, issues: ["register"] },
    qaAfter: { score: 96, issues: [] },
    humanDecision: { action: "approved" },
    events: [{ type: "translated" }, { type: "qa_revised" }],
    model: "test-model",
    promptVersion: "translation-v3",
    status: "completed"
  });

  assert.ok(created.id);
  assert.equal(created.project, "wukong");
  assert.equal(created.qaAfter.score, 96);
  assert.deepEqual(created.assetRefs, [{ kind: "term", id: "term-1" }]);

  const updated = await updateLearningTrajectory(created.id, {
    status: "review",
    humanDecision: { action: "requested_revision", reason: "角色口吻" }
  });
  assert.equal(updated.source, created.source);
  assert.equal(updated.status, "review");
  assert.equal(updated.humanDecision.reason, "角色口吻");
  assert.equal((await getLearningTrajectory(created.id))?.promptVersion, "translation-v3");
  assert.equal((await listLearningTrajectories({ locale: "ja-JP", project: "wukong", batchId: "batch-1", status: "review" }))[0]?.id, created.id);
  assert.equal((await listLearningTrajectories({ locale: "ko-KR" })).length, 0);
});

test("JSON translation skills are versioned per isolated scope and support activate plus rollback", async () => {
  const championV1 = await saveTranslationSkill({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    project: "wukong",
    name: "悟空对白技能",
    description: "保持角色口吻与短句节奏",
    changeReason: "初始基准",
    status: "champion",
    strategy: { segmentation: "sentence", contextWindow: 2, qaThreshold: 90 },
    evidenceIds: ["trajectory-1"],
    promptVersion: "translation-v3",
    metrics: { qaPassRate: 0.91 }
  });
  const challengerV2 = await saveTranslationSkill({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    project: "wukong",
    name: "悟空对白技能",
    description: "加强人物差异和敬体约束",
    changeReason: "连续出现角色口吻修订",
    status: "challenger",
    strategy: { segmentation: "sentence", contextWindow: 3, qaThreshold: 90 },
    evidenceIds: ["trajectory-1", "trajectory-2"],
    promptVersion: "translation-v4",
    metrics: { qaPassRate: 0.95 }
  });
  const koreanChampion = await saveTranslationSkill({
    locale: "ko-KR",
    contentType: "dialogue",
    domain: "game",
    project: "wukong",
    name: "한국어 대화 스킬",
    status: "champion",
    strategy: { contextWindow: 2 }
  });

  assert.equal(championV1.version, 1);
  assert.equal(challengerV2.version, 2);
  assert.equal(challengerV2.parentId, championV1.id);
  assert.equal(challengerV2.description, "加强人物差异和敬体约束");
  assert.equal(challengerV2.changeReason, "连续出现角色口吻修订");
  assert.deepEqual(challengerV2.evidenceIds, ["trajectory-1", "trajectory-2"]);

  const activated = await activateTranslationSkill(challengerV2.id);
  assert.equal(activated.status, "champion");
  assert.equal((await getTranslationSkill(championV1.id))?.status, "inactive");
  assert.equal((await getTranslationSkill(koreanChampion.id))?.status, "champion", "activating Japanese must not demote Korean");

  const edited = await updateTranslationSkill(challengerV2.id, { metrics: { qaPassRate: 0.96, humanEditRate: 0.04 } });
  assert.equal(edited.metrics.humanEditRate, 0.04);
  const rolledBack = await rollbackTranslationSkill(challengerV2.id);
  assert.equal(rolledBack.rolledBack.status, "inactive");
  assert.equal(rolledBack.champion.id, championV1.id);
  assert.equal(rolledBack.champion.status, "champion");

  const japanese = await listTranslationSkills({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "wukong" });
  assert.deepEqual(japanese.map((item) => item.version), [2, 1]);
  assert.equal(japanese.filter((item) => item.status === "champion").length, 1);
});

test("JSON skill evaluations preserve champion/challenger metrics, decision and report", async () => {
  const skills = await listTranslationSkills({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "wukong" });
  const champion = skills.find((item) => item.status === "champion");
  const challenger = await saveTranslationSkill({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    project: "wukong",
    name: "悟空对白技能",
    description: "针对新一轮人工证据的候选",
    changeReason: "为评测保留仍有效的 challenger",
    status: "challenger",
    strategy: { segmentation: "sentence", contextWindow: 4, qaThreshold: 90 },
    evidenceIds: ["trajectory-3"],
    promptVersion: "translation-v5",
    metrics: {}
  });
  const evaluation = await saveSkillEvaluation({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    project: "wukong",
    championSkillId: champion.id,
    challengerSkillId: challenger.id,
    sampleCount: 40,
    championMetrics: { qaPassRate: 0.91, humanEditRate: 0.09 },
    challengerMetrics: { qaPassRate: 0.95, humanEditRate: 0.05 },
    metricDeltas: { qaPassRate: 0.04, humanEditRate: -0.04 },
    decision: "needs_review",
    report: { summary: "质量提高，但仍需人工复核角色口吻。", regressions: [] },
    evaluator: "holdout-v1"
  });

  assert.ok(evaluation.id);
  assert.equal(evaluation.sampleCount, 40);
  assert.equal(evaluation.report.summary, "质量提高，但仍需人工复核角色口吻。");
  const updated = await updateSkillEvaluation(evaluation.id, { decision: "promote", report: { summary: "人工复核通过。" } });
  assert.equal(updated.decision, "promote");
  assert.equal(updated.championMetrics.qaPassRate, 0.91);
  assert.equal((await getSkillEvaluation(evaluation.id))?.challengerSkillId, challenger.id);
  assert.equal((await listSkillEvaluations({ locale: "ja-JP", project: "wukong", decision: "promote" }))[0]?.id, evaluation.id);
});

test("JSON concurrent learning writes do not lose records and stale candidates cannot replace the champion", async () => {
  const trajectories = await Promise.all(Array.from({ length: 25 }, (_, index) => saveLearningTrajectory({
    locale: "th-TH", contentType: "ui", domain: "game", project: "concurrency",
    batchId: "parallel", segmentId: String(index), source: `源文-${index}`, status: "completed"
  })));
  assert.equal(new Set(trajectories.map((item) => item.id)).size, 25);
  assert.equal((await listLearningTrajectories({ locale: "th-TH", contentType: "ui", domain: "game", project: "concurrency", batchId: "parallel", limit: 100 })).length, 25);

  const baseline = await saveTranslationSkill({ locale: "th-TH", contentType: "ui", domain: "game", project: "stale", name: "baseline", status: "champion", strategy: {} });
  const stale = await saveTranslationSkill({ locale: "th-TH", contentType: "ui", domain: "game", project: "stale", name: "stale", status: "challenger", parentId: baseline.id, strategy: {} });
  const current = await saveTranslationSkill({ locale: "th-TH", contentType: "ui", domain: "game", project: "stale", name: "current", status: "challenger", parentId: baseline.id, strategy: {} });
  await activateTranslationSkill(current.id);
  await assert.rejects(() => activateTranslationSkill(stale.id), /current champion/);
  assert.equal((await getTranslationSkill(current.id))?.status, "champion");
  await assert.rejects(() => updateTranslationSkill(current.id, { status: "rejected" }), /must be replaced or rolled back/);
});
