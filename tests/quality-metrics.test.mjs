import test from "node:test";
import assert from "node:assert/strict";
import { calculateQualityMetrics } from "../src/quality-metrics.mjs";

test("统一计算术语、漏译、事实、人工修改量和审阅耗时", () => {
  const result = calculateQualityMetrics([
    {
      requiredTermTotal: 2,
      requiredTermHits: 2,
      sourceUnitCount: 2,
      omittedUnitCount: 0,
      factCheckTotal: 3,
      factErrorCount: 0,
      translation: "abc",
      humanFinalTranslation: "axc",
      reviewDurationMs: 1_000,
      issues: []
    },
    {
      requiredTerms: [{ matched: true }, { matched: false }],
      sourceUnitCount: 4,
      omittedUnitCount: 1,
      factCheckTotal: 2,
      factErrorCount: 1,
      translation: "",
      finalTranslation: "甲",
      reviewStartedAt: "2026-09-03T10:00:00.000Z",
      reviewCompletedAt: "2026-09-03T10:00:02.000Z",
      issues: [{ category: "omission" }, { category: "date" }]
    },
    {
      sourceUnitCount: 2,
      omittedUnitCount: 1,
      factChecks: [{ correct: true }, { correct: false }],
      candidateTranslation: "同",
      humanFinalTranslation: "同",
      reviewDurationMs: 3_000,
      issues: [{ category: "omission" }, { category: "url" }]
    }
  ]);
  assert.equal(result.sampleSize, 3);
  assert.equal(result.terminologyAccuracy, 0.75);
  assert.equal(result.terminology.hits, 3);
  assert.equal(result.terminology.total, 4);
  assert.equal(result.omissionRate, 2 / 3);
  assert.equal(result.omission.omittedUnitRate, 0.25);
  assert.equal(result.omission.sourceUnits, 8);
  assert.equal(result.factErrorRate, 2 / 7);
  assert.equal(result.facts.errors, 2);
  assert.equal(result.facts.total, 7);
  assert.equal(result.humanEditAmount, 0.4);
  assert.equal(result.humanEditing.totalEditedCharacters, 2);
  assert.equal(result.reviewDurationMs, 2_000);
  assert.equal(result.review.p50DurationMs, 2_000);
  assert.equal(result.review.p95DurationMs, 3_000);
});

test("没有观测值时指标保持 null，同时覆盖率明确为零", () => {
  const result = calculateQualityMetrics([{ issues: [] }]);
  assert.equal(result.terminologyAccuracy, null);
  assert.equal(result.omissionRate, 0);
  assert.equal(result.omission.omittedUnitRate, null);
  assert.equal(result.factErrorRate, null);
  assert.equal(result.humanEditAmount, null);
  assert.equal(result.reviewDurationMs, null);
  assert.equal(result.terminology.caseCoverage, 0);
  assert.equal(result.humanEditing.caseCoverage, 0);
});

test("拒绝不可能的计数、负耗时和倒序审阅时间", () => {
  assert.throws(() => calculateQualityMetrics([{ requiredTermTotal: 1, requiredTermHits: 2, issues: [] }]), /不能大于/u);
  assert.throws(() => calculateQualityMetrics([{ sourceUnitCount: 1, omittedUnitCount: 2, issues: [] }]), /不能大于/u);
  assert.throws(() => calculateQualityMetrics([{ reviewDurationMs: -1, issues: [] }]), /不能为负/u);
  assert.throws(() => calculateQualityMetrics([{
    reviewStartedAt: "2026-09-03T10:00:02Z",
    reviewCompletedAt: "2026-09-03T10:00:01Z",
    issues: []
  }]), /不能早于/u);
});
