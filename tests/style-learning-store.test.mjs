import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KAMI_DATA_DIR = mkdtempSync(join(tmpdir(), "kami-style-learning-"));
delete process.env.KAMI_STORE;
delete process.env.EMBEDDING_MODEL;

const {
  getStyleEvidence,
  getStyleLearningRuns,
  getStyleProfile,
  initializeStore,
  listStyleProfiles,
  saveStyleEvidence,
  saveStyleLearningRun,
  saveStyleProfile
} = await import("../src/store.mjs");

await initializeStore();

test("风格证据支持按批次和严格语体领域隔离", async () => {
  const common = { locale: "ja-JP", source: "同一原文", target: "同じ原文", status: "accepted", embedding: { model: "test", vector: [1] } };
  await saveStyleEvidence({ ...common, contentType: "general", domain: "game", batchId: "batch-a" });
  await saveStyleEvidence({ ...common, target: "別の訳", contentType: "general", domain: "marketing", batchId: "batch-b" });
  await saveStyleEvidence({ ...common, target: "台詞", contentType: "dialogue", domain: "game", batchId: "batch-a" });

  const exact = await getStyleEvidence("ja-JP", { contentType: "general", domain: "game", exactScope: true });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].batchId, "batch-a");

  const batch = await getStyleEvidence("ja-JP", { batchId: "batch-b" });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].domain, "marketing");
});

test("风格学习记录可创建、按批次读取并用 id 局部更新", async () => {
  const created = await saveStyleLearningRun({
    batchId: "batch-style",
    filename: "dialogue.xlsx",
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    evidenceCount: 12,
    summary: "角色台词偏古雅，短句收束。",
    rules: ["保持人物口吻"],
    examples: [{ source: "走罢", target: "行くぞ" }],
    caveat: "仅适用于剧情台词",
    confidence: 0.91,
    status: "draft",
    generatedBy: "test-model"
  });
  assert.ok(created.id);
  assert.equal(created.status, "draft");

  const updated = await saveStyleLearningRun({ id: created.id, status: "promoted", promotedProfileId: "profile-1" });
  assert.equal(updated.summary, created.summary);
  assert.equal(updated.status, "promoted");
  assert.equal(updated.promotedProfileId, "profile-1");

  const runs = await getStyleLearningRuns("ja-JP", { batchId: "batch-style", status: "promoted" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, created.id);
});

test("风格规范保留来源批次和风格学习记录血缘", async () => {
  const profile = await saveStyleProfile({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    name: "剧情台词风格",
    instruction: "保持角色差异和口语节奏。",
    examples: [],
    sourceBatchId: "batch-style",
    learningRunId: "learning-run-1",
    status: "active"
  });
  assert.equal(profile.sourceBatchId, "batch-style");
  assert.equal(profile.learningRunId, "learning-run-1");

  const active = await getStyleProfile("ja-JP", "dialogue", "game");
  assert.equal(active.sourceBatchId, "batch-style");
  assert.equal(active.learningRunId, "learning-run-1");
  const listed = (await listStyleProfiles("ja-JP", "active")).styleProfiles.find((item) => item.id === profile.id);
  assert.equal(listed.sourceBatchId, "batch-style");
  assert.equal(listed.learningRunId, "learning-run-1");
});

test("风格证据落盘并读回机器初稿、极性与否决理由", async () => {
  const revised = await saveStyleEvidence({
    locale: "ja-JP", contentType: "dialogue", domain: "game",
    source: "先走一步了", target: "お先に失礼！", machineTranslation: "先に一歩行く。",
    polarity: "positive", provenance: "human-accept", status: "accepted"
  });
  const rejected = await saveStyleEvidence({
    locale: "ja-JP", contentType: "dialogue", domain: "game",
    source: "这波稳了", target: "この波は安定だ。",
    polarity: "negative", note: "翻译腔，日语玩家不会这么说", provenance: "colleague-reject", status: "accepted"
  });
  assert.equal(revised.machineTranslation, "先に一歩行く。");
  assert.equal(rejected.polarity, "negative");

  const stored = await getStyleEvidence("ja-JP", { contentType: "dialogue", domain: "game", exactScope: true, limit: 100 });
  const back = new Map(stored.map((item) => [item.id, item]));
  assert.equal(back.get(revised.id).machineTranslation, "先に一歩行く。");
  assert.equal(back.get(revised.id).polarity, "positive");
  assert.equal(back.get(rejected.id).polarity, "negative");
  assert.match(back.get(rejected.id).note, /翻译腔/);
});

test("历史证据没有新字段时按正例回落，不影响既有数据", async () => {
  const legacy = await saveStyleEvidence({
    locale: "ko-KR", contentType: "ui", domain: "game",
    source: "确认", target: "확인", provenance: "table-import", status: "accepted"
  });
  assert.equal(legacy.polarity, "positive");
  assert.equal(legacy.machineTranslation, "");
  const [stored] = await getStyleEvidence("ko-KR", { contentType: "ui", domain: "game", exactScope: true, limit: 10 });
  assert.equal(stored.polarity, "positive");
});
