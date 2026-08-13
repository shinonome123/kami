import test from "node:test";
import assert from "node:assert/strict";

import {
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
  updateSkillEvaluation
} from "../src/store.mjs";

const enabled = process.env.KAMI_STORE === "directus";

test("Directus implements the same trajectory, versioned skill and evaluation contract", { skip: !enabled }, async () => {
  await initializeStore();
  const project = `learning-integration-${Date.now()}`;
  const created = [];
  const trajectory = await saveLearningTrajectory({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "integration",
    project,
    batchId: "batch-directus",
    segmentId: "segment-1",
    source: "水帘洞へ行く。",
    initialTranslation: "水簾洞へ行く。",
    finalTranslation: "水簾洞を見に行こう。",
    contextPack: { contextWindow: 2 },
    assetRefs: [{ kind: "term", id: "term-directus" }],
    termDecisions: [{ source: "水帘洞", target: "水簾洞" }],
    qaBefore: { score: 82 },
    qaAfter: { score: 95 },
    humanDecision: { action: "approved" },
    events: [{ type: "qa_revised" }],
    model: "integration-model",
    promptVersion: "translation-v3",
    status: "completed"
  });
  created.push(["learning_trajectories", trajectory.id]);

  const championV1 = await saveTranslationSkill({
    locale: "ja-JP", contentType: "dialogue", domain: "integration", project,
    name: "Directus dialogue skill", description: "baseline", changeReason: "initial",
    status: "champion", strategy: { contextWindow: 2 }, evidenceIds: [trajectory.id],
    promptVersion: "translation-v3", metrics: { qaPassRate: 0.9 }
  });
  created.push(["translation_skills", championV1.id]);
  const challengerV2 = await saveTranslationSkill({
    locale: "ja-JP", contentType: "dialogue", domain: "integration", project,
    name: "Directus dialogue skill", description: "candidate", changeReason: "repeated QA correction",
    status: "challenger", strategy: { contextWindow: 3 }, evidenceIds: [trajectory.id],
    promptVersion: "translation-v4", metrics: { qaPassRate: 0.96 }
  });
  created.push(["translation_skills", challengerV2.id]);
  const koreanChampion = await saveTranslationSkill({
    locale: "ko-KR", contentType: "dialogue", domain: "integration", project,
    name: "Korean isolated skill", status: "champion", strategy: { contextWindow: 1 }
  });
  created.push(["translation_skills", koreanChampion.id]);

  const evaluation = await saveSkillEvaluation({
    locale: "ja-JP", contentType: "dialogue", domain: "integration", project,
    championSkillId: championV1.id, challengerSkillId: challengerV2.id, sampleCount: 20,
    championMetrics: { qaPassRate: 0.9 }, challengerMetrics: { qaPassRate: 0.96 },
    metricDeltas: { qaPassRate: 0.06 }, decision: "needs_review",
    report: { summary: "candidate improved" }, evaluator: "integration"
  });
  created.push(["skill_evaluations", evaluation.id]);

  try {
    assert.equal((await getLearningTrajectory(trajectory.id))?.qaAfter.score, 95);
    assert.equal((await updateLearningTrajectory(trajectory.id, { status: "review" }))?.source, trajectory.source);
    assert.equal((await listLearningTrajectories({ locale: "ja-JP", project, status: "review" }))[0]?.id, trajectory.id);

    assert.equal(championV1.version, 1);
    assert.equal(challengerV2.version, 2);
    assert.equal(challengerV2.parentId, championV1.id);
    assert.equal(challengerV2.description, "candidate");
    assert.equal(challengerV2.changeReason, "repeated QA correction");
    assert.deepEqual(challengerV2.evidenceIds, [trajectory.id]);
    assert.equal((await getSkillEvaluation(evaluation.id))?.report.summary, "candidate improved");
    assert.equal((await updateSkillEvaluation(evaluation.id, { decision: "promote" }))?.championMetrics.qaPassRate, 0.9);
    assert.equal((await listSkillEvaluations({ locale: "ja-JP", project, decision: "promote" }))[0]?.id, evaluation.id);
    await activateTranslationSkill(challengerV2.id);
    assert.equal((await getTranslationSkill(championV1.id))?.status, "inactive");
    assert.equal((await getTranslationSkill(challengerV2.id))?.status, "champion");
    assert.equal((await getTranslationSkill(koreanChampion.id))?.status, "champion");
    const rolledBack = await rollbackTranslationSkill(challengerV2.id);
    assert.equal(rolledBack.champion.id, championV1.id);
    assert.equal(rolledBack.rolledBack.status, "inactive");
    assert.equal((await listTranslationSkills({ locale: "ja-JP", contentType: "dialogue", domain: "integration", project })).filter((item) => item.status === "champion").length, 1);
  } finally {
    const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    for (const [collection, id] of created.reverse()) {
      await fetch(`${base}/items/${collection}/${id}`, { method: "DELETE", headers });
    }
  }
});

test("Directus unique scope keys prevent duplicate versions and concurrent champions", { skip: !enabled }, async () => {
  await initializeStore();
  const project = `learning-race-${Date.now()}`;
  const scope = { locale: "th-TH", contentType: "ui", domain: "integration", project };
  const created = [];
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    const champion = await saveTranslationSkill({ ...scope, name: "race baseline", status: "champion", strategy: {} });
    created.push(champion.id);
    const first = await saveTranslationSkill({ ...scope, name: "race first", status: "challenger", parentId: champion.id, strategy: {} });
    created.push(first.id);
    const second = await saveTranslationSkill({ ...scope, name: "race second", status: "challenger", parentId: champion.id, strategy: {} });
    created.push(second.id);

    const activations = await Promise.allSettled([activateTranslationSkill(first.id), activateTranslationSkill(second.id)]);
    assert.equal(activations.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(activations.filter((item) => item.status === "rejected").length, 1);
    const skills = await listTranslationSkills({ ...scope, limit: 20 });
    assert.equal(skills.filter((item) => item.status === "champion").length, 1);

    const versionRaceProject = `${project}-version`;
    const writes = await Promise.allSettled([
      saveTranslationSkill({ ...scope, project: versionRaceProject, name: "version a", version: 1, status: "draft", strategy: {} }),
      saveTranslationSkill({ ...scope, project: versionRaceProject, name: "version b", version: 1, status: "draft", strategy: {} })
    ]);
    assert.equal(writes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(writes.filter((item) => item.status === "rejected").length, 1);
    for (const result of writes) if (result.status === "fulfilled") created.push(result.value.id);
    assert.equal((await listTranslationSkills({ ...scope, project: versionRaceProject, limit: 20 })).length, 1);
  } finally {
    for (const id of created.reverse()) await fetch(`${base}/items/translation_skills/${id}`, { method: "DELETE", headers });
  }
});
