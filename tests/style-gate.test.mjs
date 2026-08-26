import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kami-gate-"));
process.env.KAMI_DATA_DIR = dataDir;
delete process.env.KAMI_STORE; // 建了临时 KAMI_DATA_DIR 就是要隔离：继承 directus 会把测试夹具写进生产库

const { initializeStore, saveStyleProfile, saveUserProfile, listStyleProfiles, activateStyleProfile, rejectStyleProfile, getStyleProfile, getUserProfile, saveQaCase, listPendingQaCases, approveQaCase, disposeQaCase, getQaCases } = await import("../src/store.mjs");
await initializeStore();

test("风格规范 draft → 激活 → 旧版 inactive 的完整流转", async () => {
  const v1 = await saveStyleProfile({ locale: "ja-JP", contentType: "marketing", domain: "game", name: "日语宣发风格", instruction: "第一版规则", examples: [], evidenceCount: 8, status: "active" });
  const v2 = await saveStyleProfile({ locale: "ja-JP", contentType: "marketing", domain: "game", name: "日语宣发风格", instruction: "第二版规则（草稿）", examples: [], evidenceCount: 12, status: "draft" });
  assert.equal(v2.version, v1.version + 1);
  assert.equal((await getStyleProfile("ja-JP", "marketing", "game")).id, v1.id, "draft 不影响当前 active 版本");

  const drafts = await listStyleProfiles("ja-JP", "draft");
  assert.equal(drafts.styleProfiles.length, 1);
  assert.equal(drafts.styleProfiles[0].id, v2.id);
  assert.equal(drafts.styleProfiles[0].parentId, v1.id);

  const activated = await activateStyleProfile(v2.id);
  assert.equal(activated.status, "active");
  assert.equal((await getStyleProfile("ja-JP", "marketing", "game")).id, v2.id, "激活后新版本生效");

  const inactive = await listStyleProfiles("ja-JP", "inactive");
  assert.ok(inactive.styleProfiles.some((item) => item.id === v1.id), "旧版本置为 inactive");
});

test("拒绝草稿后不参与翻译且可查状态", async () => {
  const draft = await saveStyleProfile({ locale: "ja-JP", contentType: "rules", domain: "game", name: "规则风格", instruction: "待拒规则", examples: [], evidenceCount: 9, status: "draft" });
  const rejected = await rejectStyleProfile(draft.id);
  assert.equal(rejected.status, "inactive");
  assert.equal(await getStyleProfile("ja-JP", "rules", "game"), null);
});

test("译者画像 draft 激活后 getUserProfile 返回新版本", async () => {
  const first = await saveUserProfile({ locale: "ko-KR", name: "韩语译者画像", instruction: "第一版画像", examples: [], evidenceCount: 3, status: "active" });
  const second = await saveUserProfile({ locale: "ko-KR", name: "韩语译者画像", instruction: "第二版画像", examples: [], evidenceCount: 5, status: "draft" });
  assert.equal((await getUserProfile("ko-KR")).id, first.id);
  await activateStyleProfile(second.id);
  assert.equal((await getUserProfile("ko-KR")).id, second.id);
});

test("review 状态 QA 案例：列出入库、采纳为反例、作废删除", async () => {
  const case1 = await saveQaCase({ locale: "ja-JP", source: "待处置案例一", rejectedTranslation: "bad1", correctedTranslation: "good1", contentType: "general", domain: "game", scoreBefore: 50, scoreAfter: 95, status: "review" });
  const case2 = await saveQaCase({ locale: "ja-JP", source: "待处置案例二", rejectedTranslation: "bad2", correctedTranslation: "good2", contentType: "general", domain: "game", scoreBefore: 55, scoreAfter: 96, status: "review" });
  const pending = await listPendingQaCases("ja-JP");
  assert.equal(pending.length, 2);

  assert.equal(await approveQaCase(case1.id), true);
  const afterApprove = await listPendingQaCases("ja-JP");
  assert.equal(afterApprove.some((item) => item.id === case1.id), false);
  assert.ok((await getQaCases("ja-JP", { contentType: "general", domain: "game", limit: -1 })).some((item) => item.id === case1.id), "采纳后进入可检索案例库");

  assert.equal(await disposeQaCase(case2.id), true);
  const afterDispose = await listPendingQaCases("ja-JP");
  assert.equal(afterDispose.length, 0);
});
