import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { extname } from "node:path";
import { LOCALES, assertLocale } from "./config.mjs";

const HEADER_SCAN_LIMIT = 12;
const MAX_ROWS = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

function quality(source, target, locale) {
  const reasons = [];
  let score = 0.42;
  const sourceLength = [...source].length;
  const targetLength = [...target].length;
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
  score = Math.max(0, Math.min(0.99, score));
  return {
    score: Number(score.toFixed(2)),
    decision: score >= 0.74 ? "ready" : score >= 0.48 ? "review" : "excluded",
    reasons
  };
}

function extractWorksheet(worksheet, requestedLocale) {
  const header = findHeader(worksheet, requestedLocale);
  const mapping = inferColumns(worksheet, header, requestedLocale);
  if (!mapping.sourceColumn || !Object.keys(mapping.targetColumns).length) return null;
  const raw = [];
  for (let rowNumber = mapping.startRow; rowNumber <= Math.min(worksheet.rowCount, MAX_ROWS); rowNumber += 1) {
    const source = compact(cellText(worksheet.getRow(rowNumber).getCell(mapping.sourceColumn)));
    if (!source) continue;
    for (const [locale, column] of Object.entries(mapping.targetColumns)) {
      const target = compact(cellText(worksheet.getRow(rowNumber).getCell(column)));
      if (!target) continue;
      raw.push({ locale, source, target, rowNumber, ...quality(source, target, locale) });
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
    candidates
  };
}

export async function extractTermPairs({ filename, base64, locale = "auto" }) {
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
  const sheets = workbook.worksheets.map((worksheet) => extractWorksheet(worksheet, requestedLocale)).filter(Boolean);
  const candidates = sheets.flatMap((sheet) => sheet.candidates);
  if (!candidates.length) {
    const error = new Error("没有识别到中外文对照列；请使用带“中文/日语/韩语/繁中/泰语”表头的表格，或指定目标语言");
    error.statusCode = 422;
    throw error;
  }
  return {
    filename: String(filename),
    fileType: extension.slice(1),
    requestedLocale: requestedLocale || "auto",
    sheets: sheets.map(({ candidates: ignored, ...sheet }) => ({ ...sheet, candidateCount: ignored.length })),
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

export function applyModelDecisions(candidates, decisions = []) {
  const byIndex = new Map(decisions.map((decision) => [Number(decision.index), decision]));
  return candidates.map((candidate, index) => {
    const model = byIndex.get(index);
    if (!model) return candidate;
    const confidence = Math.max(0, Math.min(1, Number(model.confidence) || 0));
    return {
      ...candidate,
      score: Number(((candidate.score + confidence) / 2).toFixed(2)),
      decision: model.keep ? (confidence >= 0.75 && candidate.decision !== "excluded" ? "ready" : "review") : "excluded",
      reasons: [...candidate.reasons, `AI：${compact(model.reason || (model.keep ? "建议保留" : "建议排除"))}`]
    };
  });
}
