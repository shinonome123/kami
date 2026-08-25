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

/**
 * Tokens that must survive verbatim: URLs, placeholders, markup, and numbers
 * that carry a unit.
 *
 * Bare numbers used to be in this list, which made any correct localization of
 * a number a hard error: "在820当天" yields the token "820", so a translator
 * writing 8月20日 / 8월 20일 — the right rendering — was marked as dropping
 * protected content and the score was capped at 60. The model meanwhile learned
 * to emit "8月20日（820）" purely to satisfy the substring check, i.e. it gamed
 * the metric, and that output then passed QA into the memory pool.
 *
 * Bare numbers are now checked for numeric equivalence instead (see
 * digitsRecoverable), which tolerates reformatting but still catches real loss.
 */
export function extractProtectedTokens(text = "") {
  const patterns = [
    /https?:\/\/[^\s)）\]】]+/gi,
    /\{\{[^{}]+\}\}|\{[^{}]+\}/g,
    /%\([^)]+\)[a-z]|%\d*\$?[a-z]/gi,
    /<\/?[a-z][^>]*>/gi,
    // 末尾不能再加 \b：单位后面通常是中日韩字符，边界不成立会让正则回退成裸数字。
    /\d+(?:[.,:]\d+)*(?:%|％|元|円|₩|฿|USD|JPY|KRW|THB)/gi
  ];
  return [...new Set(patterns.flatMap((pattern) => String(text).match(pattern) ?? []))];
}

/** Every digit of a text in reading order, separators and units dropped. */
export function digitSequence(text = "") {
  return (String(text ?? "").match(/\d+/gu) ?? []).join("");
}

/**
 * True when every digit of the source still appears in the translation in the
 * same order. "820" is recoverable from "8月20日" and from "8월 20일"; it is not
 * recoverable from a translation that dropped the date entirely.
 *
 * Known limit: locales that spell months out (Thai 20 สิงหาคม) legitimately lose
 * the month digit, which is why callers report this as a warning to confirm
 * rather than as a hard error.
 */
export function digitsRecoverable(source, translation) {
  const wanted = digitSequence(source);
  if (!wanted) return true;
  const available = digitSequence(translation);
  let cursor = 0;
  for (const digit of wanted) {
    cursor = available.indexOf(digit, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}
