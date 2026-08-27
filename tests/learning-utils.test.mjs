import test from "node:test";
import assert from "node:assert/strict";
import { learningEvaluationResult } from "../public/learning-utils.js";

test("未评测候选的 null 评测记录不会拖垮学习中心", () => {
  assert.deepEqual(learningEvaluationResult(null), {});
  assert.deepEqual(learningEvaluationResult(undefined), {});
});

test("学习评测按记录、报告、结果的顺序合并", () => {
  assert.deepEqual(learningEvaluationResult({
    decision: "pending",
    report: { status: "insufficient", conclusion: "报告结论" },
    result: { conclusion: "最终结论" }
  }), {
    decision: "pending",
    report: { status: "insufficient", conclusion: "报告结论" },
    result: { conclusion: "最终结论" },
    status: "insufficient",
    conclusion: "最终结论"
  });
});
