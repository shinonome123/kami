export const LOCALES = Object.freeze({
  "ja-JP": {
    flagAsset: "/assets/flag-jp.svg",
    label: "日本語",
    shortLabel: "日",
    language: "Japanese",
    defaultInstruction: "自然な日本語として成立させ、直訳調を避ける。用途に応じて敬体・常体を統一する。"
  },
  "ko-KR": {
    flagAsset: "/assets/flag-kr.svg",
    label: "한국어",
    shortLabel: "韩",
    language: "Korean",
    defaultInstruction: "자연스러운 한국어 어순과 높임말을 사용하고 조사와 띄어쓰기를 정확히 유지한다."
  },
  "zh-Hant-TW": {
    flagAsset: "/assets/flag-tw.svg",
    label: "繁體中文",
    shortLabel: "繁",
    language: "Traditional Chinese (Taiwan)",
    defaultInstruction: "使用臺灣繁體中文的自然用語，不做機械式簡繁轉換，避免中國大陸慣用詞直接照搬。"
  },
  "th-TH": {
    flagAsset: "/assets/flag-th.svg",
    label: "ไทย",
    shortLabel: "泰",
    language: "Thai",
    defaultInstruction: "ใช้ภาษาไทยที่เป็นธรรมชาติ รักษาระดับความสุภาพและการถอดเสียงชื่อเฉพาะให้สม่ำเสมอ"
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
