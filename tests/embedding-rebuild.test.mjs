import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kami-rebuild-"));
process.env.KAMI_DATA_DIR = dataDir;
process.env.LLM_BASE_URL = "http://127.0.0.1:11435/v1";
process.env.LLM_EMBEDDING_MODEL = "mock-embed";

const { initializeStore, saveMemory, rebuildEmbeddings } = await import("../src/store.mjs");
const { updateProviderConfig } = await import("../src/provider.mjs");
updateProviderConfig({ embeddingModel: "mock-embed", embeddingBaseUrl: "http://127.0.0.1:11435/v1", persist: false });
await initializeStore();
await import("./fixtures/mock-openai-server.mjs");
await new Promise((resolve) => setTimeout(resolve, 400));

await test("写入路径自动附加 embedding，模型不可用时静默降级", async () => {
  const memory = await saveMemory("ja-JP", { source: "重建索引测试句一", target: "テスト一", domain: "game", contentType: "general", qualityStatus: "human_approved", qaScore: 100, provenance: "test" });
  assert.ok(Array.isArray(memory.embedding?.vector));
  assert.equal(memory.embedding.model, "mock-embed");
});

await test("rebuildEmbeddings 为缺失向量的旧记录补索引且跳过已有向量", async () => {
  const path = join(dataDir, "memories", "ja-JP.json");
  const items = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(items.length, 1);
  const stripped = items.map(({ embedding, ...rest }) => rest);
  writeFileSync(path, JSON.stringify(stripped, null, 2));

  const stats = await rebuildEmbeddings("ja-JP");
  assert.equal(stats.memories, 1);

  const rebuilt = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Array.isArray(rebuilt[0].embedding?.vector));

  const again = await rebuildEmbeddings("ja-JP");
  assert.equal(again.memories, 0, "已有同模型向量时不再重复重建");
});

await test("未配置外部 embedding 模型时使用本地 CJK 索引重建", async () => {
  delete process.env.LLM_EMBEDDING_MODEL;
  updateProviderConfig({ embeddingModel: "", persist: false });
  const stats = await rebuildEmbeddings("ja-JP");
  assert.equal(stats.memories, 1);
  const rebuilt = JSON.parse(readFileSync(join(dataDir, "memories", "ja-JP.json"), "utf8"));
  assert.equal(rebuilt[0].embedding.model, "local-cjk-char-ngram-v1");
  assert.equal(rebuilt[0].embedding.dimensions, 512);
  process.env.LLM_EMBEDDING_MODEL = "mock-embed";
  updateProviderConfig({ embeddingModel: "mock-embed", persist: false });
});
