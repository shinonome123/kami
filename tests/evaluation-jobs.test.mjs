import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在加载任何 src 模块前设置运行环境：mock 模型服务、隔离的 JSON 存储与空配置目录。
const dataDir = await mkdtemp(join(tmpdir(), "kami-eval-jobs-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
delete process.env.KAMI_STORE;
process.env.MOCK_OPENAI_PORT = "11437";
process.env.LLM_BASE_URL = "http://127.0.0.1:11437/v1";
process.env.LLM_MODEL = "mock-model";
process.env.LLM_INPUT_PRICE_PER_MTOK = "0.5";
process.env.LLM_OUTPUT_PRICE_PER_MTOK = "1.5";

await import("./fixtures/mock-openai-server.mjs");
const store = await import("../src/store.mjs");
const engine = await import("../src/learning-engine.mjs");
const benchmarkModule = await import("../src/skill-benchmark.mjs");
const jobsModule = await import("../src/evaluation-jobs.mjs");

const savedEvaluations = [];

function makeDeps(overrides = {}) {
  return {
    getSkill: (id) => store.getTranslationSkill(id),
    getCurrentChampion: async (scope) => (await store.listTranslationSkills({ ...scope, status: "champion", limit: 1 }))[0] || null,
    validatePromotionState: (input) => engine.validateCandidatePromotionState(input),
    saveEvaluation: async (payload) => {
      savedEvaluations.push(payload);
      return store.saveSkillEvaluation(payload);
    },
    updateSkillMetrics: (id, metrics) => store.updateTranslationSkill(id, { metrics }),
    buildUiReport: (result) => ({ promotable: result.promotable, status: result.status, conclusion: result.reportZh, gates: result.gates }),
    ...overrides
  };
}

async function waitForTerminal(runner, jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = runner.get(jobId);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return runner.get(jobId);
}

test("后台评测任务完成全流程：双变体重跑、成本采集、保存评测记录", async () => {
  await store.initializeStore();
  const scope = { locale: "ja-JP", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template });
  const challengerTemplate = engine.mergeTranslationSkillPatch(
    template,
    { name: "候选技能", changeReason: "测试候选", strategy: { retrieval: { translationMemory: { limit: 8 } } } },
    { candidateId: `${champion.id}@candidate-v2` }
  );
  const challenger = await store.saveTranslationSkill({ ...scope, ...challengerTemplate });

  const trajectories = [];
  for (let index = 0; index < 20; index += 1) {
    const created = await store.saveLearningTrajectory({
      ...scope,
      batchId: "manual-review",
      segmentId: "",
      source: `登录后即可领取每日奖励第${index}号说明文案`,
      contextPack: { neighborContext: "" },
      assetRefs: {},
      model: "mock-model",
      promptVersion: "kami-translation-v1",
      status: "running",
      events: []
    });
    const finalTranslation = `デイリー報酬第${index}号`;
    trajectories.push(await store.updateLearningTrajectory(created.id, {
      finalTranslation,
      humanDecision: { accepted: true, finalTranslation },
      status: "completed"
    }));
  }

  const jobsDirectory = join(dataDir, "learning", "jobs");
  const runner = jobsModule.createEvaluationJobRunner({
    benchmark: benchmarkModule.benchmarkTranslationSkill,
    jobsDirectory,
    concurrency: 3,
    deps: makeDeps()
  });
  await runner.initialize();

  const createdJob = await runner.create({ scope, champion, challenger, trajectories, requireCost: true });
  assert.ok(["queued", "running"].includes(createdJob.status), "创建后任务应立即进入排队或运行状态");
  const finalJob = await waitForTerminal(runner, createdJob.jobId);
  assert.equal(finalJob.status, "completed", finalJob.error || "任务未完成");
  assert.deepEqual(finalJob.progress, { requested: 20, completed: 20, failed: 0 });

  const report = finalJob.result.report;
  assert.equal(report.benchmark.completedPairs, 20);
  assert.equal(report.benchmark.failedPairs, 0);
  assert.equal(report.benchmark.isolation.totalExcluded, 0, "空记忆库不应有同源剔除");

  // mock 服务每次返回 42 输入 / 7 输出 token，每 case 翻译 + AIQA 各一次，定价 0.5 / 1.5 每百万。
  const expectedPerCase = 2 * ((42 / 1_000_000) * 0.5 + (7 / 1_000_000) * 1.5);
  assert.ok(savedEvaluations.length === 1, "应保存一条评测记录");
  assert.ok(savedEvaluations[0].championMetrics.cost.average > 0);
  assert.ok(Math.abs(savedEvaluations[0].championMetrics.cost.average - expectedPerCase) < 1e-9);
  assert.ok(savedEvaluations[0].challengerMetrics.cost.average > 0);

  const evaluations = await store.listSkillEvaluations({ challengerSkillId: challenger.id, limit: 1 });
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].sampleCount, 20);
  assert.equal(evaluations[0].decision, savedEvaluations[0].decision);

  const persistedFiles = (await readdir(jobsDirectory)).filter((file) => file.endsWith(".json"));
  assert.equal(persistedFiles.length, 1, "任务检查点应持久化到磁盘");
});

test("重启恢复把运行中任务标记为 interrupted，续跑前校验候选与冠军配对", async () => {
  const scope = { locale: "ko-KR", contentType: "general", domain: "game", project: "default" };
  const jobsDirectory = join(dataDir, "learning", "jobs-restore");
  const fakeJob = {
    jobId: "fake-1",
    kind: "skill-evaluation",
    scope,
    championId: "champion-x",
    challengerId: "challenger-x",
    requireCost: false,
    requestedCaseIds: ["case-1", "case-2"],
    caseTrajectories: {},
    caseSamples: {},
    caseFailures: {},
    status: "running",
    result: null,
    error: "",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: ""
  };
  await mkdir(jobsDirectory, { recursive: true });
  await writeFile(join(jobsDirectory, "fake-1.json"), JSON.stringify(fakeJob));
  const runner = jobsModule.createEvaluationJobRunner({
    benchmark: async () => ({ caseId: "unused" }),
    jobsDirectory,
    concurrency: 1,
    deps: makeDeps()
  });
  await runner.initialize();
  assert.equal(runner.get("fake-1").status, "interrupted");
  const resumed = await runner.resume("fake-1");
  assert.ok(["queued", "running"].includes(resumed.status), "续跑后任务应进入排队或运行状态");
  const finalJob = await waitForTerminal(runner, "fake-1");
  assert.equal(finalJob.status, "failed");
  assert.match(finalJob.error, /候选技能不存在|Champion/);
});
