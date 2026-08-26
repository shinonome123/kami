import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kami-evolution-"));
process.env.KAMI_DATA_DIR = dataDir;
delete process.env.KAMI_STORE; // 建了临时 KAMI_DATA_DIR 就是要隔离：继承 directus 会把测试夹具写进生产库
process.env.LLM_BASE_URL = "http://127.0.0.1:11436/v1";
process.env.LLM_MODEL = "mock-chat";
process.env.MOCK_OPENAI_PORT = "11436";

const { initializeStore, saveStyleEvidence, getStyleProfile, listStyleProfiles, rejectStyleProfile } = await import("../src/store.mjs");
const { distillStyleProfileIfReady, distillUserProfileIfReady, runEvolutionReview, DISTILL_THRESHOLD, DISTILL_GROWTH_WINDOW, PROFILE_THRESHOLD } = await import("../src/evolution.mjs");
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

test("池子过线后不再每条证据都重烧模型：待审草稿先挡，拒绝后仍需满增长窗口", async () => {
  const scope = { locale: "ja-JP", contentType: "dialogue", domain: "game" };
  await seedEvidence("ja-JP", "dialogue", "game", DISTILL_THRESHOLD, "human-accept");
  const first = await distillStyleProfileIfReady(scope);
  assert.ok(first.distilled?.id, "首次达到阈值应当蒸馏");
  assert.equal(first.skipped, "");

  await seedEvidence("ja-JP", "dialogue", "game", 1, "human-accept");
  const blocked = await distillStyleProfileIfReady(scope);
  assert.equal(blocked.distilled, null);
  assert.equal(blocked.skipped, "pending_draft", "上一版草稿还没人审，不再产生第二版");

  await rejectStyleProfile(first.distilled.id);
  const debounced = await distillStyleProfileIfReady(scope);
  assert.equal(debounced.distilled, null);
  assert.equal(debounced.skipped, "growth_window");
  assert.equal(debounced.sinceLastDistill, 1);
  assert.equal(debounced.growthWindow, DISTILL_GROWTH_WINDOW);

  await seedEvidence("ja-JP", "dialogue", "game", DISTILL_GROWTH_WINDOW - 1, "human-accept");
  const second = await distillStyleProfileIfReady(scope);
  assert.ok(second.distilled?.id, "新增满一个增长窗口后重新蒸馏");
  assert.equal(second.distilled.version, first.distilled.version + 1);

  const drafts = await listStyleProfiles("ja-JP", "draft", scope);
  assert.equal(drafts.styleProfiles.length, 1, "同一作用域任何时刻最多只有一个待审草稿");
});

test("复盘的 stylePatch 也要过同一道闸门，不再每个批次都生成草稿", async () => {
  const scope = { locale: "ko-KR", contentType: "marketing", domain: "review-patch" };
  await seedEvidence("ko-KR", "marketing", "review-patch", DISTILL_THRESHOLD, "human-accept");

  const first = await runEvolutionReview({ ...scope, batchId: "batch-1" });
  assert.ok(first.review?.stylePatch, "本作用域的复盘模型确实返回了增量补丁");
  assert.ok(first.distilled?.id, "首次达到阈值时复盘补丁落为草稿");

  const second = await runEvolutionReview({ ...scope, batchId: "batch-2" });
  assert.equal(second.distilled, null, "已有待审草稿时复盘不再落新草稿");
  assert.equal(second.distillPending?.skipped, "pending_draft");
  assert.equal((await listStyleProfiles("ko-KR", "draft", scope)).styleProfiles.length, 1);
});

test("按作用域列出风格规范时不串到其他语体和领域", async () => {
  const all = await listStyleProfiles("ja-JP");
  const scoped = await listStyleProfiles("ja-JP", null, { contentType: "dialogue", domain: "game" });
  assert.ok(scoped.styleProfiles.length >= 1);
  assert.ok(all.styleProfiles.length > scoped.styleProfiles.length, "全量列表包含其他作用域");
  assert.ok(scoped.styleProfiles.every((item) => item.contentType === "dialogue" && item.domain === "game"));
});

test("译者画像只由正例构成：反例不计入阈值也不进样本", async () => {
  const locale = "th-TH";
  for (let index = 0; index < PROFILE_THRESHOLD + 2; index += 1) {
    await saveStyleEvidence({
      locale, contentType: "general", domain: "general",
      source: `被否决原文${index}`, target: `ถูกปฏิเสธ${index}`,
      polarity: "negative", note: "语气不对", provenance: "colleague-reject", status: "accepted"
    });
  }
  const onlyNegatives = await distillUserProfileIfReady(locale);
  assert.equal(onlyNegatives.profile, null, "全是反例时画像不该被触发");
  assert.equal(onlyNegatives.acceptedCount, 0);

  for (let index = 0; index < PROFILE_THRESHOLD; index += 1) {
    await saveStyleEvidence({
      locale, contentType: "general", domain: "general",
      source: `采纳原文${index}`, target: `ยอมรับ${index}`, machineTranslation: `ร่าง${index}`,
      polarity: "positive", provenance: "human-accept", status: "accepted"
    });
  }
  const ready = await distillUserProfileIfReady(locale);
  assert.equal(ready.acceptedCount, PROFILE_THRESHOLD, "计数只统计正例");
  assert.ok(ready.profile?.id);
});
