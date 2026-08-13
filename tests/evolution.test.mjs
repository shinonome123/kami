import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kami-evolution-"));
process.env.KAMI_DATA_DIR = dataDir;
process.env.LLM_BASE_URL = "http://127.0.0.1:11436/v1";
process.env.LLM_MODEL = "mock-chat";
process.env.MOCK_OPENAI_PORT = "11436";

const { initializeStore, saveStyleEvidence, getStyleProfile } = await import("../src/store.mjs");
const { distillStyleProfileIfReady, runEvolutionReview, DISTILL_THRESHOLD } = await import("../src/evolution.mjs");
await initializeStore();
await import("./fixtures/mock-openai-server.mjs");
await new Promise((resolve) => setTimeout(resolve, 400));

async function seedEvidence(locale, contentType, domain, count, provenance = "table-import") {
  for (let index = 0; index < count; index += 1) {
    await saveStyleEvidence({ locale, source: `${provenance}证据句${index + 1}`, target: `ターゲット${index + 1}`, contentType, domain, status: "accepted", provenance });
  }
}

test("风格证据未达阈值时不蒸馏，跨批次累计后触发 draft 蒸馏", async () => {
  const scope = { locale: "ja-JP", contentType: "marketing", domain: "game" };
  await seedEvidence("ja-JP", "marketing", "game", DISTILL_THRESHOLD - 2);
  const below = await distillStyleProfileIfReady(scope);
  assert.equal(below.distilled, null);
  assert.equal(below.evidenceCount, DISTILL_THRESHOLD - 2);
  assert.equal(await getStyleProfile("ja-JP", "marketing", "game"), null);

  await seedEvidence("ja-JP", "marketing", "game", 2, "human-accept");
  const ready = await distillStyleProfileIfReady(scope);
  assert.ok(ready.distilled?.id);
  assert.equal(ready.distilled.status, "draft");
  assert.ok(ready.distilled.instruction.length > 0);

  const active = await getStyleProfile("ja-JP", "marketing", "game");
  assert.equal(active, null, "draft 不自动激活，翻译仍用不到新规范");
});

test("复盘在模型不可用时记录 fallback 且不抛错", async () => {
  const result = await runEvolutionReview({ locale: "ja-JP", contentType: "marketing", domain: "game", batchId: "test-batch" });
  assert.ok(result.fallbackReasons.review, "复盘模型输出非 JSON 时记入 fallbackReasons");
  assert.equal(typeof result.evidenceCount, "number");
  assert.ok(result.evidenceCount >= DISTILL_THRESHOLD);
});

test("未达画像阈值时 profilePending 返回计数", async () => {
  const result = await runEvolutionReview({ locale: "ko-KR", contentType: "general", domain: "general" });
  assert.equal(result.profile, null);
  assert.ok(result.profilePending);
  assert.equal(result.profilePending.acceptedCount, 0);
});
