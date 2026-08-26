export const LOCALES = Object.freeze({
  "ja-JP": {
    flagAsset: "/assets/flag-jp.svg",
    label: "日本語",
    shortLabel: "日",
    language: "Japanese",
    defaultInstruction: "自然な日本語として成立させ、直訳調を避ける。用途に応じて敬体・常体を統一する。",
    localizationExamples: [
      { source: "肝就完了！", literal: "肝臓が終わった。", idiomatic: "根性で乗り切れ！", note: "游戏口语：用意气说法重写" },
      { source: "这波稳了", literal: "この波は安定だ。", idiomatic: "この流れはもらったな。", note: "社媒/对白：用目标语言玩家的惯用口吻" },
      { source: "先走一步了", literal: "先に一歩行く。", idiomatic: "お先に失礼！", note: "客套话用目标语言固定表达" }
    ]
  },
  "ko-KR": {
    flagAsset: "/assets/flag-kr.svg",
    label: "한국어",
    shortLabel: "韩",
    language: "Korean",
    defaultInstruction: "자연스러운 한국어 어순과 높임말을 사용하고 조사와 띄어쓰기를 정확히 유지한다.",
    localizationExamples: [
      { source: "肝就完了！", literal: "간이 끝났다.", idiomatic: "죽어라 하면 된다!", note: "게임 구어체로 재구성" },
      { source: "这波稳了", literal: "이 흐름은 안정적이다.", idiomatic: "이번 판은 이겼다!", note: "자연스러운 게임 말투" },
      { source: "先走一步了", literal: "먼저 한 걸음 간다.", idiomatic: "먼저 가볼게!", note: "목표 언어 관용 표현" }
    ]
  },
  "zh-Hant-TW": {
    flagAsset: "/assets/flag-tw.svg",
    label: "繁體中文",
    shortLabel: "繁",
    language: "Traditional Chinese (Taiwan)",
    defaultInstruction: "使用臺灣繁體中文的自然用語，不做機械式簡繁轉換，避免中國大陸慣用詞直接照搬。",
    localizationExamples: [
      { source: "肝就完了！", literal: "肝就完了！", idiomatic: "拼就對了！", note: "遊戲口語用臺灣習慣說法" },
      { source: "上头了", literal: "上頭了", idiomatic: "玩到停不下來", note: "口語改用臺灣自然表達" },
      { source: "先走一步了", literal: "先走一步了", idiomatic: "先告辭啦！", note: "客套話用臺灣固定說法" }
    ]
  },
  "fr-FR": {
    flagAsset: "/assets/flag-fr.svg",
    label: "Français",
    shortLabel: "法",
    language: "French",
    defaultInstruction: "Rédiger un français naturel et idiomatique ; respecter les accords, les accents et le registre (vouvoiement par défaut sauf ton communautaire assumé).",
    localizationExamples: [
      { source: "肝就完了！", literal: "Le foie est fini !", idiomatic: "Il suffit de farmer à fond !", note: "游戏口语：用法语玩家的说法重写，不保留中文脏器比喻" },
      { source: "这波稳了", literal: "Cette vague est stable.", idiomatic: "C'est dans la poche.", note: "对白/社媒：用法语固定表达" },
      { source: "先走一步了", literal: "Je pars un pas en avant.", idiomatic: "Je file, à plus !", note: "客套话用法语惯用告别语" }
    ]
  },
  "th-TH": {
    flagAsset: "/assets/flag-th.svg",
    label: "ไทย",
    shortLabel: "泰",
    language: "Thai",
    defaultInstruction: "ใช้ภาษาไทยที่เป็นธรรมชาติ รักษาระดับความสุภาพและการถอดเสียงชื่อเฉพาะให้สม่ำเสมอ",
    localizationExamples: []
  }
});

export const CONTENT_TYPES = Object.freeze({
  marketing: {
    label: "宣发文案",
    register: "传播感强、自然、有号召力；允许适度本地化创译，但不得改变事实和承诺强度。"
  },
  announcement: {
    label: "正式公告",
    register: "准确、正式、信息层级清晰；日期、平台、地区、条件与限制不得改写。"
  },
  item_name: {
    label: "游戏内道具名",
    register: "短、可识别、有世界观一致性；优先采用批准命名并严格控制长度。"
  },
  item_description: {
    label: "游戏内道具描述",
    register: "兼顾功能准确性与世界观语感；属性、数值、占位符必须完全保留。"
  },
  ui: {
    label: "UI / 系统提示",
    register: "简短、直接、可操作；优先遵循目标语言 UI 惯例并控制字符长度。"
  },
  rules: {
    label: "活动规则",
    register: "结构严谨、条件明确、避免歧义；数字、时间、资格和例外条款不得变化。"
  },
  dialogue: {
    label: "剧情对白",
    register: "保留角色关系、口吻、情绪与节奏；避免书面腔和角色声音趋同。"
  },
  social: {
    label: "社媒短文案",
    register: "轻快、自然、适合平台传播；保留标签、链接和 CTA。"
  },
  general: {
    label: "通用文本",
    register: "忠实、自然、清晰；在无明确语体时避免过度润色。"
  }
});

export function assertLocale(locale) {
  if (!Object.hasOwn(LOCALES, locale)) {
    const error = new Error(`Unsupported target locale: ${locale}`);
    error.statusCode = 400;
    throw error;
  }
  return locale;
}
