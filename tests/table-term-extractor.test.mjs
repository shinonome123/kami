import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { applyModelDecisions, extractTermPairs } from "../src/table-term-extractor.mjs";

async function workbookBase64(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("术语表");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
}

test("自动识别同表中的日韩繁泰列并保持目标语言分组", async () => {
  const base64 = await workbookBase64([
    ["中文", "日语", "韩语", "繁體中文", "泰语"],
    ["高级通行证", "プレミアムパス", "프리미엄 패스", "高級通行證", "บัตรผ่านพรีเมียม"],
    ["维护", "メンテナンス", "점검", "維護", "การบำรุงรักษา"]
  ]);
  const result = await extractTermPairs({ filename: "四语术语.xlsx", base64, locale: "auto" });
  assert.equal(result.candidates.length, 8);
  assert.deepEqual(new Set(result.candidates.map((item) => item.locale)), new Set(["ja-JP", "ko-KR", "zh-Hant-TW", "th-TH"]));
  assert.equal(result.sheets[0].sourceColumn, 1);
  assert.equal(result.sheets[0].targetColumns["ko-KR"], 3);
});

test("重复对照合并，完整句子进入复核而不是直接入库", async () => {
  const base64 = await workbookBase64([
    ["中文", "日语"],
    ["高级通行证", "プレミアムパス"],
    ["高级通行证", "プレミアムパス"],
    ["维护将于明日上午十点开始，请提前退出游戏。", "メンテナンスは明日午前10時に開始します。事前にゲームを終了してください。"]
  ]);
  const result = await extractTermPairs({ filename: "日语.csv.xlsx", base64, locale: "ja-JP" });
  const term = result.candidates.find((item) => item.source === "高级通行证");
  const sentence = result.candidates.find((item) => item.source.startsWith("维护将于"));
  assert.equal(term.occurrences, 2);
  assert.notEqual(sentence.decision, "ready");
  assert.ok(sentence.reasons.some((reason) => reason.includes("完整句子") || reason.includes("标点")));
});

test("AI 决策只能调整候选结论，不改写中外文本", () => {
  const candidates = [{ source: "高级通行证", target: "プレミアムパス", locale: "ja-JP", score: 0.8, decision: "ready", reasons: [] }];
  const reviewed = applyModelDecisions(candidates, [{ index: 0, keep: false, confidence: 0.92, reason: "测试排除" }]);
  assert.equal(reviewed[0].source, candidates[0].source);
  assert.equal(reviewed[0].target, candidates[0].target);
  assert.equal(reviewed[0].decision, "excluded");
});
