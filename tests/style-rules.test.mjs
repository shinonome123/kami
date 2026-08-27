import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STALE_ROUNDS, applyRulePatch, normalizeRules, renderInstruction, retireRule, ruleId, summarizeRules } from "../src/style-rules.mjs";

const at = (day) => `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`;

function seed() {
  return applyRulePatch([], [
    { op: "add", category: "语气", rule: "台词保留凝练庄重的文言色彩" },
    { op: "add", category: "句式", rule: "短句优先，避免长定语堆叠" }
  ], { round: 1, now: at(1), evidenceCount: 8 });
}

test("同样的规则文本得到同样的 id，便于跨轮比对", () => {
  assert.equal(ruleId("语气", "台词保留文言色彩"), ruleId("语气", "台词保留文言色彩"));
  assert.notEqual(ruleId("语气", "台词保留文言色彩"), ruleId("句式", "台词保留文言色彩"));
});

test("没被本轮提到的规则不会消失——这是累积与滚动重写的分界", () => {
  // 旧实现每轮拿最近 30 条重写整份规范，第 10 条证据学到的规则会随窗口滚出去而静默消失。
  let state = seed();
  assert.equal(state.active.length, 2);
  const kept = state.active[0].id;
  state = applyRulePatch(state.rules, [{ op: "keep", id: kept }], { round: 2, now: at(2), evidenceCount: 8 });
  assert.equal(state.active.length, 2, "只确认了一条，另一条也必须还在");
});

test("连续多轮无人确认才退休，并写明原因", () => {
  let state = seed();
  const kept = state.active[0].id;
  const ignored = state.active[1].id;
  for (let round = 2; round <= 1 + DEFAULT_STALE_ROUNDS; round += 1) {
    state = applyRulePatch(state.rules, [{ op: "keep", id: kept }], { round, now: at(round), evidenceCount: 8 });
  }
  assert.equal(state.active.length, 1);
  assert.ok(state.retiredByAge.includes(ignored));
  const retired = state.rules.find((rule) => rule.id === ignored);
  assert.equal(retired.status, "retired");
  assert.match(retired.retiredReason, /未再被证据确认/);
});

test("证据数跨轮累加，长期成立的规则权重越来越高", () => {
  let state = seed();
  const id = state.active[0].id;
  for (const round of [2, 3, 4]) {
    state = applyRulePatch(state.rules, [{ op: "keep", id }], { round, now: at(round), evidenceCount: 12 });
  }
  const rule = state.rules.find((item) => item.id === id);
  assert.equal(rule.evidenceCount, 8 + 12 * 3);
  assert.equal(rule.rounds, 4);
});

test("update 保留身份与历史，只换措辞", () => {
  let state = seed();
  const id = state.active[0].id;
  state = applyRulePatch(state.rules, [{ op: "update", id, rule: "台词保留文言色彩，但避免生僻字" }], { round: 2, now: at(2), evidenceCount: 5 });
  const rule = state.rules.find((item) => item.id === id);
  assert.equal(rule.id, id, "id 不变才能追溯这条规则的历史");
  assert.match(rule.rule, /避免生僻字/);
  assert.equal(rule.rounds, 2);
  assert.equal(rule.firstSeen, at(1), "首次出现时间保留");
});

test("retire 是显式操作且必须留下原因，规则不会凭空消失", () => {
  let state = seed();
  const id = state.active[0].id;
  state = applyRulePatch(state.rules, [{ op: "retire", id, reason: "本批证据一致改用口语体" }], { round: 2, now: at(2) });
  const rule = state.rules.find((item) => item.id === id);
  assert.equal(rule.status, "retired");
  assert.equal(rule.retiredReason, "本批证据一致改用口语体");
  assert.equal(state.rules.length, 2, "退休不是删除，记录仍在供人工复核");
});

