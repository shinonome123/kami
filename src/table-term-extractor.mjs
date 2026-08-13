import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { extname } from "node:path";
import { CONTENT_TYPES, LOCALES, assertLocale } from "./config.mjs";
import { classifyContent } from "./classifier.mjs";

const HEADER_SCAN_LIMIT = 12;
const MAX_ROWS = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DOMAINS = new Set(["game", "marketing", "community", "general"]);
const ENFORCEMENTS = new Set(["required", "preferred"]);
const SHEET_MODES = new Set(["dialogue", "glossary", "mixed"]);
const TERM_CATEGORIES = new Set([
  "proper_name",
  "character_name",
  "place_name",
  "item_name",
  "skill_name",
  "system_name",
  "organization_name",
  "species_name",
  "currency_name",
  "lore_concept",
  "fixed_ui_label"
]);
const PROPER_NAME_CATEGORIES = new Set(["proper_name", "character_name", "place_name", "organization_name"]);

const SOURCE_HEADERS = ["中文", "简中", "简体中文", "简体", "zh-cn", "zh_cn", "源文", "原文", "source", "source text"];
const TARGET_HEADERS = Object.freeze({
  "ja-JP": ["日语", "日文", "日本语", "日本語", "ja", "ja-jp", "japanese"],
  "ko-KR": ["韩语", "韩文", "韓語", "한국어", "ko", "ko-kr", "korean"],
  "zh-Hant-TW": ["繁中", "繁体", "繁體", "繁体中文", "繁體中文", "台湾", "臺灣", "zh-tw", "zh-hant", "zh-hant-tw"],
  "th-TH": ["泰语", "泰文", "ภาษาไทย", "th", "th-th", "thai"]
});

function compact(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function stableKey(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizedHeader(value) {
  return compact(value).toLowerCase().replace(/[\s_（）()【】\[\]·/\\]+/g, "");
}

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return compact(value);
  if (Array.isArray(value.richText)) return compact(value.richText.map((part) => part.text).join(""));
  if (value.result != null) return compact(value.result);
  if (value.text != null) return compact(value.text);
  if (value.hyperlink != null) return compact(value.text || value.hyperlink);
  return compact(cell.text || "");
}

function headerMatches(value, aliases) {
  const header = normalizedHeader(value);
  return aliases.some((alias) => {
    const candidate = normalizedHeader(alias);
    return header === candidate || (candidate.length >= 2 && header.includes(candidate));
  });
}

function containsHan(value) {
  return /[\p{Script=Han}]/u.test(value);
}

function scriptScore(value, locale) {
  const text = compact(value);
  if (!text) return 0;
  if (locale === "ko-KR") return /[\p{Script=Hangul}]/u.test(text) ? 1 : 0;
  if (locale === "th-TH") return /[\p{Script=Thai}]/u.test(text) ? 1 : 0;
  if (locale === "ja-JP") return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 1 : 0;
  if (locale === "zh-Hant-TW") return containsHan(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(text) ? 0.55 : 0;
  return 0;
}

function sourceScore(value) {
  const text = compact(value);
  if (!text || !containsHan(text)) return 0;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(text)) return 0.1;
  return 0.8;
}

function rowValues(worksheet, rowNumber) {
  const row = worksheet.getRow(rowNumber);
  const values = [];
  for (let column = 1; column <= worksheet.columnCount; column += 1) values.push(cellText(row.getCell(column)));
  return values;
}

function findHeader(worksheet, requestedLocale) {
  let best = null;
  for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_LIMIT, worksheet.rowCount); rowNumber += 1) {
    const values = rowValues(worksheet, rowNumber);
    const sourceColumn = values.findIndex((value) => headerMatches(value, SOURCE_HEADERS));
    const targetColumns = {};
    for (const [locale, aliases] of Object.entries(TARGET_HEADERS)) {
      const index = values.findIndex((value) => headerMatches(value, aliases));
      if (index >= 0 && (!requestedLocale || requestedLocale === locale)) targetColumns[locale] = index + 1;
    }
    const score = (sourceColumn >= 0 ? 4 : 0) + Object.keys(targetColumns).length * 4 + values.filter(Boolean).length * 0.05;
    if (!best || score > best.score) best = { rowNumber, sourceColumn: sourceColumn + 1, targetColumns, score, values };
  }
  return best;
}

