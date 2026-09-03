import test from "node:test";
import assert from "node:assert/strict";
import {
  decideReleaseGate,
  evaluateGoldRun,
  evaluateGoldSample,
  evaluateRegressionCase,
  evaluateRegressionRun,
  resolveGateAssets
} from "../src/quality-gate.mjs";

const SCOPE = { locale: "ja-JP", contentType: "announcement", domain: "game", project: "default" };

function goldSample(overrides = {}) {
  return {
    id: "gold-1",
    source: "8月20日にPlayStation Storeで30%オフ。",
    referenceTargets: ["8月20日にPlayStation Storeで30%オフ。"],
    requiredTerms: [{ source: "PlayStation Store", target: "PlayStation Store", acceptedTargets: [], caseSensitive: false, preserveSource: true }],
    forbiddenTranslations: ["プレステ"],
    protectedTokens: ["{count}"],
    facts: [{ id: "fact-1", type: "date", sourceValue: "8月20日", expectedValue: "8月20日", comparison: "semantic_exact", critical: true }],
    ...overrides
  };
}

test("Gold 样本按术语、事实、禁用译法和占位符硬判定", () => {
  const clean = evaluateGoldSample(goldSample(), { translation: "8月20日にPlayStation Storeで{count}本が30%オフ。" });
  assert.equal(clean.passed, true);
  assert.equal(clean.requiredTerms[0].correct, true);
  assert.equal(clean.factChecks[0].correct, true);

  const broken = evaluateGoldSample(goldSample(), { translation: "8月21日にプレステで割引。" });
  assert.equal(broken.passed, false);
  const categories = broken.issues.map((issue) => issue.category).sort();
  assert.deepEqual(categories, ["date", "forbidden", "placeholder", "terminology"]);
});

test("参考译文只作为相似度信号，不构成等值要求", () => {
  const paraphrased = evaluateGoldSample(goldSample({ forbiddenTranslations: [], protectedTokens: [] }), {
    translation: "PlayStation Storeでは8月20日から30％の割引を実施します。"
  });
  assert.equal(paraphrased.passed, true);
  assert.equal(paraphrased.exactMatch, false);
  assert.ok(paraphrased.similarity > 0 && paraphrased.similarity < 1);
});

test("空译文按严重漏译处理", () => {
  const empty = evaluateGoldSample(goldSample(), { translation: "   " });
  assert.equal(empty.passed, false);
  assert.equal(empty.issues[0].category, "omission");
});

const REGRESSION_CASE = {
  id: "regression-1",
  sourceQaCaseId: "qa-1",
  source: "本イベントは日本地域限定です。",
  failingTranslation: "이 이벤트는 전 지역에서 진행됩니다.",
  expectedTranslation: "본 이벤트는 일본 지역 한정입니다.",
  requiredTerms: [],
  facts: [{ id: "fact-1", type: "region", sourceValue: "日本", expectedValue: "일본", comparison: "semantic_exact", critical: true }]
};

test("回归案例只在复现已拒绝译文或丢失事实时判失败", () => {
  const fixed = evaluateRegressionCase(REGRESSION_CASE, { translation: "본 이벤트는 일본 지역 한정입니다." });
  assert.equal(fixed.passed, true);
  assert.equal(fixed.matchesExpected, true);

  const regressed = evaluateRegressionCase(REGRESSION_CASE, { translation: "이 이벤트는 전 지역에서 진행됩니다." });
  assert.equal(regressed.passed, false);
  assert.equal(regressed.issues[0].category, "regression");

  const rephrased = evaluateRegressionCase(REGRESSION_CASE, { translation: "본 이벤트는 일본에서만 진행됩니다." });
  assert.equal(rephrased.passed, true, "换一种说法但事实正确应当通过");

  const factLost = evaluateRegressionCase(REGRESSION_CASE, { translation: "본 이벤트는 한정 진행됩니다." });
  assert.equal(factLost.passed, false);
  assert.equal(factLost.issues[0].category, "region");
});

