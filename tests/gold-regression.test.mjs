import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRegressionSuite,
  createRegressionCandidateFromQaCase,
  decideRegressionCandidate,
  normalizeGoldSet,
  selectActiveGoldSamples,
  selectActiveGoldSets,
  selectActiveRegressionCases
} from "../src/gold-regression.mjs";

const scope = Object.freeze({ locale: "ja-JP", contentType: "announcement", domain: "game", project: "wukong" });

function goldSet(overrides = {}) {
  return {
    id: "gold-ja-announcement-v1",
    seriesId: "gold-ja-announcement",
    version: 1,
    name: "日语公告固定集",
    scope,
    status: "active",
    enabled: true,
    samples: [{
      id: "gold-case-1",
      source: "活动将于8月20日结束。",
      referenceTarget: "イベントは8月20日に終了します。",
      requiredTerms: [{ source: "活动", target: "イベント" }],
      facts: [{ id: "date", type: "date", sourceValue: "8月20日", expectedValue: "8月20日" }]
    }],
    ...overrides
  };
}

test("Gold Set 固定版本、精确作用域并生成稳定指纹", () => {
  const input = goldSet({ metadata: { z: 2, a: 1 } });
  const normalized = normalizeGoldSet(input);
  assert.equal(normalized.scopeKey, "ja-JP::announcement::game::wukong");
  assert.equal(normalized.samples[0].referenceTargets[0], "イベントは8月20日に終了します。");
  assert.equal(normalized.samples[0].requiredTerms[0].target, "イベント");
  assert.match(normalized.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(
    normalized.fingerprint,
    normalizeGoldSet(goldSet({ metadata: { a: 1, z: 2 } })).fingerprint,
    "对象键顺序不能改变固定集指纹"
  );
  assert.equal(input.samples[0].referenceTargets, undefined, "规范化不能修改调用方数据");
});

test("每个 Gold 系列只选择最新启用版本，禁用版本与其他作用域被排除", () => {
  const v1 = goldSet();
  const v2Disabled = goldSet({ id: "gold-ja-announcement-v2", version: 2, enabled: false });
  const v3 = goldSet({
    id: "gold-ja-announcement-v3",
    version: 3,
    samples: [{ id: "gold-case-3", source: "维护完成。", target: "メンテナンスが完了しました。" }]
  });
  const otherScope = goldSet({
    id: "gold-ko-announcement-v1",
    seriesId: "gold-ko-announcement",
    scope: { ...scope, locale: "ko-KR" },
    samples: [{ id: "gold-ko-1", source: "维护完成。", target: "점검이 완료되었습니다." }]
  });
  const selected = selectActiveGoldSets([v1, v2Disabled, v3, otherScope], { scope });
  assert.deepEqual(selected.map((item) => item.id), ["gold-ja-announcement-v3"]);
  const cases = selectActiveGoldSamples([v1, v2Disabled, v3], { scope });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].goldSetVersion, 3);
  assert.equal(cases[0].goldSetId, "gold-ja-announcement-v3");
});

test("Gold Set 拒绝跨语言样本、重复样本和矛盾启停状态", () => {
  assert.throws(() => normalizeGoldSet(goldSet({
    samples: [{ id: "cross", source: "你好", target: "안녕하세요", scope: { ...scope, locale: "ko-KR" } }]
  })), /作用域不一致/u);
  assert.throws(() => normalizeGoldSet(goldSet({
    samples: [
      { id: "same", source: "甲", target: "A" },
      { id: "same", source: "乙", target: "B" }
    ]
  })), /重复样本 id/u);
  assert.throws(() => normalizeGoldSet(goldSet({ status: "retired", enabled: true })), /只有 active 状态可以启用/u);
  assert.throws(() => normalizeGoldSet(goldSet({ samples: [] })), /不能是空集/u);
});

function approvedQaCase(overrides = {}) {
  return {
    id: "qa-100",
    status: "human_approved",
    locale: "ja-JP",
    contentType: "announcement",
    domain: "game",
    project: "wukong",
    source: "活动奖励将在结束后发放。",
    rejectedTranslation: "イベント報酬を配布します。",
    correctedTranslation: "イベント報酬は終了後に配布されます。",
    scoreBefore: 72,
    scoreAfter: 96,
    issues: [{ dimension: "fidelity", category: "omission", severity: "major", message: "漏译了发放时间" }],
    ...overrides
  };
}

test("人工批准 QA 失败案例先成为候选，经第二次人工批准后才能进入回归集", () => {
  const candidate = createRegressionCandidateFromQaCase(approvedQaCase(), { createdBy: "system" });
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.sourceQaCaseId, "qa-100");
  assert.equal(candidate.scope.project, "wukong");
  assert.throws(() => buildRegressionSuite({
    id: "reg-v1", seriesId: "reg-ja-announcement", version: 1, name: "公告失败回归", scope,
    status: "active", enabled: true, candidates: [candidate]
  }), /尚未人工批准/u);

  const approved = decideRegressionCandidate(candidate, {
    decision: "approve", reviewer: "reviewer-a", decidedAt: "2026-09-03T10:00:00Z", note: "确认可复现"
  });
  const suite = buildRegressionSuite({
    id: "reg-v1", seriesId: "reg-ja-announcement", version: 1, name: "公告失败回归", scope,
    status: "active", enabled: true, candidates: [approved]
  });
  assert.equal(suite.cases.length, 1);
  assert.equal(suite.cases[0].approval.reviewer, "reviewer-a");
  assert.equal(suite.cases[0].expectedTranslation, "イベント報酬は終了後に配布されます。");
  const selected = selectActiveRegressionCases([suite], { scope });
  assert.equal(selected[0].regressionSuiteVersion, 1);
});

test("机器案例不能直入候选，拒绝的候选不能进入套件", () => {
  assert.throws(() => createRegressionCandidateFromQaCase(approvedQaCase({ status: "machine_verified" })), /只有人工批准/u);
  const candidate = createRegressionCandidateFromQaCase(approvedQaCase());
  assert.throws(() => decideRegressionCandidate(candidate, { decision: "reject", reviewer: "reviewer-a" }), /必须填写原因/u);
  const rejected = decideRegressionCandidate(candidate, { decision: "reject", reviewer: "reviewer-a", note: "案例不可稳定复现" });
  assert.equal(rejected.status, "rejected");
  assert.throws(() => buildRegressionSuite({
    id: "reg-v1", version: 1, name: "公告失败回归", scope,
    status: "active", enabled: true, candidates: [rejected]
  }), /尚未人工批准/u);
});

test("回归套件禁止混入其他语言或项目的案例", () => {
  const foreign = decideRegressionCandidate(createRegressionCandidateFromQaCase(approvedQaCase({
    id: "qa-ko", locale: "ko-KR", project: "another"
  })), { decision: "approve", reviewer: "reviewer-a" });
  assert.throws(() => buildRegressionSuite({
    id: "reg-v1", version: 1, name: "公告失败回归", scope,
    status: "active", enabled: true, candidates: [foreign]
  }), /作用域不一致/u);
});
