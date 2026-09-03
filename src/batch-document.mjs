import { extname, basename } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { csvValues, parseCsvDocument, replaceCsvCells } from "./csv-document.mjs";
import { buildSpreadsheetSnapshot, describeSpreadsheetAnalysis, inferSpreadsheetStructure, mergeSpreadsheetAnalysis } from "./spreadsheet-structure.mjs";

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".docx", ".xlsx", ".csv"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SEGMENTS = 2_000;

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function decodeBase64(value) {
  const compact = String(value || "").replace(/^data:[^;]+;base64,/, "");
  if (!compact) fail("文件内容为空");
  const buffer = Buffer.from(compact, "base64");
  if (!buffer.length) fail("文件内容无法读取");
  if (buffer.length > MAX_FILE_BYTES) fail("文件超过 10MB 限制", 413);
  return buffer;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function encodeXml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function segmentLongText(value, segmentationMode = "sentence") {
  const text = String(value || "").trim();
  if (!text) return [];
  if (segmentationMode === "paragraph") return [text];
  return [...new Intl.Segmenter("zh", { granularity: "sentence" }).segment(text)].map((item) => item.segment.trim()).filter(Boolean);
}

function createCollector(segmentationMode) {
  const segments = [];
  const add = (source, locator, context = {}) => {
    const split = segmentLongText(source, segmentationMode);
    const ids = split.map((text) => {
      if (segments.length >= MAX_SEGMENTS) fail(`分段超过 ${MAX_SEGMENTS} 段，请拆分文件后重试`, 413);
      const id = `seg-${segments.length + 1}`;
      segments.push({ id, index: segments.length + 1, source: text, locator, context, selected: true });
      return id;
    });
    return ids;
  };
  return { segments, add };
}

function preparePlainText(text, filename, segmentationMode) {
  const collector = createCollector(segmentationMode);
  const pieces = [];
  for (const token of String(text || "").replace(/^\uFEFF/, "").split(/(\r?\n+)/)) {
    if (!token) continue;
    if (/^\r?\n/.test(token) || !token.trim()) {
      pieces.push({ type: "text", value: token });
      continue;
    }
    const leading = token.match(/^\s*/)?.[0] || "";
    const trailing = token.match(/\s*$/)?.[0] || "";
    if (leading) pieces.push({ type: "text", value: leading });
    for (const id of collector.add(token.trim(), { type: "text" })) pieces.push({ type: "segment", id });
    if (trailing) pieces.push({ type: "text", value: trailing });
  }
  return { format: extname(filename).toLowerCase() === ".md" ? "markdown" : "text", segments: collector.segments, structure: { pieces } };
}

async function prepareDocx(buffer, segmentationMode) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) fail("DOCX 缺少 word/document.xml，文件可能已损坏");
  const xml = await entry.async("string");
  const collector = createCollector(segmentationMode);
  const paragraphs = [];
  let paragraphIndex = 0;
  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const paragraphXml = match[0];
    const source = [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => decodeXml(item[1])).join("").trim();
    if (source) {
      const segmentIds = collector.add(source, { type: "docx-paragraph", paragraphIndex });
      paragraphs.push({ paragraphIndex, segmentIds });
    }
    paragraphIndex += 1;
  }
  return { format: "docx", segments: collector.segments, structure: { paragraphs } };
}

function excelCellText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value.richText)) return value.richText.map((item) => item.text).join("").trim();
  if (value.result != null) return String(value.result).trim();
  if (value.text != null) return String(value.text).trim();
  return String(cell.text || "").trim();
}

