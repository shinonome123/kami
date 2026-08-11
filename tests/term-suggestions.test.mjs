import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestionCandidates, resolveTermSuggestions } from "../src/term-suggestions.mjs";

const fuzzyMatch = {
  mode: "smart",
  matchPhrase: "豪华数字版",
  score: 0.87,
  term: { id: "term-1", source: "数字豪华版", target: "デジタルデラックス版", forbidden: ["デジタル豪華版"] }
};

test("只为未采用正式译法的智能模糊命中建立候选", () => {
  assert.equal(buildSuggestionCandidates("デジタル豪華版が登場", [fuzzyMatch]).length, 1);
  assert.equal(buildSuggestionCandidates("デジタルデラックス版が登場", [fuzzyMatch]).length, 0);
});

test("禁用译法可由规则直接对齐为替换建议", () => {
  const candidates = buildSuggestionCandidates("デジタル豪華版が登場", [fuzzyMatch]);
  const suggestions = resolveTermSuggestions("デジタル豪華版が登場", candidates, []);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].currentText, "デジタル豪華版");
  assert.equal(suggestions[0].replacement, "デジタルデラックス版");
  assert.equal(suggestions[0].alignment, "rule");
});

test("模型只能对齐译文中真实存在且达到阈值的连续片段", () => {
  const candidates = buildSuggestionCandidates("デジタル豪華エディションが登場", [fuzzyMatch]);
  const suggestions = resolveTermSuggestions("デジタル豪華エディションが登場", candidates, [
    { index: 0, currentText: "不存在的文字", confidence: 0.99, reason: "无效" },
    { index: 0, currentText: "デジタル豪華エディション", confidence: 0.91, reason: "语义对应" }
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].currentText, "デジタル豪華エディション");
  assert.equal(suggestions[0].alignment, "model");
});
