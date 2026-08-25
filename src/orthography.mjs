/**
 * Per-locale punctuation conventions.
 *
 * Carrying Chinese punctuation straight into the target is a deterministic,
 * mechanically checkable defect that the pipeline had no rule for at all — it
 * relied entirely on the model noticing. In the B2 宣发 sample the Korean output
 * used 《》 for the game title in 7 of 7 places where the translator used 「」,
 * and 【Black Myth】 survived untouched into both Japanese and Korean. Neither
 * hard QA nor the AIQA layer raised a single flag.
 *
 * Two tiers, deliberately kept apart:
 *
 *   invalid  — the character does not belong to the target locale's writing
 *              system at all (a Chinese comma in Korean text). Objectively wrong.
 *   title    — which bracket pair the house uses for work titles. Korean
 *              orthography permits 《》, 〈〉, 「」 and 『』; picking one is a
 *              style decision, not a correctness rule, so it is reported
 *              separately and is meant to be configurable.
 *
 * Severity is warning, never error: these are formatting defects a reviewer
 * fixes in seconds, and making them blocking would repeat the mistake the bare
 * number check made — capping a whole document over a cosmetic mismatch.
 *
 * Pure module: no store, provider or clock dependency.
 */

const CJK_PUNCTUATION = ["，", "。", "、", "；", "：", "！", "？", "（", "）", "【", "】", "《", "》", "「", "」", "『", "』", "…", "—"];

export const PUNCTUATION_POLICY = Object.freeze({
  "ja-JP": {
    invalid: [
      ["《", "『"], ["》", "』"],
      ["，", "、"], ["；", "。"]
    ],
    title: ["『", "』"],
    guidance: "作品名用『』，句读用「、」和「。」，不要照搬中文的《》和「，」。"
  },
  "ko-KR": {
    invalid: [
      ["，", ","], ["。", "."], ["、", ","], ["；", ";"], ["：", ":"],
      ["（", "("], ["）", ")"], ["【", "["], ["】", "]"], ["—", "-"]
    ],
    // 《》 是本项目韩语的既定约定：已入库的人工批准译例统一用《검은 신화: 오공》，
    // 韩语正字法对《》〈〉「」『』都允许，所以这是风格决定而非对错。
    title: ["《", "》"],
    guidance: "标点使用半角（, . : ; ( )），作品名用《》，不要照搬中文的，。、【】（）。"
  },
  "zh-Hant-TW": {
    invalid: [["“", "「"], ["”", "」"], ["‘", "『"], ["’", "』"]],
    title: ["《", "》"],
    guidance: "引號用「」與『』，不使用簡體的成對彎引號；書名仍用《》。"
  },
  "th-TH": {
    invalid: CJK_PUNCTUATION.map((character) => [character, ""]),
    title: null,
    guidance: "ไม่ใช้เครื่องหมายวรรคตอนแบบจีน/ญี่ปุ่น ให้ใช้เครื่องหมายและการเว้นวรรคแบบไทย"
  }
});

/**
 * Openers that mark a work title in a Chinese source, so we can tell a title was
 * marked at all. 【】 is deliberately absent: in both Chinese and Japanese it is a
 * label/emphasis marker (【公告】), not a title mark, and treating it as one made
 * a perfectly normal Japanese 【お知らせ】 look like a bracket violation.
 */
const TITLE_OPENERS = ["《", "〈", "「", "『"];

function policyFor(locale) {
  return PUNCTUATION_POLICY[String(locale)] || null;
}

/** One-line instruction for the translation prompt. Empty when the locale has no policy. */
export function punctuationGuidance(locale) {
  return policyFor(locale)?.guidance || "";
}

function countOf(text, character) {
  let total = 0;
  for (const char of String(text ?? "")) if (char === character) total += 1;
  return total;
}

/**
 * Report punctuation that does not belong to the target locale, plus a title
 * bracket that departs from the configured house pair.
 *
 * Each offending character produces at most one issue no matter how often it
 * repeats — seven wrong brackets are one decision to fix, not seven defects.
 */
export function checkOrthography({ source = "", translation = "", locale = "" } = {}) {
  const policy = policyFor(locale);
  const target = String(translation ?? "");
  if (!policy || !target.trim()) return [];
  const issues = [];

  for (const [character, replacement] of policy.invalid) {
    const occurrences = countOf(target, character);
    if (!occurrences) continue;
    issues.push({
      severity: "warning",
      type: "orthography_punctuation",
      category: "punctuation",
      character,
      occurrences,
      message: replacement
        ? `译文出现 ${occurrences} 处「${character}」，该标点不属于当前目标语言，应改为「${replacement}」`
        : `译文出现 ${occurrences} 处「${character}」，该标点不属于当前目标语言，应删除或改用目标语言标点`
    });
  }

  if (policy.title) {
    const [open, close] = policy.title;
    const sourceMarksTitle = TITLE_OPENERS.some((character) => String(source).includes(character));
    const wrongOpeners = TITLE_OPENERS.filter((character) => character !== open && countOf(target, character) > 0);
    // 只有原文确实标了作品名、而译文用了别的括号且完全没用约定括号时才提示，
    // 避免把正常的引用、强调括号误判成书名号问题。
    if (sourceMarksTitle && wrongOpeners.length && !target.includes(open)) {
      issues.push({
        severity: "warning",
        type: "orthography_title_bracket",
        category: "punctuation",
        character: wrongOpeners[0],
        message: `作品名使用了「${wrongOpeners.join("」「")}」，当前目标语言的约定是「${open}${close}」；如需改用其他括号请先更新标点约定`
      });
    }
  }

  return issues;
}
