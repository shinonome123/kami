const COLUMN_ROLES = new Set(["source_text", "context", "constraint", "existing_translation", "ignore"]);
const SOURCE_HEADERS = ["中文", "中文原文", "简中", "简中原文", "简体", "简体中文", "chinese simp", "chinese simplified", "zh-cn", "source", "source text", "原文", "待翻译"];
const CONTEXT_HEADERS = ["位置", "渠道", "平台", "用途", "投放位置", "发布位置", "场景", "备注", "说明", "类型", "content type"];
const CONSTRAINT_HEADERS = ["ddl", "截止", "交付", "字数", "字符", "长度", "语种要求", "语言要求", "要求", "限制", "deadline", "limit", "language requirement"];
const TRANSLATION_HEADERS = ["english", "英文", "日语", "日文", "japanese", "korean", "韩语", "韩文", "繁中", "繁体", "traditional chinese", "thai", "泰语", "译文", "translation"];

function compact(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalize(value) {
  return compact(value).toLowerCase().replace(/[\s_()（）【】\[\]·.\-/\\]+/g, "");
}

function headerMatches(value, aliases) {
  const header = normalize(value);
  return aliases.some((alias) => {
    const candidate = normalize(alias);
    return header === candidate || (candidate.length >= 3 && header.includes(candidate));
  });
}

function containsHan(value) {
  return /[\p{Script=Han}]/u.test(value);
}

function containsOtherAsianScript(value) {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(value);
}

function characterCount(value, expression) {
  return [...String(value || "")].filter((character) => expression.test(character)).length;
}

function looksLikeConstraint(value) {
  const text = compact(value);
  if (!text) return false;
  return /(?:\d+\s*(?:字|字符|词|words?|chars?)|无(?:字数|字符)?限制|(?:中|英|日|韩|繁|泰){1,5}(?:文|语)?|\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|ddl|deadline|北京时间|游戏内语言)/i.test(text);
}

function columnLetter(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function buildSpreadsheetSnapshot(workbook, cellText) {
  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const rows = [];
    const columnCells = new Map();
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        const text = compact(cellText(cell));
        if (!text) return;
        const item = { row: row.number, column, address: cell.address, text: text.slice(0, 700) };
        values.push(item);
        if (!columnCells.has(column)) columnCells.set(column, []);
        columnCells.get(column).push(item);
      });
      if (values.length && rows.length < 80) rows.push({ row: row.number, cells: values });
    });

    const columns = [...columnCells.entries()].map(([column, cells]) => {
      const texts = cells.map((cell) => cell.text);
      const hanCharacters = texts.reduce((sum, text) => sum + characterCount(text, /[\p{Script=Han}]/u), 0);
      const latinCharacters = texts.reduce((sum, text) => sum + characterCount(text, /[A-Za-z]/), 0);
      const constraintCells = texts.filter(looksLikeConstraint).length;
      const sentenceCells = texts.filter((text) => /[。！？!?；;]|\n/.test(text)).length;
      return {
        column,
        letter: columnLetter(column),
        nonEmpty: cells.length,
        averageLength: Math.round(texts.reduce((sum, text) => sum + [...text].length, 0) / Math.max(1, texts.length)),
        hanCharacters,
        latinCharacters,
        constraintCells,
        sentenceCells,
        samples: cells.slice(0, 12)
      };
    });

    sheets.push({
      sheet: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      rows,
      columns
    });
  });
  return { sheets };
}

function headerRole(value) {
  if (headerMatches(value, SOURCE_HEADERS)) return "source_text";
  if (headerMatches(value, TRANSLATION_HEADERS)) return "existing_translation";
  if (headerMatches(value, CONSTRAINT_HEADERS)) return "constraint";
  if (headerMatches(value, CONTEXT_HEADERS)) return "context";
  return null;
}

function findHeaderRow(sheet, options = {}) {
  let best = null;
  for (const row of sheet.rows.filter((item) => item.row <= 12)) {
    const roles = row.cells.map((cell) => headerRole(cell.text)).filter(Boolean);
    const known = roles.length;
    const singleColumnHeader = options.allowSingleColumnHeader && row.cells.length === 1 && known === 1 && ["source_text", "existing_translation"].includes(roles[0]);
    if (known < 2 && !singleColumnHeader) continue;
    const score = known * 4 + Math.min(row.cells.length, 8) - row.row * 0.05;
    if (!best || score > best.score) best = { row: row.row, score, known };
  }
  return best?.row || null;
}

function columnRuleScore(column, headerRow) {
  const body = column.samples.filter((sample) => !headerRow || sample.row !== headerRow);
  const bodyCount = Math.max(1, body.length);
  const hanRatio = body.filter((sample) => containsHan(sample.text) && !containsOtherAsianScript(sample.text)).length / bodyCount;
  const constraintRatio = body.filter((sample) => looksLikeConstraint(sample.text)).length / bodyCount;
  const narrativeRatio = body.filter((sample) => /[。！？!?；;]|\n/.test(sample.text) || [...sample.text].length >= 22).length / bodyCount;
  return hanRatio * 0.44 + Math.min(column.averageLength / 70, 1) * 0.25 + narrativeRatio * 0.31 - constraintRatio * 0.55;
}