function inferColumns(worksheet, header, requestedLocale) {
  const startRow = header?.score >= 4 ? header.rowNumber + 1 : 1;
  const sampleEnd = Math.min(worksheet.rowCount, startRow + 40);
  const columns = Array.from({ length: worksheet.columnCount }, (_, index) => index + 1);
  const sourceColumn = header?.sourceColumn || columns
    .map((column) => ({ column, score: averageColumnScore(worksheet, column, startRow, sampleEnd, sourceScore) }))
    .sort((a, b) => b.score - a.score)[0]?.column;
  const targetColumns = { ...(header?.targetColumns || {}) };
  const locales = requestedLocale ? [assertLocale(requestedLocale)] : Object.keys(LOCALES);
  for (const locale of locales) {
    if (targetColumns[locale]) continue;
    const best = columns
      .filter((column) => column !== sourceColumn && !Object.values(targetColumns).includes(column))
      .map((column) => ({ column, score: averageColumnScore(worksheet, column, startRow, sampleEnd, (value) => scriptScore(value, locale)) }))
      .sort((a, b) => b.score - a.score)[0];
    const threshold = locale === "zh-Hant-TW" ? 0.28 : 0.2;
    if (best?.score >= threshold) targetColumns[locale] = best.column;
  }
  if (requestedLocale && !targetColumns[requestedLocale]) {
    const fallback = columns.find((column) => column !== sourceColumn);
    if (fallback) targetColumns[requestedLocale] = fallback;
  }
  return { startRow, sourceColumn, targetColumns };
}

