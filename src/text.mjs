export function normalizeSource(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

export function splitSegments(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split(/(?<=\n)|(?<=[。！？!?；;])(?=[^”’」』】）)])/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((source, index) => ({ id: `seg-${index + 1}`, index, source }));
}

export function levenshtein(a = "", b = "") {
  const left = [...normalizeSource(a)];
  const right = [...normalizeSource(b)];
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      previous = saved;
    }
  }
  return row[right.length];
}

export function similarity(a, b) {
  const maxLength = Math.max([...normalizeSource(a)].length, [...normalizeSource(b)].length);
  if (!maxLength) return 1;
  return 1 - levenshtein(a, b) / maxLength;
}

/**
 * Conservative detection of doggerel/verse structure (顺口溜、口诀、诗行):
 * short equal-length clauses separated by commas followed by a longer clause
 * (3+3+7 / 4+4+7), or a 2-3 character block repeated three times with commas.
 */
export function detectRhymeLike(text = "") {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  if (/^[\u4e00-\u9fff]{3}[，,][\u4e00-\u9fff]{3}[，,][\u4e00-\u9fff]{6,12}[。！？!?~～]*$/u.test(normalized)) return true;
  if (/^[\u4e00-\u9fff]{4}[，,][\u4e00-\u9fff]{4}[，,][\u4e00-\u9fff]{6,12}[。！？!?~～]*$/u.test(normalized)) return true;
  return /([\u4e00-\u9fff]{2,3})[，,]\1[，,]\1/u.test(normalized);
}

export function extractProtectedTokens(text = "") {
  const patterns = [
    /https?:\/\/[^\s)）\]】]+/gi,
    /\{\{[^{}]+\}\}|\{[^{}]+\}/g,
    /%\([^)]+\)[a-z]|%\d*\$?[a-z]/gi,
    /<\/?[a-z][^>]*>/gi,
    /\b\d+(?:[.,:]\d+)*(?:%|％|元|円|₩|฿|USD|JPY|KRW|THB)?\b/gi
  ];
  return [...new Set(patterns.flatMap((pattern) => String(text).match(pattern) ?? []))];
}
