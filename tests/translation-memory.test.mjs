import test from "node:test";
import assert from "node:assert/strict";
import { calculateQaScore, presentAiQaIssues } from "../src/qa.mjs";
import { rankQaCases, rankTranslationMemories } from "../src/translation-memory.mjs";

test("翻译记忆检索优先同义近似且已验证的译例", () => {
  const ranked = rankTranslationMemories("高级通行证现已开放购买", [
    { id: "a", source: "高级通行证现已开放购买。", target: "プレミアムパスを販売中です。", qualityStatus: "human_approved", qaScore: 100 },
    { id: "b", source: "服务器维护结束。", target: "メンテナンスが終了しました。", qualityStatus: "human_approved", qaScore: 100 },
    { id: "c", source: "高级通行证现已开放", target: "誤った訳", qualityStatus: "rejected", qaScore: 20 }
  ]);
  assert.equal(ranked[0].id, "a");
  assert.equal(ranked.some((item) => item.id === "c"), false);
});

test("历史 AIQA 问题按当前原文相似度召回", () => {
  const ranked = rankQaCases("活动奖励将在结束后发放", [
    { id: "q1", source: "活动奖励会在活动结束后发放。", rejectedTranslation: "bad", correctedTranslation: "good", scoreAfter: 96 },
    { id: "q2", source: "服务器维护开始。", rejectedTranslation: "bad2", correctedTranslation: "good2", scoreAfter: 95 }
  ]);
  assert.equal(ranked[0].id, "q1");
});

test("AIQA 分数由问题严重度计算且硬错误封顶", () => {
  assert.equal(calculateQaScore({ aiIssues: [{ severity: "major", confidence: 0.9 }] }), 88);
  assert.equal(calculateQaScore({ hardIssues: [{ severity: "error" }], aiIssues: [] }), 60);
  const presented = presentAiQaIssues([{ severity: "major", category: "style", message: "语体不一致", suggestion: "改用敬体", confidence: 0.9 }]);
  assert.equal(presented[0].severity, "error");
  assert.match(presented[0].message, /改用敬体/);
});
