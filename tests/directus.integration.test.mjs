import test from "node:test";
import assert from "node:assert/strict";
import { activateStyleProfile, deleteAsset, disposeQaCase, getAssets, getAssetStats, getBatchRun, getMemories, getQaCases, getQaRuns, getStyleEvidence, getStyleLearningRuns, getStyleProfile, initializeStore, listBatchRuns, listStyleProfiles, rejectStyleProfile, saveAsset, saveBatchRun, saveImportPreview, saveMemory, saveQaCase, saveQaRun, saveStyleEvidence, saveStyleLearningRun, saveStyleProfile } from "../src/store.mjs";

const enabled = process.env.KAMI_STORE === "directus";

test("Directus 五语集合可读、可统计并保持写入隔离", { skip: !enabled }, async () => {
  await initializeStore();

  const locales = ["ja-JP", "ko-KR", "zh-Hant-TW", "fr-FR", "th-TH"];
  const stats = await Promise.all(locales.map((locale) => getAssetStats(locale)));
  assert.deepEqual(stats.map((entry) => entry.locale), locales);
  assert.ok(stats.every((entry) => entry.termCount >= 1));

  const japanese = await getAssets("ja-JP");
  const korean = await getAssets("ko-KR");
  assert.equal(japanese.terms.find((term) => term.source === "高级通行证")?.target, "プレミアムパス");
  assert.equal(korean.terms.find((term) => term.source === "高级通行证")?.target, "프리미엄 패스");
  assert.equal(japanese.terms.some((term) => term.target === "프리미엄 패스"), false);
  const french = await getAssets("fr-FR");
  assert.equal(french.terms.find((term) => term.source === "高级通行证")?.target, "Pass Premium");

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

test("法语术语与翻译记忆使用独立集合", { skip: !enabled }, async () => {
  await initializeStore();
  const marker = `法语分库隔离-${Date.now()}`;
  const term = await saveAsset("fr-FR", {
    source: marker,
    target: "terme de test",
    domains: ["integration"],
    contentTypes: ["general"],
    status: "draft",
    provenance: "integration-test"
  });
  const memory = await saveMemory("fr-FR", {
    source: marker,
    target: "Phrase française de test.",
    domain: "integration",
    contentType: "general",
    qualityStatus: "human_approved",
    qaScore: 100,
    provenance: "integration-test"
  });
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    const assets = await getAssets("fr-FR");
    const memories = await getMemories("fr-FR", { domain: "integration", contentType: "general", limit: -1 });
    assert.equal(assets.terms.some((item) => item.id === term.id), true);
    assert.equal(assets.terms.some((item) => item.id === memory.id), false, "记忆不能进入术语检索");
    assert.equal(memories.some((item) => item.id === memory.id), true);
    assert.equal(memories.some((item) => item.id === term.id), false, "术语不能进入记忆召回");
  } finally {
    await fetch(`${base}/items/terms_fr_fr/${term.id}`, { method: "DELETE", headers });
    await fetch(`${base}/items/translation_memory_fr_fr/${memory.id}`, { method: "DELETE", headers });
  }
});

test("翻译记忆、风格版本和 AIQA 资产形成隔离闭环", { skip: !enabled }, async () => {
  await initializeStore();
  const marker = `集成记忆-${Date.now()}`;
  const created = [];
  const japanese = await saveMemory("ja-JP", { source: marker, target: "統合メモリ", domain: "integration", contentType: "marketing", qualityStatus: "human_approved", qaScore: 100 });
  const korean = await saveMemory("ko-KR", { source: marker, target: "통합 메모리", domain: "integration", contentType: "marketing", qualityStatus: "human_approved", qaScore: 100 });
  created.push(["translation_memory_ja_jp", japanese.id], ["translation_memory_ko_kr", korean.id]);
  const importBatchId = `integration-${Date.now()}`;
  const evidence = await saveStyleEvidence({ locale: "ja-JP", source: marker, target: "統合メモリ", domain: "integration", contentType: "marketing", status: "accepted", batchId: importBatchId });
  created.push(["style_evidence", evidence.id]);
  const learningRun = await saveStyleLearningRun({ batchId: importBatchId, filename: "integration.xlsx", locale: "ja-JP", contentType: "marketing", domain: "integration", evidenceCount: 1, summary: "集成测试风格摘要", rules: ["使用自然敬体"], examples: [], caveat: "仅限测试", confidence: 0.9, status: "draft", generatedBy: "integration" });
  created.push(["style_learning_runs", learningRun.id]);
  const profile = await saveStyleProfile({ locale: "ja-JP", contentType: "marketing", domain: "integration", name: "集成风格", instruction: "使用自然敬体。", examples: [], evidenceCount: 1, evidenceIds: [evidence.id], generatedBy: "integration", sourceBatchId: importBatchId, learningRunId: learningRun.id, status: "active" });
  created.push(["style_profiles", profile.id]);
  await saveStyleLearningRun({ id: learningRun.id, status: "promoted", promotedProfileId: profile.id });
  const run = await saveQaRun({ locale: "ja-JP", contentType: "marketing", domain: "integration", source: marker, initialTranslation: "統合メモリ", finalTranslation: "統合メモリ", score: null, status: "review", issues: [], termDecisions: [{ officialSource: "豪华内容", officialTarget: "デラックスコンテンツ", decision: "not_applicable", reason: "集成测试" }], humanDecisions: [{ decision: "approved_as_is", reason: "集成测试人工批准" }], references: [], model: "integration", fallbackReason: "integration-timeout" });
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
    assert.equal((await getStyleProfile("ja-JP", "marketing", "integration"))?.sourceBatchId, importBatchId);
    assert.equal((await getStyleProfile("ja-JP", "marketing", "integration"))?.learningRunId, learningRun.id);
    assert.equal((await listStyleProfiles("ja-JP", "active")).styleProfiles.find((item) => item.id === profile.id)?.sourceBatchId, importBatchId);
    assert.equal((await getStyleEvidence("ja-JP", { batchId: importBatchId, contentType: "marketing", domain: "integration", exactScope: true }))[0]?.id, evidence.id);
    const storedLearningRun = (await getStyleLearningRuns("ja-JP", { batchId: importBatchId, status: "promoted" }))[0];
    assert.equal(storedLearningRun?.id, learningRun.id);
    assert.equal(storedLearningRun?.promotedProfileId, profile.id);
    await rejectStyleProfile(profile.id);
    assert.equal(await getStyleProfile("ja-JP", "marketing", "integration"), null, "关闭后不再注入翻译");
    await activateStyleProfile(profile.id);
    assert.equal((await getStyleProfile("ja-JP", "marketing", "integration"))?.id, profile.id, "重新启用后恢复注入");
    assert.equal((await getQaCases("ja-JP", { contentType: "marketing", domain: "integration" })).some((item) => item.id === qaCase.id), true);
    assert.equal((await getQaRuns("ja-JP", { contentType: "marketing", domain: "integration" })).find((item) => item.id === run.id)?.fallbackReason, "integration-timeout");
    assert.equal((await getQaRuns("ja-JP", { contentType: "marketing", domain: "integration" })).find((item) => item.id === run.id)?.termDecisions[0]?.decision, "not_applicable");
    assert.equal((await getQaRuns("ja-JP", { contentType: "marketing", domain: "integration" })).find((item) => item.id === run.id)?.humanDecisions[0]?.decision, "approved_as_is");
    await disposeQaCase(qaCase.id);
    assert.equal((await getQaCases("ja-JP", { contentType: "marketing", domain: "integration" })).some((item) => item.id === qaCase.id), false);
  } finally {
    const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    for (const [collection, id] of created.reverse()) await fetch(`${base}/items/${collection}/${id}`, { method: "DELETE", headers });
  }
});

