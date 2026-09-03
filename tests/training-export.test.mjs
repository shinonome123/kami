import test from "node:test";
import assert from "node:assert/strict";
import {
  DROP_REASONS,
  buildDpoDataset,
  buildEvaluationIndex,
  buildSftDataset,
  buildTrainingExport,
  datasetToJsonl
} from "../src/training-export.mjs";

const SCOPE = { locale: "ja-JP", contentType: "announcement", domain: "game", project: "default" };

function trajectory(overrides = {}) {
  return {
    id: "traj-1",
    ...SCOPE,
    status: "completed",
    source: "8月20日にセールを開始します。",
    initialTranslation: "8月20日にセールが始まる。",
    finalTranslation: "8月20日よりセールを開始いたします。",
    humanDecision: { accepted: true, finalTranslation: "8月20日よりセールを開始いたします。" },
    model: "gpt-test",
    promptVersion: "v1",
    createdAt: "2026-08-20T10:00:00.000Z",
    ...overrides
  };
}

test("SFT 只收人工采纳的终稿，assistant 轮永远是人工措辞", () => {
  const dataset = buildSftDataset([trajectory()], { scope: SCOPE });
  assert.equal(dataset.records.length, 1);
  const [record] = dataset.records;
  assert.equal(record.messages.length, 3);
  assert.equal(record.messages[1].content, "8月20日にセールを開始します。");
  assert.equal(record.messages[2].content, "8月20日よりセールを開始いたします。");
  assert.match(record.messages[0].content, /ja-JP/);
});

test("未完成、未采纳和跨作用域的轨迹按原因丢弃", () => {
  const dataset = buildSftDataset([
    trajectory({ id: "running", status: "running" }),
    trajectory({ id: "unaccepted", humanDecision: { accepted: false } }),
    trajectory({ id: "other-locale", locale: "ko-KR" }),
    trajectory({ id: "kept" })
  ], { scope: SCOPE });
  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.records[0].id, "kept");
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.NOT_COMPLETED], 1);
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.NOT_HUMAN_ACCEPTED], 1);
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.SCOPE_MISMATCH], 1);
  assert.equal(dataset.audit.input, 4);
  assert.equal(dataset.audit.kept, 1);
});

test("同一原文终稿重复只保留一条", () => {
  const dataset = buildSftDataset([trajectory({ id: "a" }), trajectory({ id: "b" })], { scope: SCOPE });
  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.DUPLICATE], 1);
});

test("命中固定评测资产的样本一律丢弃，防止训练集污染基准", () => {
  const index = buildEvaluationIndex({
    goldSamples: [{ source: "8月20日にセールを開始します。" }],
    regressionCases: [{ source: "本イベントは日本地域限定です。" }]
  });
  assert.equal(index.size, 2);
  const dataset = buildSftDataset([trajectory()], { scope: SCOPE, evaluationIndex: index });
  assert.equal(dataset.records.length, 0);
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.EVALUATION_LEAKAGE], 1);
});

test("DPO 同时吃人工改写和人工批准的 QA 修订", () => {
  const dataset = buildDpoDataset({
    trajectories: [trajectory()],
    qaCases: [{
      id: "qa-1",
      ...SCOPE,
      status: "human_approved",
      source: "本イベントは日本地域限定です。",
      rejectedTranslation: "このイベントは全地域で行われます。",
      correctedTranslation: "本イベントは日本地域限定です。",
      scoreBefore: 62,
      scoreAfter: 95
    }]
  }, { scope: SCOPE });
  assert.equal(dataset.records.length, 2);
  const byOrigin = Object.fromEntries(dataset.records.map((record) => [record.origin, record]));
  assert.equal(byOrigin.trajectory.chosen, "8月20日よりセールを開始いたします。");
  assert.equal(byOrigin.trajectory.rejected, "8月20日にセールが始まる。");
  assert.equal(byOrigin.qa_case.metadata.scoreAfter, 95);
});

test("机器初译与人工终稿相同的轨迹没有偏好信号", () => {
  const identical = trajectory({
    id: "identical",
    initialTranslation: "8月20日よりセールを開始いたします。"
  });
  const dataset = buildDpoDataset({ trajectories: [identical] }, { scope: SCOPE });
  assert.equal(dataset.records.length, 0);
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.IDENTICAL_PAIR], 1);
});

test("未经人工批准的 QA 案例不能进入偏好数据", () => {
  const dataset = buildDpoDataset({
    qaCases: [{
      id: "qa-machine",
      ...SCOPE,
      status: "machine_verified",
      source: "テスト原文です。",
      rejectedTranslation: "誤訳。",
      correctedTranslation: "正しい訳。"
    }]
  }, { scope: SCOPE });
  assert.equal(dataset.records.length, 0);
  assert.equal(dataset.audit.droppedByReason[DROP_REASONS.NOT_HUMAN_ACCEPTED], 1);
});

test("JSONL 按训练器实际消费的形状序列化", () => {
  const sft = buildSftDataset([trajectory()], { scope: SCOPE });
  const sftLine = JSON.parse(datasetToJsonl(sft));
  assert.deepEqual(Object.keys(sftLine), ["messages"]);
  assert.equal(sftLine.messages[2].role, "assistant");

  const dpo = buildDpoDataset({ trajectories: [trajectory()] }, { scope: SCOPE });
  const dpoLine = JSON.parse(datasetToJsonl(dpo));
  assert.deepEqual(Object.keys(dpoLine).sort(), ["chosen", "prompt", "rejected", "system"]);
});

test("整包导出记录排除了哪些固定评测样本", () => {
  const bundle = buildTrainingExport({
    trajectories: [trajectory(), trajectory({ id: "leak", source: "固定基准原文。", finalTranslation: "訳", humanDecision: { accepted: true, finalTranslation: "訳文です。" } })],
    qaCases: [],
    goldSamples: [{ id: "gold-1", scope: SCOPE, source: "固定基准原文。" }],
    regressionCases: []
  }, { scope: SCOPE });
  assert.equal(bundle.manifest.excludedEvaluationSources, 1);
  assert.equal(bundle.sft.records.length, 1);
  assert.equal(bundle.sft.records[0].id, "traj-1");
  assert.equal(bundle.sft.audit.droppedByReason[DROP_REASONS.EVALUATION_LEAKAGE], 1);
});