async function prepareSpreadsheet(workbook, segmentationMode, analyzeSpreadsheet, format = "xlsx") {
  const snapshot = buildSpreadsheetSnapshot(workbook, excelCellText);
  const ruleAnalysis = inferSpreadsheetStructure(snapshot, { allowSingleColumnHeader: format === "csv" });
  let analysis = ruleAnalysis;
  let fallbackReason = "";
  if (analyzeSpreadsheet) {
    try {
      const modelAnalysis = await analyzeSpreadsheet(snapshot, ruleAnalysis);
      analysis = mergeSpreadsheetAnalysis(snapshot, ruleAnalysis, modelAnalysis);
      fallbackReason = analysis.usedModel ? "" : analysis.fallbackReason || "AI 未返回有效识别结果";
    } catch (error) {
      fallbackReason = error.message;
      analysis = { ...ruleAnalysis, fallbackReason };
    }
  }
  const collector = createCollector(segmentationMode);
  const cells = [];
  workbook.eachSheet((worksheet) => {
    const sheetAnalysis = analysis.sheets.find((sheet) => sheet.sheet === worksheet.name);
    if (!sheetAnalysis) return;
    const roles = new Map(sheetAnalysis.columns.map((column) => [column.column, column]));
    const sourceColumns = sheetAnalysis.columns.filter((column) => column.role === "source_text").map((column) => column.column);
    worksheet.eachRow((row) => {
      if (sheetAnalysis.headerRow && row.number === sheetAnalysis.headerRow) return;
      const metadata = [];
      const references = [];
      for (const column of sheetAnalysis.columns) {
        if (column.role === "source_text" || column.role === "ignore") continue;
        const value = excelCellText(row.getCell(column.column));
        if (!value) continue;
        const item = { label: column.label || `${column.letter}列`, value, role: column.role };
        if (column.role === "existing_translation") references.push(item);
        else metadata.push(item);
      }
      for (const columnNumber of sourceColumns) {
        const cell = row.getCell(columnNumber);
        const source = excelCellText(cell);
        if (!source || !/[\p{Script=Han}]/u.test(source)) continue;
        if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(source)) continue;
        const column = roles.get(columnNumber);
        const context = {
          sheet: worksheet.name,
          row: row.number,
          sourceColumn: column?.label || `第 ${columnNumber} 列`,
          metadata,
          referenceTranslations: references
        };
        const locator = { type: `${format}-cell`, sheet: worksheet.name, address: cell.address, row: row.number, column: columnNumber };
        const segmentIds = collector.add(source, locator, context);
        cells.push({ sheet: worksheet.name, address: cell.address, row: row.number, column: columnNumber, segmentIds });
      }
    });
  });
  return {
    format,
    segments: collector.segments,
    structure: { cells },
    spreadsheetAnalysis: {
      source: analysis.usedModel ? "model" : "rules",
      usedModel: Boolean(analysis.usedModel),
      fallbackReason,
      sheets: describeSpreadsheetAnalysis(analysis)
    }
  };
}

async function prepareXlsx(buffer, segmentationMode, analyzeSpreadsheet) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return prepareSpreadsheet(workbook, segmentationMode, analyzeSpreadsheet, "xlsx");
}

async function prepareCsv(buffer, segmentationMode, analyzeSpreadsheet) {
  const document = parseCsvDocument(buffer.toString("utf8"));
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("CSV");
  for (const row of csvValues(document)) worksheet.addRow(row);
  const prepared = await prepareSpreadsheet(workbook, segmentationMode, analyzeSpreadsheet, "csv");
  return {
    ...prepared,
    structure: {
      ...prepared.structure,
      csv: { delimiter: document.delimiter, bom: document.bom, rows: document.rows.length }
    }
  };
}

export async function prepareBatchDocument(input = {}, options = {}) {
  const filename = String(input.filename || (input.text ? "粘贴长文.txt" : "")).trim();
  const extension = extname(filename).toLowerCase();
  if (!filename || !SUPPORTED_EXTENSIONS.has(extension)) fail("仅支持 .txt、.md、.docx、.xlsx、.csv 文件");
  const segmentationMode = input.segmentationMode === "paragraph" ? "paragraph" : "sentence";
  let prepared;
  if (extension === ".txt" || extension === ".md") {
    const text = input.text !== undefined ? String(input.text) : decodeBase64(input.base64).toString("utf8");
    prepared = preparePlainText(text, filename, segmentationMode);
  } else if (extension === ".docx") prepared = await prepareDocx(decodeBase64(input.base64), segmentationMode);
  else if (extension === ".csv") {
    const buffer = input.text !== undefined ? Buffer.from(String(input.text), "utf8") : decodeBase64(input.base64);
    prepared = await prepareCsv(buffer, segmentationMode, options.analyzeSpreadsheet);
  } else prepared = await prepareXlsx(decodeBase64(input.base64), segmentationMode, options.analyzeSpreadsheet);
  if (!prepared.segments.length) fail("没有找到可翻译的中文内容");
  return {
    filename,
    segmentationMode,
    ...prepared,
    statistics: {
      segments: prepared.segments.length,
      characters: prepared.segments.reduce((sum, segment) => sum + Array.from(segment.source).length, 0)
    }
  };
}

function translationMap(segments = []) {
  return new Map(segments.map((segment) => [segment.id, segment.selected === false ? segment.source : (String(segment.translation || "").trim() || segment.source)]));
}

