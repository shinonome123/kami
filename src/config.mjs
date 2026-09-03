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
  verse: {
    label: "诗词 / 韵文",
    register: "优先重现节奏、对仗、意象与语气；允许为目标语言韵律调整语序和措辞，但不得改变核心意象与信息。"
  },
  narrative: {
    label: "故事 / 叙事",
    register: "保持叙事视角、时间顺序、氛围和信息密度；长句可按目标语言阅读习惯拆分，但不得改写情节。"
  },
  codex: {
    label: "图鉴 / 设定集",
    register: "兼顾世界观文气与资料准确性；人物、怪物、地点和设定名必须与正式术语一致。"
  },
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
  store: {
    label: "商店 / 商品说明",
    register: "版本、包含内容、购买条件与授权关系必须准确；表达清楚直接，不混入角色语气或宣传夸饰。"
  },
  ui: {
    label: "UI / 系统提示",
    register: "简短、直接、可操作；优先遵循目标语言 UI 惯例并控制字符长度。"
  },
  tutorial: {
    label: "教程 / 操作指引",
    register: "按执行顺序说明操作、前置条件和结果；使用目标语言产品惯例，避免文学化或含糊表达。"
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
    label: "待分类文本",
    register: "仅用于尚未确认用途的文本；不得把它当作跨语体通配池，确认用途后应迁移到具体类型。"
  }
});

/**
 * 细标签不承担生产技能的硬隔离，主类型才承担。它们用于同一主类型内的
 * 检索加权、风格证据聚类和来源解释，避免为了每个小场景复制一整套技能。
 */
export const CONTENT_TAGS = Object.freeze({
  verse: Object.freeze({ poem: "诗歌", couplet: "对仗", chant: "偈语 / 口诀", rhyme: "押韵文案" }),
  narrative: Object.freeze({ story_narration: "故事叙述", quest_narrative: "任务叙事", worldbuilding: "世界观叙事" }),
  codex: Object.freeze({ character_codex: "人物图鉴", creature_codex: "怪物图鉴", location_codex: "地点图鉴", lore_entry: "设定条目" }),
  dialogue: Object.freeze({ combat_bark: "战斗喊话", cinematic_dialogue: "剧情台词", npc_dialogue: "NPC 对话", monologue: "独白" }),
  ui: Object.freeze({ button_label: "按钮", menu_label: "菜单", status_message: "状态提示", error_message: "错误提示" }),
  tutorial: Object.freeze({ onboarding: "新手引导", operation_guide: "操作指引", gameplay_tip: "玩法提示" }),
  rules: Object.freeze({ event_rules: "活动规则", eligibility: "资格条件", legal: "条款声明" }),
  item_name: Object.freeze({ equipment_name: "装备名", skill_name: "技能名", character_name: "角色名", location_name: "地点名" }),
  item_description: Object.freeze({ equipment_description: "装备描述", skill_description: "技能描述", effect_description: "效果说明" }),
  store: Object.freeze({ edition_description: "版本说明", purchase_flow: "购买流程", dlc_description: "DLC / 追加内容" }),
  announcement: Object.freeze({ maintenance_notice: "维护公告", update_notice: "更新公告", service_notice: "服务通知" }),
  marketing: Object.freeze({ headline: "宣传标题", slogan: "口号", campaign_copy: "活动宣发", trailer_copy: "预告片文案" }),
  social: Object.freeze({ social_post: "社媒正文", community_cta: "社区号召" }),
  general: Object.freeze({ unclassified: "待人工确认" })
});

export function assertLocale(locale) {
  if (!Object.hasOwn(LOCALES, locale)) {
    const error = new Error(`Unsupported target locale: ${locale}`);
    error.statusCode = 400;
    throw error;
  }
  return locale;
}
