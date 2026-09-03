import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  advanceTrainingRun,
  buildTrainingManifest,
  canTransition,
  createTrainingRun,
  freezeTrainingDataset
} from "../src/training-pipeline.mjs";

const SCOPE = { locale: "ja-JP", contentType: "narrative", domain: "game", project: "default" };
const SFT_JSONL = [
  JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "user", content: "原文一" }, { role: "assistant", content: "訳一" }] }),
  JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "user", content: "原文二" }, { role: "assistant", content: "訳二" }] })
].join("\n");
const DPO_JSONL = JSON.stringify({ prompt: "原文一", chosen: "良い訳", rejected: "悪い訳", system: "s" });

function sftDataset() {
  return freezeTrainingDataset({ kind: "sft", jsonl: SFT_JSONL, scope: SCOPE, audit: { kept: 2, dropped: 0 } });
}

function newRun(overrides = {}) {
  return createTrainingRun({
    scope: SCOPE,
    recipe: { method: "sft", baseModel: "gpt-base" },
    datasets: [sftDataset()],
    createdBy: "tester",
    createdAt: "2026-09-03T00:00:00.000Z",
    ...overrides
  });
}

test("冻结数据集的指纹算在序列化内容上，可被外部复算", () => {
  const dataset = sftDataset();
  assert.equal(dataset.recordCount, 2);
  assert.equal(dataset.kind, "sft");
  assert.equal(dataset.contentFingerprint, createHash("sha256").update(SFT_JSONL, "utf8").digest("hex"));
  assert.equal(dataset.scopeKey, "ja-JP::narrative::game::default");
});

test("空数据集和非法行都不能冻结", () => {
  assert.throws(() => freezeTrainingDataset({ kind: "sft", jsonl: "", scope: SCOPE }), /空数据集/);
  assert.throws(() => freezeTrainingDataset({ kind: "sft", jsonl: "not json", scope: SCOPE }), /不是合法 JSON/);
  assert.throws(() => freezeTrainingDataset({ kind: "whatever", jsonl: SFT_JSONL, scope: SCOPE }), /不支持的数据集类型/);
});

test("训练配方缺失关键项直接拒绝", () => {
  assert.throws(() => createTrainingRun({ scope: SCOPE, recipe: { method: "sft" }, datasets: [sftDataset()] }), /基座模型/);
  assert.throws(() => createTrainingRun({ scope: SCOPE, recipe: { method: "distillation", baseModel: "b" }, datasets: [sftDataset()] }), /教师模型/);
  assert.throws(() => createTrainingRun({ scope: SCOPE, recipe: { method: "sft", baseModel: "b" }, datasets: [] }), /至少需要一个已冻结的数据集/);
});

test("DPO 训练必须带偏好数据集", () => {
  assert.throws(
    () => createTrainingRun({ scope: SCOPE, recipe: { method: "dpo", baseModel: "b" }, datasets: [sftDataset()] }),
    /必须包含偏好数据集/
  );
  const dpo = freezeTrainingDataset({ kind: "dpo", jsonl: DPO_JSONL, scope: SCOPE });
  const run = createTrainingRun({ scope: SCOPE, recipe: { method: "dpo", baseModel: "b" }, datasets: [dpo] });
  assert.equal(run.recipe.method, "dpo");
  assert.equal(run.totalRecords, 1);
});

test("状态机不允许跳过冻结和提交", () => {
  const run = newRun();
  assert.equal(run.status, "draft");
  assert.equal(canTransition("draft", "running"), false);
  assert.throws(() => advanceTrainingRun(run, { status: "running" }), /不能从 draft 直接进入 running/);
  const frozen = advanceTrainingRun(run, { status: "frozen", at: "t1", by: "tester" });
  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.history.at(-1).from, "draft");
});

test("没有产物不能登记，没有门禁不能投产", () => {
  let run = newRun();
  for (const status of ["frozen", "submitted", "running", "succeeded"]) {
    run = advanceTrainingRun(run, { status, at: "t", by: "tester" });
  }
  assert.throws(() => advanceTrainingRun(run, { status: "registered" }), /必须提供 artifact/);
  const registered = advanceTrainingRun(run, {
    status: "registered",
    at: "t5",
    artifact: { modelId: "kami-ja-sft-v1", adapterUri: "s3://adapters/kami-ja-sft-v1" }
  });
  assert.equal(registered.artifact.modelId, "kami-ja-sft-v1");
  assert.equal(registered.artifact.baseModel, "gpt-base");

  assert.throws(() => advanceTrainingRun(registered, { status: "promoted" }), /必须提供质量门禁结果/);
  assert.throws(
    () => advanceTrainingRun(registered, { status: "promoted", gate: { decision: "block" } }),
    /质量门禁未通过/
  );
  const promoted = advanceTrainingRun(registered, {
    status: "promoted",
    at: "t6",
    gate: { decision: "pass", runId: "quality-run-1", regressionPassRate: 1, goldTermAccuracy: 0.99 }
  });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.gate.runId, "quality-run-1");
  assert.equal(promoted.history.length, 6);
});

test("失败与取消是终态", () => {
  let run = advanceTrainingRun(newRun(), { status: "frozen" });
  run = advanceTrainingRun(run, { status: "submitted" });
  const failed = advanceTrainingRun(run, { status: "failed", error: "外部训练平台返回 OOM" });
  assert.equal(failed.error, "外部训练平台返回 OOM");
  assert.throws(() => advanceTrainingRun(failed, { status: "running" }), /不能从 failed/);
});

test("交接清单只带校验信息，不带数据本身", () => {
  const manifest = buildTrainingManifest(newRun());
  assert.equal(manifest.datasets.length, 1);
  assert.equal(manifest.datasets[0].recordCount, 2);
  assert.ok(manifest.datasets[0].contentFingerprint);
  assert.equal(JSON.stringify(manifest).includes("訳一"), false, "清单不应包含训练数据正文");
  assert.ok(manifest.runFingerprint);
  assert.match(manifest.verification, /sha256/);
});

test("同一配方同一数据的任务指纹稳定，换数据就变", () => {
  assert.equal(newRun().fingerprint, newRun().fingerprint);
  const other = createTrainingRun({
    scope: SCOPE,
    recipe: { method: "sft", baseModel: "gpt-base" },
    datasets: [freezeTrainingDataset({ kind: "sft", jsonl: `${SFT_JSONL}\n${SFT_JSONL.split("\n")[0]}`, scope: SCOPE })]
  });
  assert.notEqual(newRun().fingerprint, other.fingerprint);
});
