const DELIMITER_CANDIDATES = [",", "\t", ";", "|"];

function delimiterCounts(text, limit = 30) {
  const rows = [];
  let counts = Object.fromEntries(DELIMITER_CANDIDATES.map((delimiter) => [delimiter, 0]));
  let inQuotes = false;
  for (let index = 0; index < text.length && rows.length < limit; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (DELIMITER_CANDIDATES.includes(character)) counts[character] += 1;
    if (character === "\r" || character === "\n") {
      rows.push(counts);
      counts = Object.fromEntries(DELIMITER_CANDIDATES.map((delimiter) => [delimiter, 0]));
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    }
  }
  if (Object.values(counts).some(Boolean) || !rows.length) rows.push(counts);
  return rows;
}

export function detectCsvDelimiter(text = "") {
  const rows = delimiterCounts(String(text).replace(/^\uFEFF/, ""));
  let best = { delimiter: ",", score: 0 };
  for (const delimiter of DELIMITER_CANDIDATES) {
    const values = rows.map((row) => row[delimiter]).filter((count) => count > 0);
    if (!values.length) continue;
    const frequencies = new Map();
    for (const value of values) frequencies.set(value, (frequencies.get(value) || 0) + 1);
    const [mode, frequency] = [...frequencies.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0];
    const score = values.length * 100 + frequency * 20 + mode;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/**
 * Parse RFC 4180-style CSV while retaining every original field token and row
 * ending. Retaining raw tokens lets an export replace only translated cells;
 * unrelated quoting, delimiters and line endings are not reformatted.
 */
export function parseCsvDocument(input = "", options = {}) {
  const original = String(input ?? "");
  const bom = original.startsWith("\uFEFF");
  const text = bom ? original.slice(1) : original;
  const delimiter = String(options.delimiter || detectCsvDelimiter(text));
  const rows = [];
  let cells = [];
  let raw = "";
  let value = "";
  let inQuotes = false;

  const addCell = () => {
    cells.push({ raw, value });
    raw = "";
    value = "";
  };
  const addRow = (ending) => {
    addCell();
    rows.push({ cells, ending });
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      raw += character;
      if (character === '"') {
        if (text[index + 1] === '"') {
          raw += text[index + 1];
          value += '"';
          index += 1;
        } else inQuotes = false;
      } else value += character;
      continue;
    }
    if (character === '"' && !raw) {
      raw += character;
      inQuotes = true;
      continue;
    }
    if (character === delimiter) {
      addCell();
      continue;
    }
    if (character === "\r" || character === "\n") {
      const ending = character === "\r" && text[index + 1] === "\n" ? "\r\n" : character;
      if (ending === "\r\n") index += 1;
      addRow(ending);
      continue;
    }
    raw += character;
    value += character;
  }
  if (inQuotes) {
    const error = new Error("CSV 存在未闭合的引号");
    error.statusCode = 400;
    throw error;
  }
  if (raw || value || cells.length || (text && !/[\r\n]$/.test(text))) addRow("");
  return { bom, delimiter, rows };
}

export function csvValues(document) {
  return (document?.rows || []).map((row) => row.cells.map((cell) => cell.value));
}

function encodeCsvCell(value, delimiter, originalRaw = "") {
  const text = String(value ?? "");
  const preserveQuotes = originalRaw.startsWith('"') && originalRaw.endsWith('"');
  if (!preserveQuotes && !text.includes(delimiter) && !/["\r\n]/.test(text) && text === text.trim()) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** replacements use one-based row and column coordinates. */
export function replaceCsvCells(document, replacements = []) {
  const byCell = new Map(replacements.map((item) => [`${Number(item.row)}:${Number(item.column)}`, String(item.value ?? "")]));
  const body = (document?.rows || []).map((row, rowIndex) => {
    const fields = row.cells.map((cell, columnIndex) => {
      const key = `${rowIndex + 1}:${columnIndex + 1}`;
      return byCell.has(key) ? encodeCsvCell(byCell.get(key), document.delimiter, cell.raw) : cell.raw;
    });
    return fields.join(document.delimiter) + row.ending;
  }).join("");
  return `${document?.bom ? "\uFEFF" : ""}${body}`;
}