function translatedGroup(ids, translations) {
  return ids.map((id) => translations.get(id) || "").join("");
}

function outputName(filename, locale, extension = extname(filename)) {
  const stem = basename(filename, extname(filename));
  return `${stem}.${String(locale || "translated").replace(/[^a-zA-Z0-9-]/g, "-")}${extension}`;
}

export async function exportBatchDocument(input = {}) {
  const format = String(input.format || "");
  const translations = translationMap(input.segments);
  if (!translations.size) fail("没有可导出的分段");
  let buffer;
  let mimeType;
  let extension;

  if (format === "task-xlsx") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("翻译任务");
    worksheet.columns = [
      { header: "序号", key: "index", width: 9 },
      { header: "中文原文", key: "source", width: 54 },
      { header: "译文", key: "translation", width: 54 },
      { header: "状态", key: "status", width: 14 },
      { header: "AIQA 分数", key: "score", width: 13 },
      { header: "QA 意见", key: "issues", width: 58 },
      { header: "人工决定", key: "decisions", width: 34 }
    ];
    (input.segments || []).filter((segment) => segment.selected !== false).forEach((segment, index) => {
      const result = segment.result || {};
      worksheet.addRow({
        index: index + 1,
        source: segment.source || "",
        translation: segment.translation || "",
        status: segment.status === "done" ? "已翻译" : segment.status === "error" ? "失败" : "待处理",
        score: Number.isFinite(result.qaScore) ? result.qaScore : "",
        issues: (result.issues || []).map((issue) => issue.message || issue.suggestion || issue.type).filter(Boolean).join("\n"),
        decisions: (result.aiQa?.humanDecisions || []).map((item) => `${item.decision === "approved_as_is" ? "批准当前译文" : "要求 AI 修订"}：${item.issue?.message || item.reason || ""}`).join("\n")
      });
    });
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF123E31" } };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: "top", wrapText: true };
      if (rowNumber > 1) row.height = 42;
    });
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = ".xlsx";
  } else if (format === "text" || format === "markdown") {
    const content = (input.structure?.pieces || []).map((piece) => piece.type === "segment" ? (translations.get(piece.id) || "") : String(piece.value || "")).join("");
    buffer = Buffer.from(content, "utf8");
    mimeType = format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
    extension = format === "markdown" ? ".md" : ".txt";
  } else if (format === "docx") {
    const zip = await JSZip.loadAsync(decodeBase64(input.base64));
    const entry = zip.file("word/document.xml");
    if (!entry) fail("DOCX 缺少 word/document.xml");
    const replacements = new Map((input.structure?.paragraphs || []).map((item) => [item.paragraphIndex, translatedGroup(item.segmentIds, translations)]));
    let paragraphIndex = 0;
    const xml = (await entry.async("string")).replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
      const replacement = replacements.get(paragraphIndex++);
      if (replacement === undefined) return paragraph;
      let used = false;
      return paragraph.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, attributes = "") => {
        const content = used ? "" : encodeXml(replacement);
        used = true;
        return `<w:t${attributes}>${content}</w:t>`;
      });
    });
    zip.file("word/document.xml", xml);
    buffer = await zip.generateAsync({ type: "nodebuffer" });
    mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    extension = ".docx";
  } else if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(decodeBase64(input.base64));
    for (const item of input.structure?.cells || []) {
      const worksheet = workbook.getWorksheet(item.sheet);
      if (worksheet) worksheet.getCell(item.address).value = translatedGroup(item.segmentIds, translations);
    }
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = ".xlsx";
  } else if (format === "csv") {
    const original = input.text !== undefined ? String(input.text) : decodeBase64(input.base64).toString("utf8");
    const document = parseCsvDocument(original, { delimiter: input.structure?.csv?.delimiter });
    const replacements = (input.structure?.cells || []).map((item) => ({
      row: Number(item.row),
      column: Number(item.column),
      value: translatedGroup(item.segmentIds, translations)
    })).filter((item) => Number.isInteger(item.row) && item.row > 0 && Number.isInteger(item.column) && item.column > 0);
    buffer = Buffer.from(replaceCsvCells(document, replacements), "utf8");
    mimeType = "text/csv; charset=utf-8";
    extension = ".csv";
  } else fail("不支持的导出格式");

  return {
    filename: outputName(input.filename || `translated${extension}`, input.locale, extension),
    mimeType,
    base64: buffer.toString("base64"),
    bytes: buffer.length
  };
}
