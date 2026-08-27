import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_RULE_EQUIVALENT_EVIDENCE,
  collectPromptRules,
  findConflictCandidates,
  planConflictResolution,
  ruleAspects,
  ruleDirection,
  weighConflict
} from "../src/rule-conflicts.mjs";
import { createConflictScanner } from "../src/conflict-scan.mjs";

const styleProfile = {
  rules: [
    { id: "r1", category: "语气", rule: "句尾统一使用敬体ます形", evidenceCount: 520, rounds: 6, status: "active" },
    { id: "r2", category: "句式", rule: "短句优先，避免长定语堆叠", evidenceCount: 120, rounds: 3, status: "active" },
    { id: "r3", category: "语气", rule: "对白避免使用敬体，保持常体口吻", evidenceCount: 9, rounds: 1, status: "active" },
    { id: "r4", category: "语气", rule: "已退休的旧规则", evidenceCount: 999, rounds: 9, status: "retired" }
  ]
};
const translationSkill = { id: "s1", version: 3, strategy: { prompting: { additionalRules: ["句尾一律改用だ・である体"] } } };

test("三个提示词来源都被纳入比较，退休规则排除在外", () => {
  const rules = collectPromptRules({
    styleProfile,
    translationSkill,
    userProfile: { id: "u1", instruction: "整体保持亲切口语，避免书面腔", evidenceCount: 12 }
  });
  assert.deepEqual(rules.map((rule) => rule.origin).sort(), ["profile", "skill", "style", "style", "style"]);
  assert.equal(rules.some((rule) => rule.rule === "已退休的旧规则"), false, "退休规则不再进提示词，也就不该参与冲突比较");
});

test("方面识别把谈同一件事的规则聚到一起", () => {
  assert.ok(ruleAspects({ rule: "句尾统一使用敬体ます形" }).includes("句尾体裁"));
  assert.ok(ruleAspects({ rule: "书名号用《》" }).includes("标点"));
  assert.deepEqual(ruleAspects({ rule: "这条不谈任何已知方面" }), []);
});

test("方向识别要认得否定词的辖域，否则整套排序都是错的", () => {
  assert.equal(ruleDirection({ rule: "必须统一使用敬体" }), "positive");
  // 「不得使用」里的「使用」是被否定的，不是一条肯定主张——早期实现把它判成 mixed。
  assert.equal(ruleDirection({ rule: "不得使用简体" }), "negative");
  assert.equal(ruleDirection({ rule: "句尾不要用ます形" }), "negative");
  // 这一条才是真的双向：既禁一件事又要求另一件事。
  assert.equal(ruleDirection({ rule: "对白避免使用敬体，保持常体口吻" }), "mixed");
  assert.equal(ruleDirection({ rule: "这条不谈方向" }), "neutral");
});

test("同作用域内互相矛盾的两条风格规则会被列为最高优先候选", () => {
  const candidates = findConflictCandidates(collectPromptRules({ styleProfile, translationSkill }));
  const pair = candidates.find((candidate) =>
    [candidate.left.id, candidate.right.id].includes("r1") && [candidate.left.id, candidate.right.id].includes("r3"));
  assert.ok(pair, "同为风格规范、同谈句尾、语义相反的一对必须被捕获");
  assert.ok(pair.aspects.includes("句尾体裁"));
});

test("不谈同一方面的规则不会被凑成候选", () => {
  const candidates = findConflictCandidates(collectPromptRules({
    styleProfile: { rules: [
      { id: "a", category: "标点", rule: "书名号用《》", evidenceCount: 5, rounds: 1, status: "active" },
      { id: "b", category: "数字", rule: "日期写成 8月20日", evidenceCount: 5, rounds: 1, status: "active" }
    ] }
  }));
  assert.equal(candidates.length, 0);
});

test("权重按证据算，技能规则折算成中等权重而不是垫底", () => {
  const strong = { origin: "style", originLabel: "风格规范", evidenceCount: 520, rounds: 6 };
  const weak = { origin: "style", originLabel: "风格规范", evidenceCount: 9, rounds: 1 };
  const skill = { origin: "skill", originLabel: "技能附加规则", evidenceCount: 0, rounds: 0 };
  assert.equal(weighConflict(strong, weak).winner, strong);
  assert.equal(weighConflict(skill, weak).winner, skill, "技能规则靠评测晋升，不该输给只有 9 条证据的风格规则");
  assert.equal(weighConflict(strong, skill).winner, strong);
  assert.equal(SKILL_RULE_EQUIVALENT_EVIDENCE, 50);
});

test("势均力敌时交人工，不硬选一个", () => {
  const same = { origin: "style", originLabel: "风格规范", evidenceCount: 10, rounds: 1 };
  const result = weighConflict({ ...same }, { ...same });
  assert.equal(result.winner, null);
  assert.match(result.verdict, /人工/);
});

