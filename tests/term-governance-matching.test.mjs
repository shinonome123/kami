import test from "node:test";
import assert from "node:assert/strict";
import { matchTerms } from "../src/matcher.mjs";
import { runQa } from "../src/qa.mjs";

const NOW = new Date("2026-09-03T00:00:00.000Z");

function assets(terms) {
  return { locale: "ja-JP", revision: 1, terms: terms.map((term) => ({ status: "approved", enforcement: "required", ...term })) };
}

test("过期与未生效的术语不再参与匹配，也就不会再报强制术语错误", () => {
  const collection = assets([
    { id: "expired", source: "限定商店", target: "限定ショップ", validTo: "2026-08-01T00:00:00.000Z" },
    { id: "future", source: "新春活动", target: "新春イベント", validFrom: "2026-12-01T00:00:00.000Z" },
    { id: "live", source: "官方公告", target: "公式アナウンス" }
  ]);
  const matches = matchTerms("限定商店与新春活动的官方公告", collection, { now: NOW });
  assert.deepEqual(matches.map((item) => item.term.id), ["live"]);
  const issues = runQa({ source: "限定商店与新春活动的官方公告", translation: "内容", matches, locale: "ja-JP" });
  assert.equal(issues.filter((issue) => issue.type === "required_term").length, 1, "只应为仍然有效的术语报错");
});

test("已废弃的术语版本不再生效", () => {
  const collection = assets([{ id: "old", source: "旧称", target: "旧名称", lifecycleStatus: "deprecated" }]);
  assert.equal(matchTerms("旧称仍在文中", collection, { now: NOW }).length, 0);
});

test("术语的适用平台与地区真的会收窄匹配", () => {
  const collection = assets([
    { id: "ps-only", source: "会员", target: "メンバーシップ", platforms: ["playstation_store"] },
    { id: "anywhere", source: "礼包", target: "パック" }
  ]);
  const onPlaystation = matchTerms("会员礼包", collection, { platform: "playstation_store", now: NOW });
  assert.deepEqual(onPlaystation.map((item) => item.term.id).sort(), ["anywhere", "ps-only"]);

  const onSteam = matchTerms("会员礼包", collection, { platform: "steam", now: NOW });
  assert.deepEqual(onSteam.map((item) => item.term.id), ["anywhere"], "平台不符的术语不应被强制");

  const unspecified = matchTerms("会员礼包", collection, { now: NOW });
  assert.equal(unspecified.length, 2, "调用方不传投放上下文时保持旧行为，不做收窄");
});

test("区分大小写的术语：大小写不一致只提示待确认，不算强制命中", () => {
  const collection = assets([{ id: "ios", source: "iOS", target: "iOS", caseSensitive: true, preserveOriginal: true }]);
  const exact = matchTerms("iOS 版本已上线", collection, { now: NOW });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].mode, "exact");
  assert.equal(exact[0].caseSensitive, true);

  const wrongCase = matchTerms("ios 版本已上线", collection, { now: NOW });
  assert.equal(wrongCase.length, 1);
  assert.equal(wrongCase[0].mode, "fuzzy");
  assert.equal(wrongCase[0].caseMismatch, true);
  const issues = runQa({ source: "ios 版本已上线", translation: "iOS 版がリリースされました。", matches: wrongCase, locale: "ja-JP" });
  assert.equal(issues.some((issue) => issue.type === "term_case_mismatch"), false, "译文已用正确形态时不再提示");

  const stillWrong = runQa({ source: "ios 版本已上线", translation: "ios 版がリリースされました。", matches: wrongCase, locale: "ja-JP" });
  assert.equal(stillWrong.some((issue) => issue.type === "term_case_mismatch"), true);
});

test("保留原文的术语要求原文形态出现在译文里，而不是 target 字段", () => {
  const collection = assets([{ id: "brand", source: "Kami", target: "カミ", preserveOriginal: true }]);
  const matches = matchTerms("欢迎来到 Kami 世界", collection, { now: NOW });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].expectedTarget, "Kami", "保留原文时期望值应是原文形态");
  assert.equal(matches[0].preserveOriginal, true);

  const translated = runQa({ source: "欢迎来到 Kami 世界", translation: "カミの世界へようこそ。", matches, locale: "ja-JP" });
  assert.equal(translated.some((issue) => issue.type === "preserved_term"), true, "把保留原文的专名译掉应当报错");

  const preserved = runQa({ source: "欢迎来到 Kami 世界", translation: "Kami の世界へようこそ。", matches, locale: "ja-JP" });
  assert.equal(preserved.some((issue) => issue.type === "preserved_term"), false);
});

test("禁用译法按术语自己的大小写口径判定", () => {
  const collection = assets([{ id: "case", source: "标题", target: "タイトル", caseSensitive: true, forbidden: ["TITLE"] }]);
  const matches = matchTerms("标题文本", collection, { now: NOW });
  const hit = runQa({ source: "标题文本", translation: "TITLE テキスト", matches, locale: "ja-JP" });
  assert.equal(hit.some((issue) => issue.type === "forbidden_term"), true);
  const miss = runQa({ source: "标题文本", translation: "title テキスト", matches, locale: "ja-JP" });
  assert.equal(miss.some((issue) => issue.type === "forbidden_term"), false, "区分大小写时小写形态不算命中禁用译法");
});