test("Directus 批次进度首次创建后可继续 PATCH 更新", { skip: !enabled }, async () => {
  await initializeStore();
  const batchId = crypto.randomUUID();
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    await saveBatchRun({ batchId, filename: "首次保存.txt", locale: "ja-JP", contentType: "announcement", domain: "game", format: "text", segmentationMode: "sentence", segments: [{ id: "1", source: "第一句。", status: "pending" }] });
    assert.equal((await getBatchRun(batchId))?.segments[0]?.status, "pending");
    await saveBatchRun({ batchId, filename: "首次保存.txt", locale: "ja-JP", contentType: "announcement", domain: "game", format: "text", segmentationMode: "sentence", segments: [{ id: "1", source: "第一句。", translation: "一文目です。", status: "done" }] });
    assert.equal((await getBatchRun(batchId))?.segments[0]?.status, "done");
    const summary = (await listBatchRuns({ locale: "ja-JP", search: "首次保存" })).find((item) => item.batchId === batchId);
    assert.equal(summary?.status, "completed");
    assert.equal(summary?.completedSegments, 1);
  } finally {
    await fetch(`${base}/items/batch_runs/${batchId}`, { method: "DELETE", headers });
  }
});

test("Directus 候选队列保存完整句段与句内术语的父子血缘", { skip: !enabled }, async () => {
  await initializeStore();
  const candidateKey = `pair-${Date.now()}`;
  const preview = await saveImportPreview({
    filename: "dialogue-lineage.xlsx",
    fileType: "xlsx",
    requestedLocale: "ja-JP",
    statistics: { rowsScanned: 1, candidates: 2, ready: 1, review: 1, excluded: 0 },
    ai: { used: true },
    candidates: [
      { source: "现在去水帘洞看看。", target: "水簾洞へ行ってみよう。", locale: "ja-JP", assetType: "memory", contentType: "dialogue", domain: "game", enforcement: "preferred", contentTypeConfidence: 0.95, contentTypeSource: "ai", candidateKey, candidateRole: "full_pair", candidateOrigin: "table-pair", rowNumber: 2, occurrences: 1, score: 0.92, decision: "ready", reasons: ["完整句段"] },
      { source: "水帘洞", target: "水簾洞", locale: "ja-JP", assetType: "term", contentType: "general", domain: "game", enforcement: "required", contentTypeConfidence: 0.91, contentTypeSource: "ai", candidateKey: `${candidateKey}-term`, candidateRole: "embedded_term", parentCandidateKey: candidateKey, parentCandidateKeys: [candidateKey], parentRowNumber: 2, parentEvidence: [{ parentCandidateKey: candidateKey, parentRowNumber: 2, sourceSpan: { start: 3, end: 6 }, targetSpan: { start: 0, end: 3 } }], candidateOrigin: "ai-term-extraction", termCategory: "location", extractionConfidence: 0.93, sourceSpan: { start: 3, end: 6 }, targetSpan: { start: 0, end: 3 }, rowNumber: 2, occurrences: 1, score: 0.91, decision: "review", reasons: ["句内专名"] }
    ]
  });
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    const response = await fetch(`${base}/items/term_candidates?limit=-1&filter[batch_id][_eq]=${preview.batchId}&fields=id,candidate_key,candidate_role,parent_candidate_key,parent_candidate_keys,parent_row_number,parent_evidence,candidate_origin,term_category,extraction_confidence,source_span,target_span`, { headers });
    const items = (await response.json()).data;
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.candidate_role === "full_pair")?.candidate_key, candidateKey);
    const term = items.find((item) => item.candidate_role === "embedded_term");
    assert.equal(term?.parent_candidate_key, candidateKey);
    assert.deepEqual(term?.parent_candidate_keys, [candidateKey]);
    assert.equal(term?.parent_evidence?.[0]?.parentCandidateKey, candidateKey);
    assert.equal(term?.parent_row_number, 2);
    assert.equal(term?.term_category, "location");
    assert.equal(Number(term?.extraction_confidence), 0.93);
    assert.deepEqual(term?.source_span, { start: 3, end: 6 });
  } finally {
    for (const candidate of preview.candidates) await fetch(`${base}/items/term_candidates/${candidate.candidateId}`, { method: "DELETE", headers });
    await fetch(`${base}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers });
  }
});
