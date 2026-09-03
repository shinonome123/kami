/**
 * Deterministic register classifier: "too marketing", "too flat", "too casual".
 *
 * This is a lexicon-and-feature classifier, not a model. That is the point:
 * the same input always yields the same labels, the lexicon is versioned, and
 * every label carries the exact spans that produced it. A judge model's free
 * opinion on tone drifts between calls and cannot be regression-tested; this
 * can. It is deliberately conservative — it flags register, never correctness.
 *
 * Register is judged relative to the content type. "今すぐ購入！" is on-voice
 * for 宣发文案 and off-voice for 正式公告, so the same text can be clean in one
 * scope and flagged in another.
 */
export const REGISTER_CLASSIFIER_VERSION = "1.1";
export const REGISTER_DIMENSIONS = Object.freeze(["promotional", "casual", "generic"]);
export const REGISTER_LABELS = Object.freeze(["too_promotional", "too_casual", "too_generic"]);

const SHARED = Object.freeze({
  promotional: ["最强", "最佳", "顶级", "史上", "爆款", "必买", "超值", "惊喜价", "限时抢", "免费领"],
  casual: ["www", "lol", "xd", "orz"],
  generic: ["各种", "多种多样", "非常好", "很不错"]
});

/**
 * Per-locale markers. Kept intentionally small and high-precision: a marker
 * earns its place only if a native reviewer would agree it signals the register
 * on its own, because a noisy lexicon turns this into another opinion generator.
 */
const LEXICONS = Object.freeze({
  "ja-JP": {
    promotional: ["今すぐ", "お見逃しなく", "大好評", "圧倒的", "史上最強", "驚きの", "特別価格", "限定セール", "絶対に", "必見", "大幅割引", "お得"],
    casual: ["めっちゃ", "やばい", "超うれしい", "ガチ", "神ってる", "だよね", "じゃん", "ｗｗ", "笑笑"],
    generic: ["さまざまな", "いろいろな", "とても良い", "非常に良い", "便利です", "楽しめます", "充実した"]
  },
  "ko-KR": {
    promotional: ["지금 바로", "놓치지 마세요", "역대급", "최강", "폭발적", "특가", "한정 할인", "무조건", "필수", "대박 혜택"],
    casual: ["ㅋㅋ", "ㅎㅎ", "완전", "짱", "개꿀", "레알", "너무너무"],
    generic: ["다양한", "매우 좋은", "편리합니다", "즐길 수 있습니다", "여러 가지"]
  },
  "zh-Hant-TW": {
    promotional: ["立即", "千萬別錯過", "史上最強", "超值", "限時搶購", "絕對", "必買", "驚喜價", "獨家優惠"],
    casual: ["超扯", "很盤", "有夠", "欸", "啦", "超讚", "笑死"],
    generic: ["各式各樣", "非常好", "很方便", "多元的", "豐富的"]
  },
  "th-TH": {
    promotional: ["ทันที", "ห้ามพลาด", "ดีที่สุด", "สุดคุ้ม", "ลดราคาพิเศษ", "จำกัดเวลา", "ต้องมี"],
    casual: ["555", "โคตร", "อ่ะ", "แหละ", "สุดๆ"],
    generic: ["หลากหลาย", "ดีมาก", "สะดวก", "น่าสนใจ"]
  }
});

/**
 * 每种语体允许的语域上限。数值是该维度得分的容忍度：宣发文案本来就该有推销
 * 感，公告和规则不该有；社媒可以口语，商店页不行。
 */
const CONTENT_TYPE_POLICY = Object.freeze({
  marketing: { promotional: 0.85, casual: 0.55, generic: 0.45 },
  social: { promotional: 0.75, casual: 0.85, generic: 0.45 },
  store: { promotional: 0.6, casual: 0.3, generic: 0.5 },
  announcement: { promotional: 0.35, casual: 0.2, generic: 0.6 },
  rules: { promotional: 0.25, casual: 0.15, generic: 0.75 },
  tutorial: { promotional: 0.3, casual: 0.35, generic: 0.7 },
  ui: { promotional: 0.3, casual: 0.3, generic: 0.8 },
  item_name: { promotional: 0.5, casual: 0.4, generic: 0.8 },
  item_description: { promotional: 0.55, casual: 0.4, generic: 0.6 },
  dialogue: { promotional: 0.4, casual: 0.85, generic: 0.5 },
  narrative: { promotional: 0.35, casual: 0.6, generic: 0.45 },
  verse: { promotional: 0.4, casual: 0.6, generic: 0.4 },
  codex: { promotional: 0.3, casual: 0.4, generic: 0.6 },
  general: { promotional: 0.6, casual: 0.6, generic: 0.6 }
});

/**
 * 每种语体的写作指令。和上面的容忍度表放在一起是刻意的：生成时给模型的口径
 * 与事后判定语域的口径必须是同一份，否则会出现"按 A 写、按 B 判"的自相矛盾。
 */
