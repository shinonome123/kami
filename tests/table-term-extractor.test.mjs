import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { applyModelDecisions, classifyImportCandidate, expandNestedTermCandidates, extractTermPairs, inferSheetMode, validateNestedTerms } from "../src/table-term-extractor.mjs";

async function workbookBase64(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("术语表");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
}

test("自动识别同表中的日韩繁法泰列并保持目标语言分组", async () => {
  const base64 = await workbookBase64([
    ["中文", "日语", "韩语", "繁體中文", "法语", "泰语"],
    ["高级通行证", "プレミアムパス", "프리미엄 패스", "高級通行證", "Pass Premium", "บัตรผ่านพรีเมียม"],
    ["维护", "メンテナンス", "점검", "維護", "maintenance", "การบำรุงรักษา"]
  ]);
  const result = await extractTermPairs({ filename: "五语术语.xlsx", base64, locale: "auto" });
  assert.equal(result.candidates.length, 10);
  assert.deepEqual(new Set(result.candidates.map((item) => item.locale)), new Set(["ja-JP", "ko-KR", "zh-Hant-TW", "fr-FR", "th-TH"]));
  assert.equal(result.sheets[0].sourceColumn, 1);
  assert.equal(result.sheets[0].targetColumns["ko-KR"], 3);
  assert.equal(result.sheets[0].targetColumns["fr-FR"], 5);
});

test("重复术语对照合并，完整句子自动分流到翻译记忆", async () => {
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
  assert.equal(sentence.assetType, "memory");
  assert.equal(sentence.decision, "ready");
  assert.ok(sentence.reasons.some((reason) => reason.includes("翻译记忆")));
});

test("无表头表格可采用 AI 结构结论直接识别中外文列", async () => {
  const base64 = await workbookBase64([
    ["海外社媒", "无字符限制", "高级通行证", "プレミアムパス"],
    ["游戏内", "12字符内", "限定徽章", "限定バッジ"]
  ]);
  const result = await extractTermPairs(
    { filename: "无表头.xlsx", base64, locale: "auto" },
    { analyzeStructure: async (snapshot) => ({ sheets: [{ sheet: snapshot.sheets[0].sheet, headerRow: null, sourceColumn: 3, targetColumns: { "ja-JP": 4 } }] }) }
  );
  assert.equal(result.structureAnalysis.used, true);
  assert.equal(result.sheets[0].headerRow, null);
  assert.equal(result.sheets[0].sourceColumn, 3);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((item) => item.source), ["高级通行证", "限定徽章"]);
});

test("AI 决策只能调整候选结论，不改写中外文本", () => {
  const candidates = [{ source: "高级通行证", target: "プレミアムパス", locale: "ja-JP", score: 0.8, decision: "ready", reasons: [] }];
  const reviewed = applyModelDecisions(candidates, [{ index: 0, keep: false, confidence: 0.92, reason: "测试排除" }]);
  assert.equal(reviewed[0].source, candidates[0].source);
  assert.equal(reviewed[0].target, candidates[0].target);
  assert.equal(reviewed[0].decision, "excluded");
});

test("AI 清洗可以逐条修正资产类型、语体、领域与约束级别", () => {
  const candidates = [
    { assetType: "memory", source: "限时七折优惠现已开启！", target: "期間限定30％オフを開催中です！", locale: "ja-JP", contentType: "general", contentTypeSource: "heuristic", score: 0.8, decision: "ready", reasons: [] },
    { assetType: "term", source: "高级通行证", target: "プレミアムパス", locale: "ja-JP", contentType: "general", domain: "game", enforcement: "preferred", score: 0.8, decision: "ready", reasons: [] }
  ];
  const reviewed = applyModelDecisions(candidates, [
    { index: 0, keep: true, confidence: 0.95, contentType: "marketing", reason: "宣发文案" },
    { index: 1, keep: true, confidence: 0.95, assetType: "term", contentType: "marketing", domain: "game", enforcement: "required", reason: "官方固定名称" }
  ]);
  assert.equal(reviewed[0].contentType, "marketing");
  assert.equal(reviewed[0].contentTypeSource, "ai");
  assert.equal(reviewed[1].contentType, "general");
  assert.equal(reviewed[1].enforcement, "required");
  assert.equal(reviewed[1].domain, "game");
});

test("本地回退也会给每条候选生成安全的零设置分类", () => {
  const term = classifyImportCandidate({ assetType: "term", source: "高级通行证", target: "プレミアムパス", score: 0.94, reasons: [] });
  const announcement = classifyImportCandidate({ assetType: "memory", source: "维护将于明日上午十点开始，请提前退出游戏。", target: "メンテナンスは明日午前10時に開始します。", score: 0.8, reasons: [] });
  assert.deepEqual({ type: term.assetType, contentType: term.contentType, domain: term.domain, enforcement: term.enforcement }, { type: "term", contentType: "item_name", domain: "game", enforcement: "required" });
  assert.equal(announcement.contentType, "announcement");
  assert.equal(announcement.domain, "game");
  assert.equal(announcement.enforcement, "preferred");
  const dialogue = classifyImportCandidate({ assetType: "memory", sheetMode: "dialogue", sheetModeConfidence: 0.96, source: "高级通行证现已开放。", target: "プレミアムパスが開放された。", score: 0.8, reasons: [] });
  assert.equal(dialogue.contentType, "dialogue");
});

