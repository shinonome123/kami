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

test("语义向量命中词面差异大的同义译例", () => {
  const query = { vector: [1, 0, 0, 0], dimensions: 4, model: "mock" };
  const ranked = rankTranslationMemories("购买高级通行证的入口在哪里", [
    { id: "lexical", source: "入口在哪里", target: "入口はどこですか", qualityStatus: "human_approved", qaScore: 100, embedding: null },
    { id: "semantic", source: "高级通行证要在哪里购买", target: "プレミアムパスはどこで購入できますか", qualityStatus: "human_approved", qaScore: 100, embedding: { vector: [0.98, 0.1, 0.05, 0], dimensions: 4, model: "mock" } }
  ], { limit: 5, queryEmbedding: query });
  assert.equal(ranked[0].id, "semantic");
  assert.ok(ranked[0].semantic !== null);
  assert.ok(ranked[0].similarity >= 0.28);
});

test("无查询向量或维度不一致时回退纯词面排序", () => {
  const memories = [
    { id: "exact", source: "服务器维护结束。", target: "メンテナンスが終了しました。", qualityStatus: "human_approved", qaScore: 100, embedding: { vector: [1, 0], dimensions: 2, model: "other" } },
    { id: "far", source: "欢迎来到新世界。", target: "新しい世界へようこそ。", qualityStatus: "human_approved", qaScore: 100, embedding: null }
  ];
  const withoutQuery = rankTranslationMemories("服务器维护结束。", memories, { limit: 5, queryEmbedding: null });
  assert.equal(withoutQuery[0].id, "exact");
  assert.equal(withoutQuery[0].semantic, null);

  const dimensionMismatch = rankTranslationMemories("服务器维护结束。", memories, { limit: 5, queryEmbedding: { vector: [1, 0, 0, 0], dimensions: 4, model: "mock" } });
  assert.equal(dimensionMismatch.length, 2);
  assert.equal(dimensionMismatch[0].id, "exact");
  assert.equal(dimensionMismatch[0].semantic, null);
  assert.equal(dimensionMismatch[1].id, "far");
  assert.equal(dimensionMismatch[1].contextualFallback, true);
});

test("qa_cases 语义向量同样参与混合打分", () => {
  const query = { vector: [0, 1, 0], dimensions: 3, model: "mock" };
  const ranked = rankQaCases("活动奖励领取方式说明", [
    { id: "semantic-case", source: "奖励如何领取", rejectedTranslation: "bad", correctedTranslation: "good", scoreAfter: 96, embedding: { vector: [0.1, 0.99, 0.05], dimensions: 3, model: "mock" } },
    { id: "lexical-case", source: "说明文档更新", rejectedTranslation: "bad2", correctedTranslation: "good2", scoreAfter: 95, embedding: null }
  ], { limit: 3, queryEmbedding: query });
  assert.equal(ranked[0].id, "semantic-case");
});

test("AIQA 分数由问题严重度计算且硬错误封顶", () => {
  assert.equal(calculateQaScore({ aiIssues: [{ severity: "major", confidence: 0.9 }] }), 88);
  assert.equal(calculateQaScore({ hardIssues: [{ severity: "error" }], aiIssues: [] }), 60);
  const presented = presentAiQaIssues([{ severity: "major", category: "style", message: "语体不一致", suggestion: "改用敬体", confidence: 0.9 }]);
  assert.equal(presented[0].severity, "error");
  assert.match(presented[0].message, /改用敬体/);
});
