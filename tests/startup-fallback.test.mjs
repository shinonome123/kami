import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 模拟 Directus 不可用：KAMI_STORE=directus 但地址指向一个没有服务的端口。
const dataDir = await mkdtemp(join(tmpdir(), "kami-fallback-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
process.env.KAMI_STORE = "directus";
process.env.DIRECTUS_URL = "http://127.0.0.1:59999";
process.env.DIRECTUS_TOKEN = "unused-token";

const store = await import("../src/store.mjs");

test("Directus 不可用时启动自动回退 JSON 存储而不崩溃", async () => {
  await store.initializeStore(); // 不应抛出
  const info = store.getStoreFallbackInfo();
  assert.equal(info.active, true);
  assert.equal(info.requestedMode, "directus");
  assert.equal(info.activeMode, "json");
  assert.ok(String(info.reason || "").length > 0, "回退必须携带原因");
  assert.ok(info.at);
  assert.equal(store.getStoreMetadata().type, "json");
});

test("回退后读写走 JSON 存储且四语资产可读可写", async () => {
  const assets = await store.getAssets("ja-JP");
  assert.ok(Array.isArray(assets.terms));
  const saved = await store.saveAsset("ja-JP", {
    source: "回退测试术语", target: "フォールバック", enforcement: "required", contentTypes: ["general"], domains: ["game"], note: ""
  });
  assert.equal(saved.source, "回退测试术语");
  const reloaded = await store.getAssets("ja-JP");
  assert.ok(reloaded.terms.some((item) => item.source === "回退测试术语"));
});
