import test from "node:test";
import assert from "node:assert/strict";
import {
  STYLE_DISTILL_GROWTH_WINDOW,
  STYLE_DISTILL_THRESHOLD,
  evaluateStyleDistillDecision,
  readStyleDistillState
} from "../src/style-distill-gate.mjs";

test("阈值与增长窗口默认都是 8", () => {
  assert.equal(STYLE_DISTILL_THRESHOLD, 8);
  assert.equal(STYLE_DISTILL_GROWTH_WINDOW, 8);
});

test("证据未达阈值时不蒸馏并报出进度", () => {
  const decision = evaluateStyleDistillDecision({ evidenceCount: 6 });
  assert.equal(decision.distill, false);
  assert.equal(decision.skipped, "threshold");
  assert.equal(decision.evidenceCount, 6);
  assert.equal(decision.threshold, 8);
  assert.equal(decision.sinceLastDistill, null);
  assert.match(decision.reason, /未达 8 条蒸馏阈值/);
});

test("首次达到阈值即蒸馏", () => {
  const decision = evaluateStyleDistillDecision({ evidenceCount: 8 });
  assert.equal(decision.distill, true);
  assert.equal(decision.skipped, "");
  assert.match(decision.reason, /首次达到 8 条蒸馏阈值/);
});

test("已有待审核草稿时不重复蒸馏，且优先于阈值判断", () => {
  const decision = evaluateStyleDistillDecision({ evidenceCount: 500, pendingDraftCount: 1, lastDistilledEvidenceCount: 8 });
  assert.equal(decision.distill, false);
  assert.equal(decision.skipped, "pending_draft");
  assert.match(decision.reason, /已有 1 个待审核风格草稿/);
});

test("上次蒸馏后新增不足一个窗口时防抖", () => {
  const decision = evaluateStyleDistillDecision({ evidenceCount: 12, lastDistilledEvidenceCount: 8 });
  assert.equal(decision.distill, false);
  assert.equal(decision.skipped, "growth_window");
  assert.equal(decision.sinceLastDistill, 4);
  assert.match(decision.reason, /仅新增 4 条证据，未达增长窗口 8 条/);
});

test("新增满一个窗口后放行", () => {
  const decision = evaluateStyleDistillDecision({ evidenceCount: 16, lastDistilledEvidenceCount: 8 });
  assert.equal(decision.distill, true);
  assert.equal(decision.sinceLastDistill, 8);
  assert.match(decision.reason, /新增 8 条证据，达到增长窗口/);
});

test("蒸馏失败不落盘，因此下一条证据即自然重试", () => {
  // 失败时没有新 profile 落盘，lastDistilledEvidenceCount 停留在旧值，
  // 窗口条件仍然成立，无需额外的失败记账。
  const failedAt = evaluateStyleDistillDecision({ evidenceCount: 16, lastDistilledEvidenceCount: 8 });
  assert.equal(failedAt.distill, true);
  const retry = evaluateStyleDistillDecision({ evidenceCount: 17, lastDistilledEvidenceCount: 8 });
  assert.equal(retry.distill, true);
});

test("证据被删除导致计数回退时保持不蒸馏", () => {
  const decision = evaluateStyleDistillDecision({ evidenceCount: 5, lastDistilledEvidenceCount: 20 });
  assert.equal(decision.distill, false);
  assert.equal(decision.skipped, "threshold", "先按阈值拦截，不会因为负增量而报错");
});

test("自定义阈值与窗口生效，非法值回落默认", () => {
  const custom = evaluateStyleDistillDecision({ evidenceCount: 3, threshold: 3, growthWindow: 2 });
  assert.equal(custom.distill, true);
  const invalid = evaluateStyleDistillDecision({ evidenceCount: 7, threshold: 0, growthWindow: -5 });
  assert.equal(invalid.threshold, STYLE_DISTILL_THRESHOLD);
  assert.equal(invalid.growthWindow, STYLE_DISTILL_GROWTH_WINDOW);
});

test("状态读取只认同一作用域，并取最高版本作为上次蒸馏基准", () => {
  const profiles = [
    { contentType: "marketing", domain: "game", status: "inactive", version: 1, evidenceCount: 8 },
    { contentType: "marketing", domain: "game", status: "draft", version: 3, evidenceCount: 24 },
    { contentType: "marketing", domain: "game", status: "active", version: 2, evidenceCount: 16 },
    { contentType: "dialogue", domain: "game", status: "draft", version: 9, evidenceCount: 99 },
    { contentType: "marketing", domain: "community", status: "draft", version: 7, evidenceCount: 77 }
  ];
  const state = readStyleDistillState(profiles, { contentType: "marketing", domain: "game" });
  assert.equal(state.pendingDraftCount, 1, "其他语体和领域的草稿不计入本作用域");
  assert.equal(state.lastDistilledEvidenceCount, 24);
});

test("被拒绝的草稿仍然算作上次蒸馏，避免立刻重烧模型", () => {
  const profiles = [{ contentType: "rules", domain: "game", status: "inactive", version: 1, evidenceCount: 8 }];
  const state = readStyleDistillState(profiles, { contentType: "rules", domain: "game" });
  assert.equal(state.pendingDraftCount, 0);
  assert.equal(state.lastDistilledEvidenceCount, 8);
  assert.equal(evaluateStyleDistillDecision({ evidenceCount: 9, ...state }).skipped, "growth_window");
});

test("缺省 domain 按 general 对齐", () => {
  const profiles = [{ contentType: "ui", status: "draft", version: 2, evidenceCount: 10 }];
  const state = readStyleDistillState(profiles, { contentType: "ui" });
  assert.equal(state.pendingDraftCount, 1);
  assert.equal(state.lastDistilledEvidenceCount, 10);
});

test("作用域内没有任何历史规范时返回空基准", () => {
  const state = readStyleDistillState([], { contentType: "social", domain: "game" });
  assert.equal(state.pendingDraftCount, 0);
  assert.equal(state.lastDistilledEvidenceCount, null);
  assert.equal(evaluateStyleDistillDecision({ evidenceCount: 8, ...state }).distill, true);
});
