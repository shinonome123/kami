import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT_TYPES } from "../src/config.mjs";
import {
  benchmarkSnapshotFingerprint,
  evaluationPolicyAudit,
  evaluationProfileForContentType,
  stableEvaluationSeed
} from "../src/evaluation-policy.mjs";

test("所有内容语体都明确落入可复现评测策略，不再共用生产随机温度", () => {
  const audit = evaluationPolicyAudit(Object.keys(CONTENT_TYPES));
  assert.deepEqual(Object.keys(audit).sort(), Object.keys(CONTENT_TYPES).sort());
  for (const [contentType, profile] of Object.entries(audit)) {
    assert.ok(profile.policyVersion);
    assert.ok(profile.repetitions >= 1, contentType);
    assert.ok(profile.translationTemperature >= 0, contentType);
    assert.equal(profile.qaTemperature, 0, contentType);
    assert.equal(profile.seedRequested, true, contentType);
  }
  assert.deepEqual(
    ["dialogue", "marketing", "social"].map((type) => evaluationProfileForContentType(type).repetitions),
    [2, 2, 2]
  );
  assert.equal(evaluationProfileForContentType("verse").repetitions, 3);
  assert.equal(evaluationProfileForContentType("verse").translationTemperature, 0.85);
  for (const type of ["general", "narrative", "codex", "announcement", "item_name", "item_description", "store", "ui", "tutorial", "rules"]) {
    assert.equal(evaluationProfileForContentType(type).mode, "deterministic", type);
    assert.equal(evaluationProfileForContentType(type).translationTemperature, 0, type);
  }
});

test("评测 seed 和快照指纹跨重跑稳定，输入改变时会失效", () => {
  const scope = { locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" };
  const first = stableEvaluationSeed({ scope, caseId: "case-1", repetition: 0 });
  assert.equal(first, stableEvaluationSeed({ scope, caseId: "case-1", repetition: 0 }));
  assert.notEqual(first, stableEvaluationSeed({ scope, caseId: "case-1", repetition: 1 }));
  assert.notEqual(first, stableEvaluationSeed({ scope, caseId: "case-2", repetition: 0 }));

  assert.equal(
    benchmarkSnapshotFingerprint({ b: 2, a: { y: 1, x: 0 } }),
    benchmarkSnapshotFingerprint({ a: { x: 0, y: 1 }, b: 2 })
  );
  assert.notEqual(
    benchmarkSnapshotFingerprint({ model: "v1" }),
    benchmarkSnapshotFingerprint({ model: "v2" })
  );
});