test("只有风格规则可以被提议退休，技能与画像一律交人工", () => {
  const styleVsStyle = planConflictResolution({
    aspects: ["句尾体裁"],
    left: { origin: "style", originLabel: "风格规范", id: "r1", rule: "统一敬体", evidenceCount: 520, rounds: 6 },
    right: { origin: "style", originLabel: "风格规范", id: "r3", rule: "避免敬体", evidenceCount: 9, rounds: 1 }
  });
  assert.equal(styleVsStyle.action, "retire-style-rule");
  assert.equal(styleVsStyle.ruleId, "r3");

  // 风格规则输了就可以提议退休；输的是技能规则时只能交人工——
  // 技能只能经 challenger 评测晋升修改，扫描不得代劳。
  const skillLoses = planConflictResolution({
    aspects: ["句尾体裁"],
    left: { origin: "style", originLabel: "风格规范", id: "r1", rule: "统一敬体", evidenceCount: 520, rounds: 6 },
    right: { origin: "skill", originLabel: "技能附加规则", id: "0", rule: "改用常体", evidenceCount: 0, rounds: 0 }
  });
  assert.equal(skillLoses.action, "review");
  assert.match(skillLoses.reason, /技能附加规则/);

  const styleLosesToSkill = planConflictResolution({
    aspects: ["句尾体裁"],
    left: { origin: "style", originLabel: "风格规范", id: "r1", rule: "统一敬体", evidenceCount: 5, rounds: 1 },
    right: { origin: "skill", originLabel: "技能附加规则", id: "0", rule: "改用常体", evidenceCount: 0, rounds: 0 }
  });
  assert.equal(styleLosesToSkill.action, "retire-style-rule", "输的是风格规则时可以提议退休它");
  assert.equal(styleLosesToSkill.ruleId, "r1");

  const profileLoses = planConflictResolution({
    aspects: ["语气强度"],
    left: { origin: "style", originLabel: "风格规范", id: "r1", rule: "保持庄重", evidenceCount: 520, rounds: 6 },
    right: { origin: "profile", originLabel: "译者画像", id: "u1", rule: "保持轻快口语", evidenceCount: 3, rounds: 0 }
  });
  assert.equal(profileLoses.action, "review", "画像须走草稿流程，扫描同样不得代劳");
});

function scanner(overrides = {}) {
  const recorded = [];
  const instance = createConflictScanner({
    deps: {
      loadScopeRules: async () => ({ styleProfile, translationSkill }),
      adjudicate: async ({ candidates }) => candidates.map((_, index) => ({
        index, conflict: index === 0, situation: "对白句尾两难", recommendation: "保留证据更强的一条"
      })),
      recordReport: async (report) => { recorded.push(report); },
      ...overrides
    },
    now: () => "2026-08-26T00:00:00.000Z"
  });
  return { instance, recorded };
}

test("扫描只上报模型确认为真的冲突，候选本身不算结论", async () => {
  const { instance, recorded } = scanner();
  const report = await instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.equal(report.conflicts.length, 1, "候选是刻意放宽的，只有模型确认的才算");
  assert.ok(report.candidates > 1);
  assert.equal(report.conflicts[0].situation, "对白句尾两难");
  assert.equal(recorded.length, 1);
});

test("模型不可用时不把候选当结论上报", async () => {
  const { instance, recorded } = scanner({ adjudicate: async () => { throw new Error("模型超时"); } });
  const report = await instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.deepEqual(report.conflicts, []);
  assert.match(report.reason, /冲突审查模型不可用/);
  assert.equal(recorded.length, 0, "没有结论就不该写报告，更不该覆盖上一次真跑出来的那份");
});

test("「没什么可比」也是结论，要落报告，否则刷新页面就变回未扫描", async () => {
  const { instance, recorded } = scanner({
    loadScopeRules: async () => ({ styleProfile: { rules: [], instruction: "旧版散文规范" } })
  });
  await instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].reason, /散文/);
});

test("每个出口的报告形状一致，前端不必分别处理", async () => {
  const shape = (report) => Object.keys(report).sort().join(",");
  const full = await scanner().instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  const early = await scanner({ loadScopeRules: async () => ({ styleProfile: { rules: [] } }) })
    .instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  const failed = await scanner({ adjudicate: async () => { throw new Error("x"); } })
    .instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.equal(shape(early), shape(failed));
  for (const key of ["scope", "scannedRules", "candidates", "conflicts", "scannedAt"]) {
    assert.ok(key in full && key in early, `完整报告与提前退出都要有 ${key}`);
  }
});

test("规则不足两条时直接跳过，不烧模型调用", async () => {
  let called = false;
  const { instance } = scanner({
    loadScopeRules: async () => ({ styleProfile: { rules: [{ id: "only", category: "语气", rule: "唯一一条", status: "active" }] } }),
    adjudicate: async () => { called = true; return []; }
  });
  const report = await instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.equal(called, false);
  assert.match(report.reason, /不足两条/);
});

test("规则化之前的散文规范要说清楚为什么比不了，而不是只报「不足两条」", async () => {
  // 线上每一份存量规范都是这个状态：只有整段 instruction，rules[] 为空。
  const { instance } = scanner({
    loadScopeRules: async () => ({ styleProfile: { rules: [], instruction: "台词保持凝练庄重的文言色彩，避免现代口语。" } })
  });
  const report = await instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.match(report.reason, /散文/);
  assert.match(report.reason, /下次蒸馏/, "要告诉用户怎么让它参与比对");
});

test("确实什么都没有时不谎称是散文规范", async () => {
  const { instance } = scanner({ loadScopeRules: async () => ({ styleProfile: null }) });
  const report = await instance.scan({ locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" });
  assert.match(report.reason, /不足两条/);
});

test("并发触发被串行化，扫描永不抛出", async () => {
  let running = 0;
  let overlapped = false;
  const { instance } = scanner({
    adjudicate: async ({ candidates }) => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return candidates.map((_, index) => ({ index, conflict: false }));
    }
  });
  const scope = { locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" };
  await Promise.all([instance.scan(scope), instance.scan(scope), instance.scan(scope)]);
  assert.equal(overlapped, false, "蒸馏突发不该叠成并发扫描");
});

test("依赖缺失时构造即失败，不留到运行时才炸", () => {
  assert.throws(() => createConflictScanner({ deps: { loadScopeRules: () => {} } }), /缺少/);
});
