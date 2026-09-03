import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewReceipt, normalizeReviewDecision } from "../src/review-receipt.mjs";

test("逐条接受、部分接受、拒绝和要求修订并生成中文处理回执", () => {
  const input = {
    id: "receipt-1",
    taskId: "task-88",
    taskName: "9月活动公告",
    batchId: "batch-9",
    locale: "ja-JP",
    processedBy: "译审甲",
    processedAt: "2026-09-03T11:00:00Z",
    decisions: [
      {
        issueId: "issue-1", segmentId: "3", category: "术语", issue: "版本名未采用正式译名",
        suggestion: "改为デジタルデラックス版", action: "accept",
        beforeTranslation: "豪華版", afterTranslation: "デジタルデラックス版", reason: "按术语库修正"
      },
      {
        issueId: "issue-2", field: "标题", category: "风格", issue: "标题语气偏弱", action: "partial",
        acceptedParts: ["增强动词"], rejectedParts: ["增加感叹号"], reason: "公告标题不使用感叹号"
      },
      {
        issueId: "issue-3", segmentId: "7", category: "准确性", issue: "日期疑似错误", action: "reject",
        reason: "已根据活动排期确认，当前日期正确"
      },
      {
        issueId: "issue-4", segmentId: "9", category: "流畅度", issue: "句式不自然", action: "revise",
        revisionInstruction: "保持事实不变，调整日语语序"
      }
    ]
  };
  const receipt = buildReviewReceipt(input);
  assert.equal(receipt.status, "pending_revision");
  assert.deepEqual(receipt.summary, {
    total: 4, accept: 1, partial: 1, reject: 1, revise: 1,
    pending: 1, resolved: 3, translationChanges: 1
  });
  assert.equal(receipt.items[1].actionLabel, "部分接受");
  assert.equal(receipt.items[3].resolutionStatus, "pending_revision");
  assert.match(receipt.textZh, /审阅意见处理回执/u);
  assert.match(receipt.textZh, /接受 1 条，部分接受 1 条，拒绝 1 条，要求修订 1 条/u);
  assert.match(receipt.textZh, /修改前：豪華版/u);
  assert.match(receipt.textZh, /修改后：デジタルデラックス版/u);
  assert.equal(input.decisions[0].actionLabel, undefined, "构建回执不能修改输入对象");
});

test("已有修订后译文的 revise 决定立即完成", () => {
  const receipt = buildReviewReceipt({
    id: "receipt-2", taskId: "task-2", reviewer: "译审乙",
    decisions: [{
      issueId: "issue-1", issue: "语序不自然", decision: "revise",
      currentTranslation: "旧译文", finalTranslation: "新译文", request: "调整语序"
    }]
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.summary.pending, 0);
  assert.equal(receipt.summary.translationChanges, 1);
});

test("部分接受必须列明两部分，拒绝必须说明原因，修订必须有可执行要求", () => {
  assert.throws(() => normalizeReviewDecision({
    issueId: "a", issue: "问题", action: "partial", acceptedParts: ["前半句"]
  }), /同时说明接受部分和未接受部分/u);
  assert.throws(() => normalizeReviewDecision({ issueId: "b", issue: "问题", action: "reject" }), /必须填写原因/u);
  assert.throws(() => normalizeReviewDecision({ issueId: "c", issue: "问题", action: "revise" }), /必须填写修订要求/u);
  assert.throws(() => normalizeReviewDecision({ issueId: "d", issue: "问题", action: "unknown" }), /action 无效/u);
});

test("同一回执禁止重复处理同一个 QA 问题", () => {
  assert.throws(() => buildReviewReceipt({
    id: "receipt-3", taskId: "task-3", processedBy: "译审甲",
    decisions: [
      { issueId: "same", issue: "问题一", action: "accept" },
      { issueId: "same", issue: "问题二", action: "accept" }
    ]
  }), /不能重复处理/u);
});