const CONTENT_TYPE_DIRECTIVE = Object.freeze({
  marketing: "宣发文案：可以有推销力度和情绪，但卖点必须来自原文，不得自行加码承诺、折扣或时间。句式要有节奏变化，避免整段感叹号堆砌。",
  social: "社媒短文案：用目标平台原生的口语和语气，可以短句、可以有轻度网络用语和表情；但事实、时间、平台与活动名一字不改，不得为了热度夸大。",
  store: "商店/商品说明：开头一句就要讲清这是什么、对玩家有什么用；信息密度优先于修辞，遵守平台字符限制，不使用口语和网络用语。",
  announcement: "正式公告：中性、克制、可信。不加感叹号，不加促销词，不制造紧迫感；时间、范围、条件、补偿必须与原文逐项对应。",
  rules: "活动规则：法务口径。表述必须唯一可解释，条件、例外、时限、资格逐条对应；禁止任何修辞、口语和推销措辞。",
  tutorial: "教程/操作指引：按玩家实际操作顺序写，动作动词在前，一步一句；界面元素名必须与 UI 术语完全一致。",
  ui: "UI/系统提示：极简、可预测、可复用。同一功能在全局用同一说法，长度尽量不超过原文，不使用感叹号和修辞。",
  item_name: "道具名：简短、可辨识、可检索。保持系列命名的一致性，不加形容词堆砌，不解释。",
  item_description: "道具描述：先说效果与用法，再谈风味；数值与生效条件必须精确，风味描写不得与数值冲突。",
  dialogue: "剧情对白：角色声音优先。语气、教养、年龄、关系要在措辞里体现；允许口语与省略，但不得改变角色说出的信息。",
  narrative: "叙事文本：保持叙述视角与时态一致，节奏跟随原文的紧张与舒缓；书面但不僵硬，避免翻译腔的长定语。",
  verse: "韵文：优先在目标语言里重建节奏与韵脚，允许换意象与语序；宁可换一个地道的比喻，也不要保留原文字面而丢掉韵律。",
  codex: "图鉴/设定集：百科口径，客观陈述。专名与设定术语严格统一，不加主观评价和推销语。",
  general: "按原文的实际用途选择最贴切的语体，保持信息完整与目标语言自然度。"
});

/** 生成侧要用的语体写作指令。 */
export function contentTypeDirective(contentType = "general") {
  return CONTENT_TYPE_DIRECTIVE[contentType] || CONTENT_TYPE_DIRECTIVE.general;
}

const EXCLAMATION = /[!！❗‼]/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;
const SENTENCE_SPLIT = /[。．.!！?？\n]+/u;

function lexiconFor(locale) {
  const base = LEXICONS[locale] || {};
  return {
    promotional: [...(base.promotional || []), ...SHARED.promotional],
    casual: [...(base.casual || []), ...SHARED.casual],
    generic: [...(base.generic || []), ...SHARED.generic]
  };
}

function foldForLexicon(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase();
}

function countMarkers(text, markers) {
  const folded = foldForLexicon(text);
  const hits = [];
  for (const marker of markers) {
    const needle = foldForLexicon(marker);
    if (!needle) continue;
    let index = folded.indexOf(needle);
    let occurrences = 0;
    while (index !== -1) {
      occurrences += 1;
      index = folded.indexOf(needle, index + needle.length);
    }
    if (occurrences) hits.push({ marker, occurrences });
  }
  return hits;
}

function countPattern(text, pattern) {
  return (String(text).match(pattern) || []).length;
}

function sentences(text) {
  return String(text).split(SENTENCE_SPLIT).map((item) => item.trim()).filter(Boolean);
}

/**
 * 每百字出现次数，带加性平滑。不平滑的话，十几个字里出现一个词就等于每百字
 * 七八次，短句会被系统性地判成语域过载。
 */
const DENSITY_SMOOTHING = 25;

function density(count, length) {
  return count ? (count / (length + DENSITY_SMOOTHING)) * 100 : 0;
}

function saturate(value, full) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / full);
}

function lexicalDiversity(text) {
  const characters = [...String(text).replace(/\s+/gu, "")];
  if (characters.length < 8) return 1;
  return new Set(characters).size / characters.length;
}

function sentenceUniformity(list) {
  if (list.length < 3) return 0;
  const lengths = list.map((item) => [...item].length);
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (!mean) return 0;
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  const deviation = Math.sqrt(variance) / mean;
  // 变异系数越低，句式越单调；0.18 以下视为完全整齐。
  return Math.max(0, 1 - deviation / 0.18);
}

/**
 * Classify one piece of target-language text. Scores are 0..1 per dimension and
 * always come with the spans that caused them.
 */
