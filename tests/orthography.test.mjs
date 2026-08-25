import test from "node:test";
import assert from "node:assert/strict";
import { PUNCTUATION_POLICY, checkOrthography, punctuationGuidance } from "../src/orthography.mjs";
import { digitSequence, digitsRecoverable, extractProtectedTokens } from "../src/text.mjs";
import { runQa } from "../src/qa.mjs";

const TITLE_SOURCE = "《黑神话：钟馗》X分钟实机演示";

test("韩语译文照搬中文书名号时给出约定提示", () => {
  const issues = checkOrthography({
    source: TITLE_SOURCE,
    translation: "《검은 신화: 종규》 X분 실제 플레이 영상",
    locale: "ko-KR"
  });
  const title = issues.find((issue) => issue.type === "orthography_title_bracket");
  assert.ok(title, "实测样本里 7 处书名号全部照搬，此前无任何拦截");
  assert.match(title.message, /「」/);
  assert.equal(title.severity, "warning", "标点是可秒改的格式问题，不该像硬错误一样封顶");
});

test("使用约定括号时不再提示", () => {
  const issues = checkOrthography({
    source: TITLE_SOURCE,
    translation: "「검은 신화: 종규」 X분 실제 플레이 영상",
    locale: "ko-KR"
  });
  assert.equal(issues.length, 0);
});

test("中文标点混进韩语译文按无效标点报告，重复出现只报一条", () => {
  const issues = checkOrthography({
    source: "第一，第二，第三。",
    translation: "첫째，둘째，셋째。",
    locale: "ko-KR"
  });
  const comma = issues.find((issue) => issue.character === "，");
  assert.equal(comma.occurrences, 2);
  assert.match(comma.message, /应改为「,」/);
  assert.equal(issues.filter((issue) => issue.character === "，").length, 1, "两处同一个符号是一个决定，不是两个缺陷");
});

test("日语允许【】但不接受中文书名号", () => {
  const kept = checkOrthography({ source: "【公告】内容", translation: "【お知らせ】内容", locale: "ja-JP" });
  assert.equal(kept.length, 0, "【】在日语里是正常用法");
  const wrong = checkOrthography({ source: TITLE_SOURCE, translation: "《黒神話：鍾馗》X分実機プレイ", locale: "ja-JP" });
  assert.ok(wrong.some((issue) => issue.character === "《"));
});

test("原文没有标作品名时不误判普通括号", () => {
  const issues = checkOrthography({ source: "实机演示", translation: "「실제 플레이」", locale: "ko-KR" });
  assert.equal(issues.filter((issue) => issue.type === "orthography_title_bracket").length, 0);
});

test("未配置策略的语言与空译文安全返回空结果", () => {
  assert.deepEqual(checkOrthography({ source: "甲", translation: "乙", locale: "en-US" }), []);
  assert.deepEqual(checkOrthography({ source: "甲", translation: "   ", locale: "ko-KR" }), []);
});

test("每个受支持语言都有可注入提示词的标点约定", () => {
  for (const locale of Object.keys(PUNCTUATION_POLICY)) {
    assert.ok(punctuationGuidance(locale).length > 0, `${locale} 缺少标点约定说明`);
  }
  assert.equal(punctuationGuidance("en-US"), "");
});

test("裸数字不再是受保护 token，带单位的才是", () => {
  assert.deepEqual(extractProtectedTokens("在820当天瞅瞅"), [], "820 是日期简写，不该要求字面保留");
  assert.deepEqual(extractProtectedTokens("50%和100元"), ["50%", "100元"]);
  assert.deepEqual(extractProtectedTokens("见 https://a.example/b 和 {name}"), ["https://a.example/b", "{name}"]);
});

test("数字按数值等价校验：正确本地化的日期不再判成漏译", () => {
  assert.equal(digitSequence("在820当天"), "820");
  assert.equal(digitsRecoverable("在820当天", "8月20日にチェック"), true);
  assert.equal(digitsRecoverable("在820当天", "8월 20일 당일"), true);
  assert.equal(digitsRecoverable("在820当天", "その日にチェック"), false, "整个日期没了才算真丢");
});

test("人工译文写成 8月20日 不再触发硬错误，硬 QA 只留可复核的提示", () => {
  const issues = runQa({
    source: "在820当天瞅瞅官号动态",
    translation: "8月20日に公式アカウントをチェック",
    locale: "ja-JP"
  });
  assert.equal(issues.filter((issue) => issue.severity === "error").length, 0, "此前 820 缺失记 error 并把 basic 封顶到 60");
  assert.equal(issues.filter((issue) => issue.type === "number_drift").length, 0);
});

test("数字真的丢掉时仍然报告，但只是待确认而非硬错误", () => {
  const issues = runQa({ source: "在820当天开启", translation: "その日に開始します", locale: "ja-JP" });
  const drift = issues.find((issue) => issue.type === "number_drift");
  assert.ok(drift);
  assert.equal(drift.severity, "warning");
  assert.match(drift.message, /820/);
});

test("硬 QA 会带出标点约定问题，且不影响强制术语判定", () => {
  const issues = runQa({
    source: TITLE_SOURCE,
    translation: "《검은 신화: 종규》 X분",
    locale: "ko-KR",
    matches: []
  });
  assert.ok(issues.some((issue) => issue.type === "orthography_title_bracket"));
  assert.equal(issues.filter((issue) => issue.severity === "error").length, 0);
});