test("工作表模式和中文源文决定父资产类型，目标语言长度不会造成跨语言漂移", async () => {
  const base64 = await workbookBase64([
    ["中文", "日语", "韩语", "繁體中文", "泰语"],
    ["八戒，是哪一根？", "八戒よ、どれだ？", "팔계야, 어느 것이냐?", "八戒，是哪一根？", "โป๊ยก่ายเอ๋ย สิ่งนั้นคือสิ่งใดกันแน่หรือ ขอให้เจ้าบอกข้ามาโดยเร็ว"]
  ]);
  const result = await extractTermPairs({ filename: "Epilogue 台词.xlsx", base64, locale: "auto" });
  assert.equal(result.fileMode, "dialogue");
  assert.deepEqual(new Set(result.candidates.map((item) => item.assetType)), new Set(["memory"]));
  assert.deepEqual(new Set(result.candidates.map((item) => item.sheetMode)), new Set(["dialogue"]));
});

test("术语表中的独立短词仍为术语，混合表仅按中文源文分流", () => {
  assert.equal(inferSheetMode({ sheet: "角色术语表", sources: ["孙悟空", "水帘洞"] }).mode, "glossary");
  assert.equal(inferSheetMode({ sheet: "剧情对白", sources: ["走！", "孙悟空，早就死了！"] }).mode, "dialogue");
  assert.equal(inferSheetMode({ sheet: "Sheet1", sources: ["孙悟空", "孙悟空，早就死了！"] }).mode, "mixed");
});

test("AI 句内术语只接受原句精确子串和受控类别", () => {
  const parent = {
    assetType: "memory",
    source: "孙悟空，回水帘洞去吧！",
    target: "孫悟空よ、水簾洞へ戻れ！"
  };
  const nested = validateNestedTerms(parent, [
    { source: "孙悟空", target: "孫悟空", category: "character_name", confidence: 0.98, enforcement: "required", reason: "角色专名" },
    { source: "水帘洞", target: "水簾洞", category: "place_name", confidence: 0.97, enforcement: "required", reason: "地点专名" },
    { source: "回去吧", target: "戻れ", category: "ordinary_phrase", confidence: 0.99, reason: "普通表达" },
    { source: "天命人", target: "天命人", category: "lore_concept", confidence: 0.99, reason: "模型幻觉" },
    { source: "孙悟空，回水帘洞去吧！", target: "孫悟空よ、水簾洞へ戻れ！", category: "fixed_ui_label", confidence: 0.99, reason: "整句不是术语" }
  ]);
  assert.deepEqual(nested.map((item) => item.source), ["孙悟空", "水帘洞"]);
});

test("AI 决策保留对白父 memory，并附着已验证的 nestedTerms", () => {
  const candidates = [{
    candidateKey: "dialogue:1:ja-JP",
    sheetMode: "dialogue",
    assetType: "memory",
    rowKind: "memory",
    source: "孙悟空，早就死了！",
    target: "孫悟空は、もう死んだのだ！",
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    enforcement: "preferred",
    score: 0.8,
    decision: "ready",
    reasons: []
  }];
  const reviewed = applyModelDecisions(candidates, [{
    index: 0,
    keep: true,
    confidence: 0.98,
    rowKind: "term",
    contentType: "item_name",
    domain: "game",
    reason: "对白父句",
    nestedTerms: [{ source: "孙悟空", target: "孫悟空", category: "character_name", enforcement: "required", confidence: 0.98, reason: "角色专名" }]
  }]);
  assert.equal(reviewed[0].assetType, "memory");
  assert.equal(reviewed[0].contentType, "dialogue");
  assert.equal(reviewed[0].nestedTerms.length, 1);
  assert.equal(reviewed.appliedCount, 1);
  assert.deepEqual(reviewed.missing, []);
});

test("不完整 AI decisions 明确报告覆盖数与缺失 index", () => {
  const candidates = [
    { assetType: "term", source: "孙悟空", target: "孫悟空", score: 0.8, decision: "ready", reasons: [] },
    { assetType: "term", source: "水帘洞", target: "水簾洞", score: 0.8, decision: "ready", reasons: [] }
  ];
  const reviewed = applyModelDecisions(candidates, [{ index: 0, keep: true, confidence: 0.9, reason: "已审核" }]);
  assert.equal(reviewed.appliedCount, 1);
  assert.deepEqual(reviewed.missing, [1]);
  assert.equal(reviewed[1], candidates[1]);
});

test("句内术语展开为独立候选，跨父句去重并保留全部证据", () => {
  const parents = [1, 2].map((rowNumber) => ({
    candidateKey: `dialogue:${rowNumber}:ja-JP`,
    sheet: "对白",
    sheetMode: "dialogue",
    rowNumber,
    locale: "ja-JP",
    assetType: "memory",
    decision: "ready",
    domain: "game",
    source: rowNumber === 1 ? "孙悟空回到了水帘洞。" : "水帘洞中不见孙悟空。",
    target: rowNumber === 1 ? "孫悟空は水簾洞へ戻った。" : "水簾洞に孫悟空の姿はない。",
    nestedTerms: [{ source: "孙悟空", target: "孫悟空", category: "character_name", enforcement: "required", confidence: 0.93, reason: "角色专名" }]
  }));
  const [term] = expandNestedTermCandidates(parents);
  assert.equal(term.candidateRole, "embedded_term");
  assert.equal(term.candidateOrigin, "ai-term-extraction");
  assert.equal(term.extractionConfidence, 0.93);
  assert.deepEqual(term.sourceSpan, { start: 0, end: 3, text: "孙悟空" });
  assert.deepEqual(term.targetSpan, { start: 0, end: 3, text: "孫悟空" });
  assert.equal(term.assetType, "term");
  assert.equal(term.occurrences, 2);
  assert.equal(term.parentEvidence.length, 2);
  assert.equal(term.decision, "ready");
  assert.equal(parents[0].assetType, "memory");
});
