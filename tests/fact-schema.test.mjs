import test from "node:test";
import assert from "node:assert/strict";
import { checkFactSchema, extractFactSchema, runFactQa } from "../src/fact-schema.mjs";

test("事实模式从源文提取平台、地区、日期、折扣、金额、网址与占位符", () => {
  const schema = extractFactSchema({
    source: "PS5 与 Steam 日本地区活动将于2026年8月12日开启，七折优惠，售价¥1,280，详情 https://game.example/sale?id=1，欢迎{player_name}。"
  });

  assert.equal(schema.version, "1.0");
  assert.deepEqual(schema.facts.filter((fact) => fact.type === "platform").map((fact) => fact.normalized), ["ps5", "steam"]);
  assert.deepEqual(schema.facts.filter((fact) => fact.type === "region").map((fact) => fact.normalized), ["JP"]);
  assert.deepEqual(schema.facts.filter((fact) => fact.type === "date").map((fact) => fact.normalized), ["2026-08-12"]);
  assert.deepEqual(schema.facts.filter((fact) => fact.type === "discount").map((fact) => fact.normalized), ["pay:70;off:30"]);
  assert.deepEqual(schema.facts.filter((fact) => fact.type === "money").map((fact) => fact.normalized), ["YEN_OR_YUAN:1280"]);
  assert.equal(schema.facts.find((fact) => fact.type === "url").value, "https://game.example/sale?id=1");
  assert.equal(schema.facts.find((fact) => fact.type === "placeholder").value, "{player_name}");
  assert.equal(schema.summary.translationFacts, schema.facts.length);
});

test("事实检查接受目标语言中的等价日期与折扣表达", () => {
  const source = "PS5 与 Steam 日本地区活动将于2026年8月12日开启，七折优惠，售价¥1,280，详情 https://game.example/sale?id=1，欢迎{player_name}。";
  const translation = "日本でのPS5・Steam向けイベントは2026年8月12日に開始。30%OFF、価格は¥1,280。https://game.example/sale?id=1 {player_name}";
  const { schema, issues } = runFactQa({ source, translation, locale: "ja-JP" });
  assert.ok(schema.facts.length >= 7);
  assert.deepEqual(issues, []);
});

test("事实检查逐项报告被遗漏或改写的确定性事实", () => {
  const schema = extractFactSchema({ source: "Steam 香港活动8月20日开启，折扣30%，价格100元，访问 https://example.test/a 并保留{{name}}。" });
  const issues = checkFactSchema({ schema, translation: "活动很快开始。", locale: "zh-TW" });
  const types = new Set(issues.map((issue) => issue.type));
  assert.ok(types.has("fact_platform_missing"));
  assert.ok(types.has("fact_region_missing"));
  assert.ok(types.has("fact_date_missing"));
  assert.ok(types.has("fact_percentage_mismatch"));
  assert.ok(types.has("fact_money_mismatch"));
  assert.ok(types.has("fact_url_missing"));
  assert.ok(types.has("fact_placeholder_missing"));
  assert.ok(issues.every((issue) => issue.factId && issue.fact));
});

test("行级 DDL 与平台备注只形成任务事实，不要求出现在译文", () => {
  const schema = extractFactSchema({
    source: "欢迎回来。",
    metadata: [
      { label: "投放位置", value: "PlayStation Store 日本地区", role: "context" },
      { label: "DDL", value: "8/12", role: "constraint" },
      { label: "描述", value: "最多10字符", role: "constraint" }
    ]
  });

  assert.equal(schema.facts.find((fact) => fact.type === "deadline").normalized, "--08-12");
  assert.equal(schema.facts.find((fact) => fact.type === "platform").scope, "task");
  assert.equal(schema.facts.find((fact) => fact.type === "region").scope, "task");
  assert.deepEqual(schema.limits.map(({ max, unit }) => ({ max, unit })), [{ max: 10, unit: "character" }]);
  assert.deepEqual(checkFactSchema({ schema, translation: "おかえり。", locale: "ja-JP" }), []);

  const issues = checkFactSchema({ schema, translation: "これは十文字を超える長い翻訳です。", locale: "ja-JP" });
  assert.deepEqual(issues.map((issue) => issue.type), ["length_limit_exceeded"]);
  assert.ok(issues[0].actual > 10);
});

test("地区词不会把语言名称误识别成投放地区", () => {
  const schema = extractFactSchema({ source: "本任务需要日语、韩国语和泰语译文。" });
  assert.equal(schema.facts.some((fact) => fact.type === "region"), false);
});

test("一般数字与百分比分开检查，缺失数字只给警告", () => {
  const schema = extractFactSchema({ source: "完成3次任务可获得50%加成。" });
  assert.equal(schema.facts.filter((fact) => fact.type === "number").length, 1);
  assert.equal(schema.facts.filter((fact) => fact.type === "percentage").length, 1);
  const issues = checkFactSchema({ schema, translation: "任务完成后可获得60%加成。", locale: "zh-TW" });
  assert.equal(issues.find((issue) => issue.type === "fact_number_missing").severity, "warning");
  assert.equal(issues.find((issue) => issue.type === "fact_percentage_mismatch").severity, "error");
});

test("泰语月份名称可与中文数字日期确定性对齐", () => {
  const schema = extractFactSchema({ source: "活动将于8月20日开启。" });
  const issues = checkFactSchema({ schema, translation: "กิจกรรมจะเริ่มในวันที่ 20 สิงหาคม", locale: "th-TH" });
  assert.deepEqual(issues, []);
});

test("单词与字节长度约束采用各自计数方式", () => {
  const wordSchema = extractFactSchema({ source: "你好。", constraints: [{ label: "Limit", value: "maximum 3 words" }] });
  assert.equal(checkFactSchema({ schema: wordSchema, translation: "one two three" }).length, 0);
  assert.equal(checkFactSchema({ schema: wordSchema, translation: "one two three four" })[0].type, "length_limit_exceeded");

  const byteSchema = extractFactSchema({ source: "你好。", constraints: [{ label: "限制", value: "6 bytes" }] });
  assert.equal(checkFactSchema({ schema: byteSchema, translation: "你好" }).length, 0);
  assert.equal(checkFactSchema({ schema: byteSchema, translation: "你好！" })[0].actual, 9);
});