test("模型把已有规则当新规则提交时按确认处理，不产生重复", () => {
  let state = seed();
  const existing = state.active[0];
  state = applyRulePatch(state.rules, [
    { op: "add", category: existing.category, rule: existing.rule }
  ], { round: 2, now: at(2), evidenceCount: 6 });
  assert.equal(state.rules.length, 2, "不应多出一条内容相同的规则");
  assert.equal(state.rules.find((rule) => rule.id === existing.id).rounds, 2);
});

test("未知操作与不存在的 id 被丢弃并留下告警", () => {
  const state = applyRulePatch(seed().rules, [
    { op: "删除全部", id: "r-x" },
    { op: "keep", id: "r-不存在" },
    { op: "update", id: "r-不存在", rule: "x" },
    { op: "add", category: "语气", rule: "" }
  ], { round: 2, now: at(2) });
  assert.equal(state.warnings.length, 4);
  assert.equal(state.active.length, 2, "垃圾操作不应影响已有规则");
});

test("渲染按类别分组，证据多的规则排前面", () => {
  let state = seed();
  const weak = state.active[1].id;
  state = applyRulePatch(state.rules, [
    { op: "add", category: "语气", rule: "句尾统一用敬体" },
    { op: "keep", id: weak }
  ], { round: 2, now: at(2), evidenceCount: 30 });
  const rendered = renderInstruction(state.rules);
  assert.match(rendered, /【语气】/);
  assert.match(rendered, /【句式】/);
  assert.ok(rendered.split("\n").filter((line) => line.startsWith("· ")).length >= 3);
});

test("没有规则时回落到历史散文规范，兼容规则化之前的存量", () => {
  assert.equal(renderInstruction([], "旧版散文规范"), "旧版散文规范");
  assert.equal(renderInstruction(null, "旧版散文规范"), "旧版散文规范");
  assert.equal(renderInstruction([{ status: "retired", category: "语气", rule: "已退休" }], "旧版散文规范"), "旧版散文规范");
});

test("脏数据不会让规则集炸掉", () => {
  assert.deepEqual(normalizeRules("不是数组"), []);
  assert.deepEqual(normalizeRules([null, {}, { rule: "" }]), []);
  const state = applyRulePatch(undefined, undefined, { round: 1, now: at(1) });
  assert.deepEqual(state.rules, []);
});

test("冲突审查可以在蒸馏周期之外单独退休一条规则", () => {
  const state = seed();
  const id = state.active[0].id;
  const rules = retireRule(state.rules, id, { reason: "与技能附加规则冲突且证据更弱", now: at(9) });
  const retired = rules.find((rule) => rule.id === id);
  assert.equal(retired.status, "retired");
  assert.match(retired.retiredReason, /技能附加规则/);
  assert.equal(rules.length, 2, "退休不是删除");
  assert.equal(rules.find((rule) => rule.id !== id).status, "active", "另一条不受影响");
  // 提示词必须立刻不再包含它——等四轮蒸馏老化的话，矛盾会一直留在提示词里。
  assert.doesNotMatch(renderInstruction(rules), new RegExp(retired.rule));
});

test("重复退休与不存在的 id 返回 null，调用方能区分「已经退休」和「刚退休」", () => {
  const state = seed();
  const id = state.active[0].id;
  const once = retireRule(state.rules, id, { reason: "x", now: at(9) });
  assert.ok(once);
  assert.equal(retireRule(once, id, { reason: "x", now: at(9) }), null);
  assert.equal(retireRule(state.rules, "r-不存在", { now: at(9) }), null);
});

test("退休时不写原因也留下可复核的默认说明", () => {
  const state = seed();
  const rules = retireRule(state.rules, state.active[0].id, { now: at(9) });
  assert.match(rules[0].retiredReason, /人工/);
});

test("统计给出活跃/退休数量与最有支撑的规则", () => {
  let state = seed();
  state = applyRulePatch(state.rules, [{ op: "keep", id: state.active[0].id }], { round: 2, now: at(2), evidenceCount: 100 });
  const summary = summarizeRules(state.rules);
  assert.equal(summary.total, 2);
  assert.equal(summary.active, 2);
  assert.equal(summary.strongest[0].evidenceCount, 108);
  assert.ok(summary.categories.includes("语气"));
});
