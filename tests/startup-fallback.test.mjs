import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 模拟 Directus 不可用：KAMI_STORE=directus 但地址指向一个没有服务的端口。
const dataDir = await mkdtemp(join(tmpdir(), "kami-store-required-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
process.env.KAMI_STORE = "directus";
process.env.DIRECTUS_URL = "http://127.0.0.1:59999";
process.env.DIRECTUS_TOKEN = "unused-token";

const store = await import("../src/store.mjs");

test("Directus 不可用时直接启动失败，绝不静默回退到 JSON", async () => {
  // 回退曾经让 1966 条风格证据、600+ 条记忆与 7 份风格规范一起消失，
  // 模型在零参考下继续翻译，同时新写入落到 data/ 形成数据分叉。
  // 宁可起不来，也不要带着残缺资产跑。
  await assert.rejects(() => store.initializeStore(), /Directus 资产后台不可用/);
});

test("启动失败信息给出可操作的排查顺序", async () => {
  const error = await store.initializeStore().catch((reason) => reason);
  assert.ok(error instanceof Error);
  for (const hint of ["Docker Desktop", "directus:up", "directus:provision", "DIRECTUS_URL"]) {
    assert.ok(error.message.includes(hint), `启动失败提示缺少「${hint}」`);
  }
  assert.match(error.message, /不再回退到本地 JSON/);
});

test("存储模式始终如实反映请求的后端，不存在降级态", () => {
  assert.equal(store.getStoreMetadata().type, "directus", "请求 directus 就必须报告 directus");
  assert.equal(typeof store.getStoreFallbackInfo, "undefined", "回退查询接口应随回退能力一并移除");
});
