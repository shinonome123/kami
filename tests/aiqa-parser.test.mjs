import test from "node:test";
import assert from "node:assert/strict";
import { parseAiQaLineResponse, parseAiQaResponse } from "../src/provider.mjs";

test("AIQA 兼容标准对象、裸数组与代码围栏", () => {
  assert.deepEqual(parseAiQaResponse('{"issues":[]}').issues, []);
  assert.equal(parseAiQaResponse('[{"severity":"minor","message":"语气略生硬"}]').issues[0].message, "语气略生硬");
  assert.equal(parseAiQaResponse('```json\n{"issues":[{"severity":"major","message":"漏译"}]}\n```').issues[0].message, "漏译");
});

test("AIQA 明确无问题的自然响应按通过处理", () => {
  for (const value of ["PASS", "未发现问题。", "問題ありません。"] ) assert.deepEqual(parseAiQaResponse(value).issues, []);
});

test("AIQA 行式降级可承载问题和修订建议", () => {
  const issues = parseAiQaLineResponse("ISSUE|major|accuracy|基础游戏|基本ゲーム|术语不一致|改用通常版");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "major");
  assert.equal(issues[0].suggestion, "改用通常版");
  assert.deepEqual(parseAiQaLineResponse("PASS"), []);
  const prose = parseAiQaLineResponse("译文整体自然，但商品名称需要统一为术语库中的正式译法。");
  assert.equal(prose[0].category, "unstructured_review");
  assert.equal(prose[0].severity, "major");
});