export function inferSpreadsheetStructure(snapshot, options = {}) {
  const sheets = snapshot.sheets.map((sheet) => {
    const headerRow = findHeaderRow(sheet, options);
    const header = new Map((sheet.rows.find((row) => row.row === headerRow)?.cells || []).map((cell) => [cell.column, cell.text]));
    const ruleScores = sheet.columns.map((column) => ({ column: column.column, score: columnRuleScore(column, headerRow) }));
    const highestScore = Math.max(0, ...ruleScores.map((item) => item.score));
    const columns = sheet.columns.map((column) => {
      const label = header.get(column.column) || `${column.letter}列`;
      const explicit = headerRole(label);
      if (explicit) return { column: column.column, letter: column.letter, label, role: explicit, confidence: 0.98, reason: "表头语义明确" };
      const score = ruleScores.find((item) => item.column === column.column)?.score || 0;
      const body = column.samples.filter((sample) => !headerRow || sample.row !== headerRow);
      const constraintRatio = body.filter((sample) => looksLikeConstraint(sample.text)).length / Math.max(1, body.length);
      const hanRatio = body.filter((sample) => containsHan(sample.text) && !containsOtherAsianScript(sample.text)).length / Math.max(1, body.length);
      const latinRatio = body.filter((sample) => /[A-Za-z]/.test(sample.text) && !containsHan(sample.text)).length / Math.max(1, body.length);
      if (score >= Math.max(0.34, highestScore - 0.12) && hanRatio >= 0.45) {
        return { column: column.column, letter: column.letter, label, role: "source_text", confidence: Number(Math.min(0.88, 0.55 + score * 0.28).toFixed(2)), reason: "中文正文密度、长度和句式特征最高" };
      }
      if (constraintRatio >= 0.45) return { column: column.column, letter: column.letter, label, role: "constraint", confidence: 0.78, reason: "内容主要是日期、字数或语言限制" };
      if (latinRatio >= 0.55 && column.averageLength >= 18) return { column: column.column, letter: column.letter, label, role: "existing_translation", confidence: 0.72, reason: "主要为连续外文，视为已有参考译文" };
      if (body.length) return { column: column.column, letter: column.letter, label, role: "context", confidence: 0.62, reason: "辅助定位或说明信息" };
      return { column: column.column, letter: column.letter, label, role: "ignore", confidence: 0.6, reason: "没有可用内容" };
    });
    if (!columns.some((column) => column.role === "source_text") && columns.length) {
      const best = [...columns].sort((a, b) => (ruleScores.find((item) => item.column === b.column)?.score || 0) - (ruleScores.find((item) => item.column === a.column)?.score || 0))[0];
      best.role = "source_text";
      best.confidence = 0.51;
      best.reason = "无表头条件下选择中文正文特征最强的列";
    }
    return { sheet: sheet.sheet, headerRow, columns, confidence: headerRow ? 0.86 : 0.64, reason: headerRow ? "规则识别到语义表头" : "无表头，按列内容特征推断" };
  });
  return { source: "rules", usedModel: false, sheets };
}

function validColumnNumbers(sheet) {
  return new Set(sheet.columns.map((column) => column.column));
}

export function mergeSpreadsheetAnalysis(snapshot, ruleAnalysis, modelAnalysis) {
  if (!modelAnalysis?.sheets?.length) return { ...ruleAnalysis, fallbackReason: modelAnalysis?.fallbackReason || "模型未返回有效结构" };
  const modelSheets = new Map(modelAnalysis.sheets.map((sheet) => [String(sheet.sheet), sheet]));
  const sheets = ruleAnalysis.sheets.map((rules) => {
    const snapshotSheet = snapshot.sheets.find((sheet) => sheet.sheet === rules.sheet);
    const model = modelSheets.get(rules.sheet);
    if (!model || !snapshotSheet) return rules;
    const valid = validColumnNumbers(snapshotSheet);
    const ruleColumns = new Map(rules.columns.map((column) => [column.column, column]));
    const columns = (Array.isArray(model.columns) ? model.columns : []).filter((column) => valid.has(Number(column.column)) && COLUMN_ROLES.has(column.role)).map((column) => {
      const fallback = ruleColumns.get(Number(column.column));
      return {
        column: Number(column.column),
        letter: fallback?.letter || columnLetter(Number(column.column)),
        label: compact(column.label || fallback?.label || `${columnLetter(Number(column.column))}列`),
        role: column.role,
        confidence: Math.max(0, Math.min(1, Number(column.confidence) || 0.5)),
        reason: compact(column.reason || "AI 根据表格结构与样本判断")
      };
    });
    for (const column of rules.columns) if (!columns.some((item) => item.column === column.column)) columns.push(column);
    if (!columns.some((column) => column.role === "source_text")) return rules;
    const headerRow = model.headerRow == null ? null : Number(model.headerRow);
    return {
      sheet: rules.sheet,
      headerRow: Number.isInteger(headerRow) && headerRow > 0 && headerRow <= snapshotSheet.rowCount ? headerRow : null,
      columns: columns.sort((a, b) => a.column - b.column),
      confidence: Math.max(0, Math.min(1, Number(model.confidence) || 0.75)),
      reason: compact(model.reason || "AI 综合表头、内容分布与格式识别")
    };
  });
  return { source: "model", usedModel: true, sheets };
}

export function describeSpreadsheetAnalysis(analysis) {
  return analysis.sheets.map((sheet) => ({
    sheet: sheet.sheet,
    headerRow: sheet.headerRow,
    confidence: sheet.confidence,
    reason: sheet.reason,
    columns: sheet.columns.map(({ column, letter, label, role, confidence, reason }) => ({ column, letter, label, role, confidence, reason }))
  }));
}