test("未执行的回归案例计入总数但不计入通过", () => {
  const run = evaluateRegressionRun({
    cases: [REGRESSION_CASE, { ...REGRESSION_CASE, id: "regression-2" }],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  assert.equal(run.total, 2);
  assert.equal(run.evaluated, 1);
  assert.equal(run.passed, 1);
  assert.deepEqual(run.missing, ["regression-2"]);
  assert.equal(run.passRate, 0.5);
});

test("回归失败一票否决，缺回归集时不算通过", () => {
  const failing = evaluateRegressionRun({
    cases: [REGRESSION_CASE],
    results: [{ id: "regression-1", translation: "이 이벤트는 전 지역에서 진행됩니다." }]
  });
  const blocked = decideReleaseGate({ regression: failing, gold: null });
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blocking.some((item) => item.code === "regression_failed"));

  const noAssets = decideReleaseGate({ regression: null, gold: null });
  assert.equal(noAssets.allowed, false);
  assert.ok(noAssets.blocking.some((item) => item.code === "regression_missing"));
});

test("回归全绿且 Gold 达标时放行，缺 Gold 只警告", () => {
  const regression = evaluateRegressionRun({
    cases: [REGRESSION_CASE],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  const gold = evaluateGoldRun({
    samples: [goldSample()],
    results: [{ id: "gold-1", translation: "8月20日にPlayStation Storeで{count}本が30%オフ。" }]
  });
  assert.equal(gold.termAccuracy, 1);
  assert.equal(gold.factAccuracy, 1);
  assert.equal(gold.metrics.terminologyAccuracy, 1);

  const passed = decideReleaseGate({ regression, gold });
  assert.equal(passed.decision, "pass");
  assert.equal(passed.allowed, true);
  assert.ok(passed.warnings.some((item) => item.code === "gold_too_small"));

  const withoutGold = decideReleaseGate({ regression, gold: null });
  assert.equal(withoutGold.allowed, true);
  assert.ok(withoutGold.warnings.some((item) => item.code === "gold_missing"));

  const strict = decideReleaseGate({ regression, gold: null, thresholds: { allowMissingGold: false } });
  assert.equal(strict.allowed, false);
});

test("Gold 术语或事实退化会阻断发版", () => {
  const gold = evaluateGoldRun({
    samples: [goldSample(), goldSample({ id: "gold-2" })],
    results: [
      { id: "gold-1", translation: "8月20日にPlayStation Storeで{count}本が30%オフ。" },
      { id: "gold-2", translation: "8月21日にストアで{count}本が割引。" }
    ]
  });
  assert.equal(gold.passed, 1);
  assert.equal(gold.failed, 1);
  const regression = evaluateRegressionRun({
    cases: [REGRESSION_CASE],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  const decision = decideReleaseGate({ regression, gold });
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocking.some((item) => item.code === "gold_terminology"));
  assert.ok(decision.blocking.some((item) => item.code === "gold_facts"));
});

test("门禁资产解析只取当前作用域启用的最新版本，并带出版本指纹", () => {
  const goldSets = [
    { id: "gold-v1", seriesId: "gold", version: 1, scope: SCOPE, name: "发布 Gold", status: "active", enabled: true, samples: [goldSample()] },
    { id: "gold-v2", seriesId: "gold", version: 2, scope: SCOPE, name: "发布 Gold", status: "active", enabled: true, samples: [goldSample({ id: "gold-9" })] },
    { id: "gold-other", seriesId: "other", version: 1, scope: { ...SCOPE, locale: "ko-KR" }, name: "别的语言", status: "active", enabled: true, samples: [goldSample()] }
  ];
  const resolved = resolveGateAssets({ goldSets, regressionSuites: [], scope: SCOPE });
  assert.equal(resolved.samples.length, 1);
  assert.equal(resolved.samples[0].id, "gold-9");
  assert.deepEqual(resolved.goldSetVersions, ["gold@v2"]);
  assert.ok(resolved.samples[0].goldSetFingerprint);
});
