import test from "node:test";
import assert from "node:assert/strict";
import { classifyContent } from "../src/classifier.mjs";
import { buildContextPack } from "../src/context-pack.mjs";
import { refineCorpus } from "../src/corpus.mjs";
import { matchTerms } from "../src/matcher.mjs";
import { runQa } from "../src/qa.mjs";

const jaAssets = {
  locale: "ja-JP",
  terms: [{
    id: "ja-1",
    source: "高级通行证",
    aliases: ["高级战令"],
    target: "プレミアムパス",
    forbidden: ["高級パス"],
    domains: ["game"],
    contentTypes: ["marketing"],
    enforcement: "required",
    status: "approved"
  }]
};

const koAssets = {
  locale: "ko-KR",
  terms: [{
    id: "ko-1",
    source: "高级通行证",
    aliases: [],
    target: "프리미엄 패스",
    forbidden: [],
    domains: ["game"],
    contentTypes: ["marketing"],
    enforcement: "required",
    status: "approved"
  }]
};

test("自动识别公告与游戏道具语体", () => {
  assert.equal(classifyContent("服务器将于8月15日进行停机维护。感谢各位玩家的理解。", "auto").contentType, "announcement");
  assert.equal(classifyContent("使用后提升20%攻击力，持续10秒。", "auto").contentType, "item_description");
});

test("人工指定语体优先于自动规则", () => {
  const result = classifyContent("限时活动现已开启", "announcement");
  assert.equal(result.contentType, "announcement");
  assert.equal(result.source, "manual");
});

test("同一中文源词在不同语言资产库中只返回当前目标语言", () => {
  const jaMatches = matchTerms("全新高级通行证现已登场", jaAssets, { contentType: "marketing", domain: "game" });
  const koMatches = matchTerms("全新高级通行证现已登场", koAssets, { contentType: "marketing", domain: "game" });
  assert.equal(jaMatches[0].locale, "ja-JP");
  assert.equal(jaMatches[0].term.target, "プレミアムパス");
  assert.equal(koMatches[0].locale, "ko-KR");
  assert.equal(koMatches[0].term.target, "프리미엄 패스");
  assert.ok(!JSON.stringify(jaMatches).includes("프리미엄"));
});

test("别名能够命中同一个批准术语", () => {
  const matches = matchTerms("购买高级战令即可领取奖励", jaAssets, { contentType: "marketing", domain: "game" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].variant, "高级战令");
  assert.equal(matches[0].term.target, "プレミアムパス");
});

test("字符重排产生智能候选，但不会升级为强制术语", () => {
  const assets = { locale: "ja-JP", terms: [{ id: "smart-1", source: "数字豪华版", aliases: [], target: "デジタルデラックス版", forbidden: [], domains: ["game"], contentTypes: ["marketing"], enforcement: "required", status: "approved" }] };
  const matches = matchTerms("豪华数字版现已推出", assets, { contentType: "marketing", domain: "game" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].mode, "smart");
  assert.equal(matches[0].matchPhrase, "豪华数字版");
  const pack = buildContextPack({ source: "豪华数字版现已推出", locale: "ja-JP", classification: classifyContent("豪华数字版现已推出", "marketing"), matches, domain: "game" });
  assert.equal(pack.requiredTerms.length, 0);
  assert.equal(pack.preferredTerms[0].target, "デジタルデラックス版");
  const issues = runQa({ source: "豪华数字版现已推出", translation: "デジタル豪華エディションが登場", matches });
  assert.ok(issues.some((issue) => issue.type === "potential_term" && issue.severity === "warning"));
  assert.ok(!issues.some((issue) => issue.type === "required_term"));
});

test("Context Pack 强制携带目标 locale 且只注入当前语言译法", () => {
  const classification = classifyContent("全新高级通行证现已登场", "marketing");
  const matches = matchTerms("全新高级通行证现已登场", jaAssets, { contentType: "marketing", domain: "game" });
  const pack = buildContextPack({ source: "全新高级通行证现已登场", locale: "ja-JP", classification, matches, domain: "game" });
  assert.equal(pack.targetLocale, "ja-JP");
  assert.equal(pack.requiredTerms[0].target, "プレミアムパス");
  assert.ok(!JSON.stringify(pack).includes("프리미엄"));
});

test("批次 Context Pack 同时携带结构化上下文、术语和风格配置", () => {
  const source = "全新高级通行证现已登场";
  const classification = classifyContent(source, "marketing");
  const matches = matchTerms(source, jaAssets, { contentType: "marketing", domain: "game" });
  const pack = buildContextPack({
    source,
    locale: "ja-JP",
    classification,
    matches,
    domain: "game",
    neighborContext: { previous: "活动即将开始。", next: "完成任务可领取奖励。", document: "公告.docx", segmentIndex: 2, segmentCount: 3 },
    styleProfile: { id: "launch-copy", name: "版本宣发风格", source: "style-library", instruction: "轻快、有期待感，CTA 克制。" }
  });
  assert.equal(pack.neighborContext.previous, "活动即将开始。");
  assert.equal(pack.neighborContext.next, "完成任务可领取奖励。");
  assert.equal(pack.styleProfile.id, "launch-copy");
  assert.equal(pack.styleProfile.instruction, "轻快、有期待感，CTA 克制。");
  assert.equal(pack.requiredTerms[0].target, "プレミアムパス");
});

test("QA 检出缺失强制术语、数字和禁用译法", () => {
  const matches = matchTerms("高级通行证提升20%攻击力", jaAssets, { contentType: "marketing", domain: "game" });
  const issues = runQa({ source: "高级通行证提升20%攻击力", translation: "高級パスで攻撃力が上昇します。", matches });
  assert.ok(issues.some((issue) => issue.type === "required_term"));
  assert.ok(issues.some((issue) => issue.type === "forbidden_term"));
  assert.ok(issues.some((issue) => issue.type === "protected_token"));
});

test("语料炼化保留分段并产生重复短语候选", () => {
  const result = refineCorpus("高级通行证现已登场。购买高级通行证可领取奖励。高级通行证奖励将在活动结束后发放。", { minFrequency: 2 });
  assert.equal(result.segments.length, 3);
  assert.ok(result.candidates.some((candidate) => candidate.term === "高级通行证"));
});