export function classifyRegister(text, { locale = "", contentType = "general" } = {}) {
  const value = String(text ?? "");
  const length = [...value.replace(/\s+/gu, "")].length;
  const lexicon = lexiconFor(locale);
  const promotionalHits = countMarkers(value, lexicon.promotional);
  const casualHits = countMarkers(value, lexicon.casual);
  const genericHits = countMarkers(value, lexicon.generic);
  const exclamations = countPattern(value, EXCLAMATION);
  const emoji = countPattern(value, EMOJI);
  const lines = sentences(value);
  const diversity = lexicalDiversity(value);
  const uniformity = sentenceUniformity(lines);

  const promotionalMarkerCount = promotionalHits.reduce((sum, hit) => sum + hit.occurrences, 0);
  const casualMarkerCount = casualHits.reduce((sum, hit) => sum + hit.occurrences, 0);
  const genericMarkerCount = genericHits.reduce((sum, hit) => sum + hit.occurrences, 0);

  const features = {
    length,
    sentenceCount: lines.length,
    promotionalMarkers: promotionalMarkerCount,
    casualMarkers: casualMarkerCount,
    genericMarkers: genericMarkerCount,
    exclamationDensity: Number(density(exclamations, length).toFixed(3)),
    emojiDensity: Number(density(emoji, length).toFixed(3)),
    lexicalDiversity: Number(diversity.toFixed(3)),
    sentenceUniformity: Number(uniformity.toFixed(3))
  };

  // 太短的文本没有稳定的语域信号，宁可不判。
  const measurable = length >= 6;
  const scores = measurable ? {
    promotional: Number(Math.min(1,
      saturate(density(promotionalMarkerCount, length), 8) * 0.62
      + saturate(features.exclamationDensity, 8) * 0.38
    ).toFixed(3)),
    casual: Number(Math.min(1,
      saturate(density(casualMarkerCount, length), 8) * 0.7
      + saturate(features.emojiDensity, 6) * 0.3
    ).toFixed(3)),
    generic: Number(Math.min(1,
      saturate(density(genericMarkerCount, length), 6) * 0.5
      + Math.max(0, 1 - diversity / 0.62) * 0.28
      + uniformity * 0.22
    ).toFixed(3))
  } : { promotional: 0, casual: 0, generic: 0 };

  return {
    version: REGISTER_CLASSIFIER_VERSION,
    locale,
    contentType,
    measurable,
    features,
    scores,
    evidence: {
      promotional: promotionalHits,
      casual: casualHits,
      generic: genericHits
    },
    lexiconSize: {
      promotional: lexicon.promotional.length,
      casual: lexicon.casual.length,
      generic: lexicon.generic.length
    }
  };
}

export function registerPolicyFor(contentType = "general", overrides = null) {
  const base = CONTENT_TYPE_POLICY[contentType] || CONTENT_TYPE_POLICY.general;
  if (!overrides || typeof overrides !== "object") return { ...base };
  const merged = { ...base };
  for (const dimension of REGISTER_DIMENSIONS) {
    const value = Number(overrides[dimension]);
    if (Number.isFinite(value) && value >= 0 && value <= 1) merged[dimension] = value;
  }
  return merged;
}

const LABEL_BY_DIMENSION = Object.freeze({
  promotional: "too_promotional",
  casual: "too_casual",
  generic: "too_generic"
});

const DIMENSION_LABELS_ZH = Object.freeze({
  promotional: "太营销",
  casual: "太网感",
  generic: "太普通"
});

/**
 * Turn the classification into QA issues. Only a dimension that exceeds its
 * content type's tolerance produces an issue, and it is always a warning: tone
 * is a judgement call the reviewer owns, so this reports rather than blocks.
 */
export function checkRegisterExpectation({ translation = "", locale = "", contentType = "general", policyOverrides = null } = {}) {
  const classification = classifyRegister(translation, { locale, contentType });
  if (!classification.measurable) return { classification, issues: [] };
  const policy = registerPolicyFor(contentType, policyOverrides);
  const issues = [];
  for (const dimension of REGISTER_DIMENSIONS) {
    const score = classification.scores[dimension];
    const tolerance = policy[dimension];
    if (score <= tolerance) continue;
    const hits = classification.evidence[dimension].map((hit) => hit.marker).slice(0, 5);
    issues.push({
      severity: "warning",
      type: `register_${LABEL_BY_DIMENSION[dimension]}`,
      category: "style_register",
      dimension,
      label: LABEL_BY_DIMENSION[dimension],
      score,
      tolerance,
      classifierVersion: REGISTER_CLASSIFIER_VERSION,
      evidence: hits,
      message: `语域偏离：${DIMENSION_LABELS_ZH[dimension]}（${score.toFixed(2)} 超过${contentType}语体的容忍度 ${tolerance.toFixed(2)}）${hits.length ? `，证据：${hits.join("、")}` : ""}`
    });
  }
  return { classification, issues };
}
