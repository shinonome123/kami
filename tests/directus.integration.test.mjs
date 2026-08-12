import test from "node:test";
import assert from "node:assert/strict";
import { deleteAsset, getAssets, getAssetStats, getMemories, getQaCases, getStyleProfile, initializeStore, saveAsset, saveMemory, saveQaCase, saveQaRun, saveStyleEvidence, saveStyleProfile } from "../src/store.mjs";

const enabled = process.env.KAMI_STORE === "directus";

test("Directus 四语集合可读、可统计并保持写入隔离", { skip: !enabled }, async () => {
  await initializeStore();

  const locales = ["ja-JP", "ko-KR", "zh-Hant-TW", "th-TH"];
  const stats = await Promise.all(locales.map((locale) => getAssetStats(locale)));
  assert.deepEqual(stats.map((entry) => entry.locale), locales);
  assert.ok(stats.every((entry) => entry.termCount >= 1));

  const japanese = await getAssets("ja-JP");
  const korean = await getAssets("ko-KR");
  assert.equal(japanese.terms.find((term) => term.source === "高级通行证")?.target, "プレミアムパス");
  assert.equal(korean.terms.find((term) => term.source === "高级通行证")?.target, "프리미엄 패스");
  assert.equal(japanese.terms.some((term) => term.target === "프리미엄 패스"), false);

  const temporary = await saveAsset("th-TH", {
    source: "集成测试术语",
    target: "คำทดสอบการเชื่อมต่อ",
    domains: ["test"],
    contentTypes: ["general"],
    status: "draft",
    provenance: "integration-test"
  });
  try {
    assert.ok(temporary.id);
    const thai = await getAssets("th-TH");
    assert.ok(thai.terms.some((term) => term.id === temporary.id));
    const japaneseAfterWrite = await getAssets("ja-JP");
    assert.equal(japaneseAfterWrite.terms.some((term) => term.source === "集成测试术语"), false);
  } finally {
    await deleteAsset("th-TH", temporary.id);
  }
});

test("翻译记忆、风格版本和 AIQA 资产形成隔离闭环", { skip: !enabled }, async () => {
  await initializeStore();
  const marker = `集成记忆-${Date.now()}`;
  const created = [];
  const japanese = await saveMemory("ja-JP", { source: marker, target: "統合メモリ", domain: "integration", contentType: "marketing", qualityStatus: "human_approved", qaScore: 100 });
  const korean = await saveMemory("ko-KR", { source: marker, target: "통합 메모리", domain: "integration", contentType: "marketing", qualityStatus: "human_approved", qaScore: 100 });
  created.push(["translation_memory_ja_jp", japanese.id], ["translation_memory_ko_kr", korean.id]);
  const evidence = await saveStyleEvidence({ locale: "ja-JP", source: marker, target: "統合メモリ", domain: "integration", contentType: "marketing", status: "accepted" });
  created.push(["style_evidence", evidence.id]);
  const profile = await saveStyleProfile({ locale: "ja-JP", contentType: "marketing", domain: "integration", name: "集成风格", instruction: "使用自然敬体。", examples: [], evidenceCount: 1, evidenceIds: [evidence.id], generatedBy: "integration", status: "active" });
  created.push(["style_profiles", profile.id]);
  const run = await saveQaRun({ locale: "ja-JP", contentType: "marketing", domain: "integration", source: marker, initialTranslation: "統合メモリ", finalTranslation: "統合メモリ", score: 100, status: "passed", issues: [], references: [], model: "integration" });
  created.push(["qa_runs", run.id]);
  const qaCase = await saveQaCase({ locale: "ja-JP", contentType: "marketing", domain: "integration", source: marker, rejectedTranslation: "誤訳", correctedTranslation: "統合メモリ", issues: [], scoreBefore: 80, scoreAfter: 100, status: "machine_verified" });
  created.push(["qa_cases", qaCase.id]);
  try {
    const ja = await getMemories("ja-JP", { contentType: "marketing", domain: "integration" });
    const ko = await getMemories("ko-KR", { contentType: "marketing", domain: "integration" });
    assert.equal(ja.find((item) => item.source === marker)?.target, "統合メモリ");
    assert.equal(ko.find((item) => item.source === marker)?.target, "통합 메모리");
    assert.equal(ja.some((item) => item.target === "통합 메모리"), false);
    assert.equal((await getStyleProfile("ja-JP", "marketing", "integration"))?.id, profile.id);
    assert.equal((await getQaCases("ja-JP", { contentType: "marketing", domain: "integration" })).some((item) => item.id === qaCase.id), true);
  } finally {
    const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    for (const [collection, id] of created.reverse()) await fetch(`${base}/items/${collection}/${id}`, { method: "DELETE", headers });
  }
});
