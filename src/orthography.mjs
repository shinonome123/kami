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
  "fr-FR": {
    // 法语不使用任何中日式标点；破折号与省略号本身合法，故不在 CJK_PUNCTUATION 里剔除后单独排除。
    invalid: CJK_PUNCTUATION.filter((character) => !["…", "—"].includes(character)).map((character) => [character, ""]),
    title: ["«", "»"],
    // 法语排版硬性要求：; ! ? 前用窄不断行空格，: 前用不断行空格，« » 内侧同样留空格。
    frenchSpacing: true,
    guidance: "使用法语标点：引号用 « »（内侧留不断行空格），; ! ? 前留窄不断行空格、: 前留不断行空格；不要出现任何中日式标点（，。、；：！？（）【】《》「」）。"
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

/**
 * 作品名括号是**风格约定**而不是语言对错（韩语正字法对《》〈〉「」『』都允许），
 * 所以允许设置面板按语种覆盖；无效标点那一档是语言层面的规则，不接受覆盖。
 */
function policyFor(locale, titleOverrides = null) {
  const policy = PUNCTUATION_POLICY[String(locale)] || null;
  if (!policy) return null;
  const override = titleOverrides?.[String(locale)];
  if (override === undefined) return policy;
  const pair = String(override || "").trim();
  const title = pair.length === 2 ? [pair[0], pair[1]] : null;
  const guidance = title
    ? policy.guidance.replace(/作品名用[《「『〈«][》」』〉»]/u, `作品名用${title[0]}${title[1]}`)
    : policy.guidance;
  return { ...policy, title, guidance };
}

/** One-line instruction for the translation prompt. Empty when the locale has no policy. */
export function punctuationGuidance(locale, titleOverrides = null) {
  return policyFor(locale, titleOverrides)?.guidance || "";
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
export function checkOrthography({ source = "", translation = "", locale = "", titleOverrides = null } = {}) {
  const policy = policyFor(locale, titleOverrides);
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
    // 已经作为"非本语言标点"报过的符号不再重复计入书名号约定，
    // 否则一次照搬会同时产生「符号无效」和「括号不符约定」两条。
    const alreadyReported = new Set(issues.map((issue) => issue.character));
    const wrongOpeners = TITLE_OPENERS
      .filter((character) => character !== open && countOf(target, character) > 0)
      .filter((character) => !alreadyReported.has(character));
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

  if (policy.frenchSpacing) issues.push(...checkFrenchSpacing(target));

  return issues;
}

/** 用转义写死：这两个空格不可见，字面字符一次复制粘贴就可能被静默换成普通空格。 */
const NARROW_NBSP = " ";
const NBSP = " ";

/**
 * 引号内按原样引用，其中的标点不受法语间距约束。
 *
 * 实测 « Black Myth: Zhong Kui » 里的冒号属于英文原标题，法语排版不改外文引文
 * 自身的标点；不排除的话这条规则会在几乎每条含游戏名的文案上误报。用等长空格
 * 替换而非删除，保证计数与原文位置仍然对得上。
 */
function withoutQuotedSpans(text) {
  // 只抹掉引号内部，保留 « » 本身：紧跟在 » 后面的 ! ? 仍然属于法语正文，必须继续检查。
  return String(text).replace(/«([^»]*)»/gu, (span, inner) => `«${" ".repeat([...inner].length)}»`);
}

/**
 * 法语标点间距。模型几乎总是按英语习惯直接贴着写 Bonjour!，法语要求分开。
 *
 * 只判「完全没有空格」这一种确定错误：普通空格与不断行空格都放行。窄不断行空格
 * 是排版理想值，但各家风格不一，把普通空格也判成问题会制造大量噪声，因此提示里
 * 只说需要留空，不谎称已经校验过空格种类。每类问题汇总一条。
 */
export function checkFrenchSpacing(translation = "") {
  const text = String(translation ?? "");
  if (!text.trim()) return [];
  const issues = [];
  const tight = [...withoutQuotedSpans(text).matchAll(/(\S)([;!?:])/gu)]
    .filter(([, before]) => before !== NARROW_NBSP && before !== NBSP);
  if (tight.length) {
    issues.push({
      severity: "warning",
      type: "orthography_french_spacing",
      category: "spacing",
      character: tight[0][2],
      occurrences: tight.length,
      message: `译文有 ${tight.length} 处 ; ! ? : 直接贴着前一个词，法语排版需要在其前留空格（理想为不断行空格 U+00A0 或窄不断行空格 U+202F）`
    });
  }
  const guillemets = [...text.matchAll(/«(\S)|(\S)»/gu)]
    .filter((match) => ![NARROW_NBSP, NBSP].includes(match[1] ?? match[2]));
  if (guillemets.length) {
    issues.push({
      severity: "warning",
      type: "orthography_french_guillemets",
      category: "spacing",
      character: "«",
      occurrences: guillemets.length,
      message: `译文有 ${guillemets.length} 处 « » 内侧未留不断行空格，法语引号写法应为 « texte »`
    });
  }
  return issues;
}
