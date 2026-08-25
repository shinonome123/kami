import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 运行环境必须在加载 src 模块之前就位：mock 模型服务 + 隔离 JSON 存储 + 空配置目录。
const dataDir = await mkdtemp(join(tmpdir(), "kami-style-bench-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-style-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
delete process.env.KAMI_STORE;
process.env.MOCK_OPENAI_PORT = "11439";
process.env.LLM_BASE_URL = "http://127.0.0.1:11439/v1";
process.env.LLM_MODEL = "mock-model";

await import("./fixtures/mock-openai-server.mjs");
const store = await import("../src/store.mjs");
const { benchmarkStyleVariant, styleVariant } = await import("../src/style-benchmark.mjs");
const { DEFAULT_TRANSLATION_STRATEGY, createDefaultTranslationSkill } = await import("../src/learning-engine.mjs");
await store.initializeStore();

const scope = { locale: "ja-JP", contentType: "marketing", domain: "game", project: "default" };
const skill = createDefaultTranslationSkill({ id: "skill-1", scope, name: "基线技能", strategy: DEFAULT_TRANSLATION_STRATEGY });
const trajectory = {
  id: "case-1",
  source: "高级通行证现已开放购买",
  scope,
  status: "completed",
  finalTranslation: "プレミアムパスの販売を開始しました。",
  humanDecision: { accepted: true, finalTranslation: "プレミアムパスの販売を開始しました。" }
};

test("风格评测里翻译用草稿、AIQA 用当前生效版本，评判标准不随被测对象走", async () => {
  const active = await store.saveStyleProfile({
    ...scope, name: "当前生效风格", instruction: "现行规则", examples: [], evidenceCount: 8, status: "active"
  });
  const draft = await store.saveStyleProfile({
    ...scope, name: "候选风格", instruction: "候选规则", examples: [], evidenceCount: 16, status: "draft"
  });

  const sample = await benchmarkStyleVariant(
    styleVariant({ id: draft.id, scope, skill, profile: draft, qaProfile: active }),
    trajectory
  );
  assert.equal(sample.styleProfileId, draft.id, "译文由候选风格产出");
  assert.equal(sample.qaStyleProfileId, active.id, "但打分仍以当前生效版本为尺子");
  assert.notEqual(sample.styleProfileId, sample.qaStyleProfileId);
  assert.equal(typeof sample.qaScore, "number");
  assert.equal(sample.variantId, draft.id);
});

test("对照组用当前生效风格翻译时，两侧尺子一致", async () => {
  const active = await store.getStyleProfile(scope.locale, scope.contentType, scope.domain);
  const sample = await benchmarkStyleVariant(
    styleVariant({ id: active.id, scope, skill, profile: active, qaProfile: active }),
    trajectory
  );
  assert.equal(sample.styleProfileId, active.id);
  assert.equal(sample.qaStyleProfileId, active.id);
});

test("不传风格覆盖时沿用作用域当前生效版本，技能评测行为不受影响", async () => {
  const { benchmarkTranslationSkill } = await import("../src/skill-benchmark.mjs");
  const active = await store.getStyleProfile(scope.locale, scope.contentType, scope.domain);
  const sample = await benchmarkTranslationSkill(skill, trajectory);
  assert.equal(sample.styleProfileId, active.id);
  assert.equal(sample.qaStyleProfileId, active.id, "未指定裁判风格时两者相同，走原来的单 contextPack 路径");
});

test("空风格覆盖表示语体默认，可作为「尚无风格规范」的基线对照", async () => {
  const active = await store.getStyleProfile(scope.locale, scope.contentType, scope.domain);
  const sample = await benchmarkStyleVariant(
    styleVariant({ id: "content-type-default", scope, skill, profile: null, qaProfile: active }),
    trajectory
  );
  assert.equal(sample.styleProfileId, "content-type-default", "context pack 对空规范给出语体默认 id");
  assert.equal(sample.qaStyleProfileId, active.id);
});

test("评测样本带上留出终稿的编辑距离，作为风格唯一中立收益信号", async () => {
  const active = await store.getStyleProfile(scope.locale, scope.contentType, scope.domain);
  const sample = await benchmarkStyleVariant(
    styleVariant({ id: active.id, scope, skill, profile: active, qaProfile: active }),
    trajectory
  );
  assert.ok(Number.isFinite(sample.humanEditDistance));
  assert.ok(sample.humanEditDistance >= 0 && sample.humanEditDistance <= 1);
  assert.equal(sample.caseId, "case-1");
});
