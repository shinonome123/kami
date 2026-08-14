import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境必须在加载任何 src 模块前就绪：mock 模型服务 + 隔离 JSON 存储 + 空配置目录。
const dataDir = await mkdtemp(join(tmpdir(), "kami-proposal-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
delete process.env.KAMI_STORE;
process.env.MOCK_OPENAI_PORT = "11438";
process.env.LLM_BASE_URL = "http://127.0.0.1:11438/v1";
process.env.LLM_MODEL = "mock-model";

await import("./fixtures/mock-openai-server.mjs");
const store = await import("../src/store.mjs");
const engine = await import("../src/learning-engine.mjs");
const proposal = await import("../src/skill-proposal.mjs");

test("selectProposalTrajectories 只保留带终稿的完成/复核轨迹并截断", () => {
  const trajectories = [
    { id: "a", status: "completed", finalTranslation: "有" },
    { id: "b", status: "review", finalTranslation: "有" },
    { id: "c", status: "running", finalTranslation: "有" },
    { id: "d", status: "completed", finalTranslation: "" },
    { id: "e", status: "failed", finalTranslation: "有" }
  ];
  assert.deepEqual(proposal.selectProposalTrajectories(trajectories).map((item) => item.id), ["a", "b"]);
  assert.equal(proposal.selectProposalTrajectories(Array.from({ length: 50 }, (_, index) => ({ id: `t${index}`, status: "completed", finalTranslation: "x" }))).length, 40);
});

test("proposeChallengerSkill 走完模型提议、补丁合并与隔离保存的完整闭环", async () => {
  await store.initializeStore();
  const scope = { locale: "ja-JP", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template, metadata: { seed: 1 } });
  for (let index = 0; index < 5; index += 1) {
    const created = await store.saveLearningTrajectory({
      ...scope, batchId: "manual-review", segmentId: "", source: `自动提议测试句${index}` ,
      contextPack: {}, assetRefs: {}, model: "mock-model", promptVersion: "kami-translation-v1", status: "running", events: []
    });
    await store.updateLearningTrajectory(created.id, { finalTranslation: `訳${index}`, status: "completed" });
  }
  const trajectories = await store.listLearningTrajectories({ ...scope, limit: 100 });
  const challenger = await proposal.proposeChallengerSkill({ scope, champion, trajectories, promptVersion: "kami-translation-v1" });

  assert.equal(challenger.status, "challenger");
  assert.equal(challenger.parentId, champion.id);
  assert.equal(challenger.version, 2);
  assert.equal(challenger.strategy.retrieval.translationMemory.limit, 8, "模型补丁应合并进候选策略");
  assert.deepEqual(challenger.strategy.prompting.additionalRules, ["输出前逐项核对强制术语"]);
  assert.deepEqual(challenger.evidenceIds.sort(), trajectories.filter((item) => item.status === "completed" && item.finalTranslation).map((item) => item.id).sort());
  assert.equal(challenger.metadata.seed, 1, "冠军 metadata 应保留并合并");
  assert.equal(challenger.metadata.generatedBy, "mock-model");
});

test("没有可用轨迹时抛出与手动入口一致的 409", async () => {
  const scope = { locale: "ko-KR", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template, id: "champion-empty-trajectory" });
  await assert.rejects(() => proposal.proposeChallengerSkill({ scope, champion, trajectories: [] }), (error) => error.statusCode === 409 && /没有可复盘的完成轨迹/.test(error.message));
});
