import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kami-feedback-"));
process.env.KAMI_DATA_DIR = dataDir;
delete process.env.KAMI_STORE; // 建了临时 KAMI_DATA_DIR 就是要隔离：继承 directus 会把测试夹具写进生产库

const { initializeStore, saveMemory, saveStyleEvidence, saveQaCase, demoteMemories, approveQaCase, getMemories, getQaCases } = await import("../src/store.mjs");
const { rankTranslationMemories } = await import("../src/translation-memory.mjs");
await initializeStore();

test("人工采纳回流：旧机器译文降权，人工译法进入记忆与风格证据", async () => {
  const source = "高级通行证现已开放购买";
  const machine = await saveMemory("ja-JP", { source, target: "高級パスが購入可能になりました。", domain: "game", contentType: "marketing", qualityStatus: "machine_verified", qaScore: 92, provenance: "aiqa-passed" });
  const accepted = await saveMemory("ja-JP", { source, target: "プレミアムパスの販売を開始しました。", domain: "game", contentType: "marketing", qualityStatus: "human_approved", qaScore: 100, provenance: "human-accept" });

  const demoted = await demoteMemories("ja-JP", source, accepted.id);
  assert.equal(demoted, 1);

  const evidence = await saveStyleEvidence({ locale: "ja-JP", source, target: accepted.target, contentType: "marketing", domain: "game", status: "accepted", provenance: "human-accept" });
  assert.ok(evidence.id);

  const pool = await getMemories("ja-JP", { contentType: "marketing", domain: "game", limit: -1 });
  assert.equal(pool.length, 2);
  const rejected = pool.find((item) => item.id === machine.id);
  assert.equal(rejected.qualityStatus, "rejected");

  const ranked = rankTranslationMemories(source, pool, { limit: 5 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, accepted.id);
});

test("同句再次人工采纳时旧人工译法降为机器验证", async () => {
  const source = "活动规则请以游戏内公告为准";
  const first = await saveMemory("ja-JP", { source, target: "第一版译文", domain: "game", contentType: "rules", qualityStatus: "human_approved", qaScore: 100, provenance: "human-accept" });
  const second = await saveMemory("ja-JP", { source, target: "第二版译文", domain: "game", contentType: "rules", qualityStatus: "human_approved", qaScore: 100, provenance: "human-accept" });
  const demoted = await demoteMemories("ja-JP", source, second.id);
  assert.equal(demoted, 1);
  const pool = await getMemories("ja-JP", { contentType: "rules", domain: "game", limit: -1 });
  const old = pool.find((item) => item.id === first.id);
  assert.equal(old.qualityStatus, "machine_verified");
  const ranked = rankTranslationMemories(source, pool, { limit: 5 });
  assert.equal(ranked[0].id, second.id);
});

test("关联 QA 案例人工批准后进入可检索状态", async () => {
  const source = "活动奖励将在结束后发放";
  const qaCase = await saveQaCase({ locale: "ja-JP", source, rejectedTranslation: "バッド", correctedTranslation: "イベント報酬は終了後に配布されます。", contentType: "marketing", domain: "game", scoreBefore: 55, scoreAfter: 93, status: "machine_verified" });
  const approved = await approveQaCase(qaCase.id);
  assert.equal(approved, true);
  const cases = await getQaCases("ja-JP", { contentType: "marketing", domain: "game", limit: -1 });
  assert.equal(cases.some((item) => item.id === qaCase.id && item.status === "human_approved"), true);
});