function averageColumnScore(worksheet, column, startRow, endRow, scorer) {
  const values = [];
  for (let row = startRow; row <= endRow; row += 1) {
    const value = cellText(worksheet.getRow(row).getCell(column));
    if (value) values.push(scorer(value));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sourceLooksSentence(source) {
  const text = compact(source);
  if (!text) return false;
  if (/[，。！？!?；;：:]/u.test(text)) return true;
  if ([...text].length >= 18) return true;
  return [...text].length >= 8 && /(?:已经|正在|将要|应该|可以|不能|不会|不要|没有|不是|就是|如果|因为|所以|但是|然后|还是|便是|乃是|只要|之后|以前|如今|今日|明日|我们|你们|他们|这里|那里|回来|出去|知道|觉得|看来|说道|问道|为何|怎么|什么|谁|呢|吗|吧|啊|哩|了|着|过)$/u.test(text);
}

export function inferSheetMode({ filename = "", sheet = "", headerValues = [], sources = [], modelMode = "" } = {}) {
  if (SHEET_MODES.has(String(modelMode))) {
    return { mode: String(modelMode), confidence: 0.95, source: "model", reason: "采用 AI 表格结构分析给出的工作表类型" };
  }
  const identity = `${filename} ${sheet} ${(headerValues || []).join(" ")}`.toLowerCase();
  const usable = (sources || []).map(compact).filter(Boolean);
  if (!usable.length) return { mode: "mixed", confidence: 0.5, source: "rules", reason: "没有足够源文样本" };
  const sentenceRatio = usable.filter(sourceLooksSentence).length / usable.length;
  const terseRatio = usable.filter((source) => [...source].length <= 10 && !/[，。！？!?；;：:]/u.test(source)).length / usable.length;
  if (/(dialogue|dialog|conversation|subtitle|cutscene|story|plot|scenario|epilogue|prologue|对白|对话|台词|字幕|剧情|剧本|结局|序章|终章)/iu.test(identity)) {
    return { mode: "dialogue", confidence: 0.96, source: "rules", reason: "工作表名称或表头表明内容为剧情对白" };
  }
  if (/(glossary|terminology|term(?:s)?|dictionary|lexicon|术语|词汇|词典|名词表|命名表)/iu.test(identity) && terseRatio >= 0.65 && sentenceRatio <= 0.25) {
    return { mode: "glossary", confidence: 0.96, source: "rules", reason: "工作表名称或表头表明内容为术语表" };
  }
  if (sentenceRatio >= 0.55) return { mode: "dialogue", confidence: Math.min(0.92, 0.62 + sentenceRatio * 0.3), source: "rules", reason: `中文源文中完整句比例为 ${Math.round(sentenceRatio * 100)}%` };
  if (terseRatio >= 0.8 && sentenceRatio <= 0.12) return { mode: "glossary", confidence: Math.min(0.9, 0.58 + terseRatio * 0.32), source: "rules", reason: `中文源文中短词条比例为 ${Math.round(terseRatio * 100)}%` };
  return { mode: "mixed", confidence: 0.7, source: "rules", reason: "工作表同时包含短词条与完整句段" };
}

export function classifySourceRow(source, sheetMode = "mixed") {
  const text = compact(source);
  if (!text || /^(?:https?:\/\/|www\.)/iu.test(text) || /^[\d\s%+_.:/-]+$/u.test(text)) return "invalid";
  if (sheetMode === "dialogue") return "memory";
  if (sheetMode === "glossary") return sourceLooksSentence(text) ? "memory" : "term";
  return sourceLooksSentence(text) ? "memory" : "term";
}

function quality(source, target, locale, sheetMode = "mixed") {
  const reasons = [];
  let score = 0.42;
  const sourceLength = [...source].length;
  const targetLength = [...target].length;
  const rowKind = classifySourceRow(source, sheetMode);
  const sentenceLike = rowKind === "memory";
  if (sourceLength >= 2 && sourceLength <= 18) score += 0.22;
  else if (sourceLength <= 32) score += 0.08;
  else reasons.push("中文较长，可能是完整句子");
  if (targetLength >= 1 && targetLength <= 32) score += 0.16;
  else if (targetLength <= 64) score += 0.05;
  else reasons.push("译文较长，建议人工确认");
  if (scriptScore(target, locale) >= 0.5 || (locale === "zh-Hant-TW" && containsHan(target))) score += 0.14;
  else reasons.push("目标语言文字特征不明显");
  if (/[。！？!?；;：:]|\.{2,}/u.test(source) || /[。！？!?；;]|\.{2,}/u.test(target)) {
    score -= 0.18;
    reasons.push("包含句末或说明性标点");
  }
  if (/^(https?:\/\/|www\.)/i.test(source) || /^(https?:\/\/|www\.)/i.test(target)) {
    score = 0.05;
    reasons.push("网址不是术语");
  }
  if (/^[\d\s%+_.:/-]+$/u.test(source) || /^[\d\s%+_.:/-]+$/u.test(target)) {
    score = 0.08;
    reasons.push("纯数字或符号不是术语");
  }
  if (source === target) {
    score -= 0.25;
    reasons.push("中外文内容相同");
  }
  if (sentenceLike && score > 0.2 && source !== target) {
    const targetScriptValid = scriptScore(target, locale) >= 0.5 || (locale === "zh-Hant-TW" && containsHan(target));
    if (targetScriptValid) {
      score = Math.max(score, 0.78);
      reasons.push("完整双语句段，将沉淀为翻译记忆与风格证据");
    }
  }
  score = Math.max(0, Math.min(0.99, score));
  return {
    assetType: sentenceLike ? "memory" : "term",
    rowKind,
    score: Number(score.toFixed(2)),
    decision: score >= 0.74 ? "ready" : score >= 0.48 ? "review" : "excluded",
    reasons
  };
}

function inferDomain(candidate, contentType) {
  if (contentType === "marketing") return "marketing";
  if (contentType === "social") return "community";
  const text = String(candidate.source || "");
  if (/(社媒|社区|关注|转发|评论|粉丝|直播|discord|twitter|facebook|instagram)/iu.test(text)) return "community";
  if (/(游戏|玩家|通行证|道具|装备|武器|技能|角色|关卡|副本|商城|赛季|客户端|服务器|dlc|playstation|steam|xbox)/iu.test(text)) return "game";
  if (/(促销|折扣|购买|商品|限时|优惠|营销|宣发|预约|发售)/u.test(text)) return "marketing";
  return candidate.assetType === "memory" ? "game" : "general";
}

export function classifyImportCandidate(candidate) {
  const next = { ...candidate };
  if (next.assetType === "memory") {
    const classification = next.sheetMode === "dialogue"
      ? { contentType: "dialogue", confidence: Math.max(0.9, Number(next.sheetModeConfidence) || 0.9), source: next.sheetModeSource || "sheet-mode" }
      : classifyContent(next.source, "auto");
    next.contentType = classification.contentType;
    next.contentTypeConfidence = classification.confidence;
    next.contentTypeSource = classification.source;
    next.domain = inferDomain(next, next.contentType);
    next.enforcement = "preferred";
    next.reasons = [...(next.reasons || []), `自动归类：${CONTENT_TYPES[next.contentType]?.label || next.contentType} / ${next.domain}`];
  } else {
    next.contentType = "general";
    next.contentTypeSource = next.contentTypeSource || "rules";
    next.domain = inferDomain(next, "general");
    next.enforcement = Number(next.score) >= 0.82 ? "required" : "preferred";
    next.reasons = [...(next.reasons || []), `自动归类：术语 / ${next.domain} / ${next.enforcement === "required" ? "强制采用" : "优先参考"}`];
  }
  return next;
}

function analysisMapping(worksheet, analysis, requestedLocale) {
  if (!analysis || String(analysis.sheet || "") !== worksheet.name) return null;
  const sourceColumn = Number(analysis.sourceColumn);
  if (!Number.isInteger(sourceColumn) || sourceColumn < 1 || sourceColumn > worksheet.columnCount) return null;
  const targetColumns = {};
  for (const [locale, rawColumn] of Object.entries(analysis.targetColumns || {})) {
    if (!Object.hasOwn(LOCALES, locale) || (requestedLocale && locale !== requestedLocale)) continue;
    const column = Number(rawColumn);
    if (Number.isInteger(column) && column >= 1 && column <= worksheet.columnCount && column !== sourceColumn) targetColumns[locale] = column;
  }
  if (!Object.keys(targetColumns).length) return null;
  const headerRow = Number(analysis.headerRow);
  return {
    startRow: Number.isInteger(headerRow) && headerRow > 0 ? headerRow + 1 : 1,
    sourceColumn,
    targetColumns
  };
}

function extractWorksheet(worksheet, requestedLocale, modelAnalysis, filename = "") {
  const header = findHeader(worksheet, requestedLocale);
  const ruleMapping = inferColumns(worksheet, header, requestedLocale);
  const modelMapping = analysisMapping(worksheet, modelAnalysis, requestedLocale);
  const mapping = modelMapping || ruleMapping;
  if (!mapping.sourceColumn || !Object.keys(mapping.targetColumns).length) return null;
  const sourceSamples = [];
  for (let rowNumber = mapping.startRow; rowNumber <= Math.min(worksheet.rowCount, MAX_ROWS); rowNumber += 1) {
    const source = compact(cellText(worksheet.getRow(rowNumber).getCell(mapping.sourceColumn)));
    if (source) sourceSamples.push(source);
  }
  const mode = inferSheetMode({
    filename,
    sheet: worksheet.name,
    headerValues: header?.values || [],
    sources: sourceSamples,
    modelMode: modelAnalysis?.sheetMode
  });
  const raw = [];
  for (let rowNumber = mapping.startRow; rowNumber <= Math.min(worksheet.rowCount, MAX_ROWS); rowNumber += 1) {
    const source = compact(cellText(worksheet.getRow(rowNumber).getCell(mapping.sourceColumn)));
    if (!source) continue;
    for (const [locale, column] of Object.entries(mapping.targetColumns)) {
      const target = compact(cellText(worksheet.getRow(rowNumber).getCell(column)));
      if (!target) continue;
      const candidateKey = `${stableKey(worksheet.name)}:${rowNumber}:${locale}:${stableKey(`${source}\u0000${target}`)}`;
      raw.push({
        locale,
        source,
        target,
        sheet: worksheet.name,
        sheetMode: mode.mode,
        sheetModeConfidence: Number(mode.confidence.toFixed(2)),
        sheetModeSource: mode.source,
        candidateKey,
        candidateRole: "full_pair",
        rowNumber,
        ...quality(source, target, locale, mode.mode)
      });
    }
  }
  const deduped = new Map();
  for (const candidate of raw) {
    const key = `${candidate.locale}\u0000${candidate.source.toLocaleLowerCase()}\u0000${candidate.target.toLocaleLowerCase()}`;
    const existing = deduped.get(key);
    if (existing) existing.occurrences += 1;
    else deduped.set(key, { ...candidate, occurrences: 1 });
  }
  const candidates = [...deduped.values()];
  const targetsBySource = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.locale}\u0000${candidate.source.toLocaleLowerCase()}`;
    const targets = targetsBySource.get(key) || new Set();
    targets.add(candidate.target.toLocaleLowerCase());
    targetsBySource.set(key, targets);
  }
  for (const candidate of candidates) {
    const key = `${candidate.locale}\u0000${candidate.source.toLocaleLowerCase()}`;
    if (targetsBySource.get(key).size > 1) {
      candidate.decision = "review";
      candidate.score = Math.min(candidate.score, 0.68);
      candidate.reasons.push("同一中文对应多个译法");
    }
  }
  return {
    sheet: worksheet.name,
    rowsScanned: Math.max(0, Math.min(worksheet.rowCount, MAX_ROWS) - mapping.startRow + 1),
    headerRow: mapping.startRow - 1 || null,
    sourceColumn: mapping.sourceColumn,
    targetColumns: mapping.targetColumns,
    sheetMode: mode.mode,
    sheetModeConfidence: Number(mode.confidence.toFixed(2)),
    sheetModeSource: mode.source,
    sheetModeReason: mode.reason,
    candidates,
    structureSource: modelMapping ? "model" : "rules"
  };
}

function buildStructureSnapshot(workbook) {
  return {
    sheets: workbook.worksheets.map((worksheet) => ({
      sheet: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      rows: Array.from({ length: Math.min(60, worksheet.rowCount) }, (_, index) => {
        const row = index + 1;
        return {
          row,
          cells: rowValues(worksheet, row)
            .map((value, column) => ({ column: column + 1, value: compact(value).slice(0, 500) }))
            .filter((cell) => cell.value)
        };
      }).filter((row) => row.cells.length)
    }))
  };
}

export async function extractTermPairs({ filename, base64, locale = "auto" }, { analyzeStructure } = {}) {
  const extension = extname(String(filename || "")).toLowerCase();
  if (![".xlsx", ".csv"].includes(extension)) {
    const error = new Error("仅支持 .xlsx 和 .csv 表格；旧版 .xls 请先另存为 .xlsx");
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(String(base64 || ""), "base64");
  if (!buffer.length) {
    const error = new Error("上传的表格为空");
    error.statusCode = 400;
    throw error;
  }
  if (buffer.length > MAX_FILE_BYTES) {
    const error = new Error("表格不能超过 10MB");
    error.statusCode = 413;
    throw error;
  }
  const requestedLocale = locale === "auto" ? null : assertLocale(locale);
  const workbook = new ExcelJS.Workbook();
  if (extension === ".csv") await workbook.csv.read(Readable.from([buffer]));
  else await workbook.xlsx.load(buffer);
  const snapshot = buildStructureSnapshot(workbook);
  let structureAnalysis = null;
  let structureFallbackReason = "";
  if (typeof analyzeStructure === "function") {
    try {
      structureAnalysis = await analyzeStructure(snapshot, requestedLocale);
    } catch (error) {
      structureFallbackReason = error.message;
    }
  }
  const analysisBySheet = new Map((structureAnalysis?.sheets || []).map((sheet) => [String(sheet.sheet), sheet]));
  const sheets = workbook.worksheets
    .map((worksheet) => extractWorksheet(worksheet, requestedLocale, analysisBySheet.get(worksheet.name), filename))
    .filter(Boolean);
  const candidates = sheets.flatMap((sheet) => sheet.candidates);
  if (!candidates.length) {
    const error = new Error("没有识别到可用的中外文对照行；请确认表格中至少有一列中文和一列目标语言内容");
    error.statusCode = 422;
    throw error;
  }
  return {
    filename: String(filename),
    fileType: extension.slice(1),
    requestedLocale: requestedLocale || "auto",
    fileMode: new Set(sheets.map((sheet) => sheet.sheetMode)).size === 1 ? sheets[0].sheetMode : "mixed",
    sheets: sheets.map(({ candidates: ignored, ...sheet }) => ({ ...sheet, candidateCount: ignored.length })),
    structureAnalysis: {
      requested: typeof analyzeStructure === "function",
      used: sheets.some((sheet) => sheet.structureSource === "model"),
      fallbackReason: structureFallbackReason
    },
    candidates,
    statistics: {
      rowsScanned: sheets.reduce((sum, sheet) => sum + sheet.rowsScanned, 0),
      candidates: candidates.length,
      ready: candidates.filter((item) => item.decision === "ready").length,
      review: candidates.filter((item) => item.decision === "review").length,
      excluded: candidates.filter((item) => item.decision === "excluded").length
    }
  };
}

function rawDecisionList(decisions) {
  if (Array.isArray(decisions)) return decisions;
  return Array.isArray(decisions?.decisions) ? decisions.decisions : [];
}

export function validateNestedTerms(candidate, nestedTerms = []) {
  if (candidate.assetType !== "memory" || !Array.isArray(nestedTerms)) return [];
  const sourceText = String(candidate.source || "");
  const targetText = String(candidate.target || "");
  const seen = new Set();
  const valid = [];
  for (const raw of nestedTerms.slice(0, 16)) {
    const source = String(raw?.source || "").trim();
    const target = String(raw?.target || "").trim();
    const category = String(raw?.category || "");
    const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
    if (!TERM_CATEGORIES.has(category) || confidence < 0.65) continue;
    if ([...source].length < 2 || !target || source === sourceText || target === targetText) continue;
    if (/[，。！？!?；;：:]/u.test(source) || !sourceText.includes(source) || !targetText.includes(target)) continue;
    const key = `${source}\u0000${target}\u0000${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceStart = sourceText.indexOf(source);
    const targetStart = targetText.indexOf(target);
    valid.push({
      source,
      target,
      category,
      enforcement: ENFORCEMENTS.has(String(raw.enforcement || "")) ? String(raw.enforcement) : (PROPER_NAME_CATEGORIES.has(category) ? "required" : "preferred"),
      confidence: Number(confidence.toFixed(2)),
      sourceSpan: { start: sourceStart, end: sourceStart + source.length, text: source },
      targetSpan: { start: targetStart, end: targetStart + target.length, text: target },
      reason: compact(raw.reason || "AI 从完整句段中识别到可复用术语")
    });
  }
  return valid;
}

export function applyModelDecisions(candidates, decisions = []) {
  const decisionList = rawDecisionList(decisions);
  const byIndex = new Map();
  const invalidIndexes = [];
  for (const decision of decisionList) {
    const index = Number(decision?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || byIndex.has(index)) {
      invalidIndexes.push(decision?.index);
      continue;
    }
    byIndex.set(index, decision);
  }
  let appliedCount = 0;
  const reviewed = candidates.map((candidate, index) => {
    const model = byIndex.get(index);
    if (!model) return candidate;
    appliedCount += 1;
    const confidence = Math.max(0, Math.min(1, Number(model.confidence) || 0));
    const requestedRowKind = String(model.rowKind || model.assetType || "");
    const modelRowKind = ["term", "memory"].includes(requestedRowKind) ? requestedRowKind : candidate.assetType;
    const modelAssetType = candidate.assetType;
    const modelContentType = modelAssetType === "memory" && candidate.sheetMode === "dialogue"
      ? "dialogue"
      : (modelAssetType === "memory" && Object.hasOwn(CONTENT_TYPES, String(model.contentType || "")) ? String(model.contentType) : (modelAssetType === "memory" ? candidate.contentType : "general"));
    const modelDomain = DOMAINS.has(String(model.domain || "")) ? String(model.domain) : candidate.domain;
    const modelEnforcement = modelAssetType === "term" && ENFORCEMENTS.has(String(model.enforcement || "")) ? String(model.enforcement) : (modelAssetType === "term" ? candidate.enforcement : "preferred");
    const next = {
      ...candidate,
      assetType: modelAssetType,
      rowKind: modelAssetType,
      modelRowKind,
      contentType: modelContentType || "general",
      contentTypeSource: Object.hasOwn(model, "contentType") ? "ai" : candidate.contentTypeSource,
      domain: modelDomain || "general",
      enforcement: modelEnforcement,
      score: Number(((candidate.score + confidence) / 2).toFixed(2)),
      decision: model.keep ? (confidence >= 0.75 && candidate.decision !== "excluded" ? "ready" : "review") : "excluded",
      reasons: [...candidate.reasons, `AI：${compact(model.reason || (model.keep ? "建议保留" : "建议排除"))}`]
    };
    next.nestedTerms = validateNestedTerms(next, model.nestedTerms);
    return next;
  });
  const missing = candidates.map((_, index) => index).filter((index) => !byIndex.has(index));
  Object.defineProperties(reviewed, {
    appliedCount: { value: appliedCount, enumerable: false },
    missing: { value: missing, enumerable: false },
    invalidIndexes: { value: invalidIndexes, enumerable: false }
  });
  return reviewed;
}

export function expandNestedTermCandidates(candidates = []) {
  const grouped = new Map();
  for (const parent of candidates) {
    if (parent.assetType !== "memory" || parent.decision === "excluded") continue;
    const nestedTerms = validateNestedTerms(parent, parent.nestedTerms);
    for (const nested of nestedTerms) {
      const key = `${parent.locale}\u0000${nested.source.toLocaleLowerCase()}\u0000${nested.target.toLocaleLowerCase()}`;
      const evidence = {
        parentCandidateKey: parent.candidateKey || `${parent.sheet || "sheet"}:${parent.rowNumber || "?"}:${parent.locale}`,
        parentSource: parent.source,
        parentRowNumber: parent.rowNumber || null,
        sheet: parent.sheet || "",
        sourceSpan: nested.sourceSpan,
        targetSpan: nested.targetSpan
      };
      const current = grouped.get(key);
      if (current) {
        if (!current.parentCandidateKeys.includes(evidence.parentCandidateKey)) {
          current.parentCandidateKeys.push(evidence.parentCandidateKey);
          current.parentEvidence.push(evidence);
          current.occurrences += 1;
        }
        current.score = Math.max(current.score, nested.confidence);
        if (nested.enforcement === "required") current.enforcement = "required";
        continue;
      }
      grouped.set(key, {
        locale: parent.locale,
        source: nested.source,
        target: nested.target,
        assetType: "term",
        rowKind: "term",
        candidateRole: "embedded_term",
        candidateOrigin: "ai-term-extraction",
        candidateKey: `nested:${stableKey(key)}`,
        parentCandidateKey: evidence.parentCandidateKey,
        parentCandidateKeys: [evidence.parentCandidateKey],
        parentSource: evidence.parentSource,
        parentRowNumber: evidence.parentRowNumber,
        parentEvidence: [evidence],
        sheet: parent.sheet || "",
        sheetMode: parent.sheetMode || "mixed",
        rowNumber: parent.rowNumber,
        category: nested.category,
        termCategory: nested.category,
        extractionConfidence: nested.confidence,
        sourceSpan: nested.sourceSpan,
        targetSpan: nested.targetSpan,
        enforcement: nested.enforcement,
        contentType: "general",
        contentTypeSource: "ai-nested-term",
        domain: parent.domain || "general",
        occurrences: 1,
        score: nested.confidence,
        decision: "review",
        reasons: [`句内术语：${nested.reason}`],
        nestedTerms: []
      });
    }
  }
  return [...grouped.values()].map((candidate) => {
    const highConfidenceProperName = PROPER_NAME_CATEGORIES.has(candidate.termCategory) && candidate.score >= 0.94;
    const ready = candidate.occurrences >= 2 || highConfidenceProperName;
    return {
      ...candidate,
      decision: ready ? "ready" : "review",
      reasons: [...candidate.reasons, ready
        ? (candidate.occurrences >= 2 ? `在 ${candidate.occurrences} 个父句中稳定复现` : "高置信专名")
        : "单次句内识别，等待人工确认"]
    };
  });
}
