import { CONTENT_TYPES } from "./config.mjs";

const RULES = [
  ["item_name", 5, /^(?:【[^】]{1,18}】|[\p{Script=Han}A-Za-z0-9·・：:—\-]{2,18})$/u],
  ["item_description", 7, /(道具|装备|武器|获得后|使用后|生命值|攻击力|防御力|稀有度|持续\d|伤害|属性)/u],
  ["announcement", 7, /(公告|维护|更新完成|将于|服务器|停机|感谢.{0,8}(理解|支持)|敬请留意)/u],
  ["rules", 7, /(活动期间|参与条件|活动规则|奖励发放|每个账号|仅限|截止时间|资格|视为放弃)/u],
  ["ui", 6, /^(确认|取消|返回|继续|领取|购买|登录|退出|重试|保存|提交|加载中|网络异常|操作失败)[。！]?$/u],
  ["social", 5, /(#\S+|转发|评论区|关注我们|戳这里|快来|一起.{0,6}吧|👉|🎉|✨)/u],
  ["marketing", 5, /(限时|重磅|全新|惊喜|盛大|立即|不容错过|现已|火热|开启|登场|来袭|折扣)/u],
  ["dialogue", 4, /([“「『].+[”」』]|说道|问道|喊道|低声|笑着说|[，,].{1,24}(啊|吧|呢|罢|哩|呀|么|吗|嘛|呐|喽|咯|了|来|去|走|住|听|看|小心|留心)[。！？!?…]*)/u]
];

export const DOMAINS = Object.freeze(["game", "general", "marketing", "community"]);

/** 语体本身就已经决定领域的两种情况。 */
const CONTENT_TYPE_DOMAIN = Object.freeze({ marketing: "marketing", social: "community" });

const DOMAIN_RULES = Object.freeze([
  ["community", /社媒|社区|关注|转发|评论|粉丝|直播|discord|twitter|facebook|instagram/iu],
  ["game", /游戏|玩家|通行证|道具|装备|武器|技能|角色|关卡|副本|商城|赛季|客户端|服务器|dlc|playstation|steam|xbox/iu],
  ["marketing", /促销|折扣|购买|商品|限时|优惠|营销|宣发|预约|发售/u]
]);

/** 纯文本层面的领域推断，术语导入与翻译路径共用同一份规则。 */
export function inferDomainFromText(text, contentType = "general", { fallback = "general" } = {}) {
  if (CONTENT_TYPE_DOMAIN[contentType]) return CONTENT_TYPE_DOMAIN[contentType];
  const value = String(text ?? "");
  for (const [domain, pattern] of DOMAIN_RULES) if (pattern.test(value)) return domain;
  return fallback;
}

/**
 * 业务领域此前完全没有自动识别：服务端一律 `body.domain || "game"`，
 * 唯一的推断实现只服务于术语导入。这里补上与语体同构的判定链。
 *
 * 注意领域是**收窄**维度：记忆与证据检索按它做严格过滤，选错会让检索归零，
 * 所以调用方必须配合"取不到就放宽领域"的回退，不能只依赖这里判得准。
 */
export function resolveDomain(text, hint = "auto", { contentType = "general", fallback = "game" } = {}) {
  if (hint && hint !== "auto" && DOMAINS.includes(hint)) {
    return { domain: hint, source: "manual", evidence: "用户指定领域" };
  }
  if (CONTENT_TYPE_DOMAIN[contentType]) {
    return { domain: CONTENT_TYPE_DOMAIN[contentType], source: "content-type", evidence: `语体决定领域` };
  }
  const value = String(text ?? "");
  for (const [domain, pattern] of DOMAIN_RULES) {
    const match = value.match(pattern);
    if (match) return { domain, source: "heuristic", evidence: `正文命中「${match[0]}」` };
  }
  return { domain: DOMAINS.includes(fallback) ? fallback : "game", source: "fallback", evidence: "未命中领域规则，使用默认" };
}

/**
 * Descriptor keywords → content type.
 *
 * Localization request sheets state the purpose of every line in their own
 * columns ("视频标题" / "导航栏文本" / "FAQ文本"), and that is a far stronger
 * signal than guessing from the copy itself. The classifier ignored those
 * columns entirely: on the B2 宣发 sample all three rows came out wrong
 * (视频标题→general、导航栏文本→item_name、FAQ文本→dialogue), and since the
 * content type selects the style profile, every downstream decision inherited
 * the mistake.
 *
 * Order matters: the more specific pattern has to win (道具描述 before 道具名,
 * 视频标题 before 社媒).
 */
const DESCRIPTOR_RULES = [
  ["ui", /导航|導航|按钮|按鈕|菜单|選單|选单|界面|系统提示|系統提示|标签页|標籤頁|入口|弹窗|彈窗|toast|tooltip|placeholder|ui/iu],
  ["item_description", /(道具|物品|装备|裝備|技能|称号|稱號|卡牌|皮肤|皮膚)[^，,。\s]{0,3}(描述|说明|說明)/u],
  ["item_name", /(道具|物品|装备|裝備|技能|称号|稱號|卡牌|皮肤|皮膚)[^，,。\s]{0,3}(名|名称|名稱)/u],
  ["announcement", /公告|通知|维护|維護|停机|停機|更新说明|更新說明/u],
  ["rules", /规则|規則|条款|條款|须知|須知|资格|資格|细则|細則/u],
  ["dialogue", /对白|對白|台词|台詞|剧情|劇情|旁白|字幕|配音/u],
  // FAQ 既有事实承诺又常带轻松口吻：归 general（忠实、自然、不过度润色）比
  // 归 announcement（正式）或 dialogue（角色口吻）都更安全。
  ["general", /faq|常见问题|常見問題|问答|問答|q\s*&\s*a/iu],
  ["marketing", /标题|標題|宣发|宣發|宣传|宣傳|广告|廣告|slogan|口号|口號|banner|预告|預告|pv|cta|首页|首頁|落地页|落地頁/iu],
  ["social", /社媒|社交|推文|帖子|微博|朋友圈|twitter|instagram|tiktok|facebook/iu]
];

/**
 * Read a content type off the sheet's own descriptor columns. `descriptor` is
 * the per-line purpose (描述), `location` the placement (位置); the descriptor
 * is checked first because it is the more specific of the two.
 */
export function contentTypeFromDescriptor(descriptor = "", location = "") {
  for (const field of [String(descriptor || "").trim(), String(location || "").trim()]) {
    if (!field) continue;
    for (const [type, pattern] of DESCRIPTOR_RULES) {
      const match = field.match(pattern);
      if (match) return { contentType: type, evidence: `${field}（匹配「${match[0]}」）` };
    }
  }
  return null;
}

/**
 * Pull the purpose columns out of a Context Pack's neighbour metadata.
 *
 * Excel rows carry their own labels ("位置" / "描述" / "备注"); the batch pipeline
 * already collects them, they were simply never shown to the classifier.
 */
export function descriptorFromContext(neighborContext = {}) {
  const items = Array.isArray(neighborContext?.metadata) ? neighborContext.metadata : [];
  const pick = (pattern) => String(items.find((item) => pattern.test(String(item?.label || "")))?.value || "").trim();
  return {
    descriptor: pick(/描述|用途|类型|類型|说明|說明|文案|description|usage|type/i),
    location: pick(/位置|放置|投放|渠道|页面|頁面|placement|location|channel|page/i)
  };
}

export function classifyContent(text, hint = "auto", { descriptor = "", location = "" } = {}) {
  if (hint && hint !== "auto" && Object.hasOwn(CONTENT_TYPES, hint)) {
    return {
      contentType: hint,
      confidence: 1,
      source: "manual",
      evidence: ["用户指定语体"]
    };
  }

  // 表格已经写明用途时，它比从正文猜要可靠得多，直接采用。
  const declared = contentTypeFromDescriptor(descriptor, location);
  if (declared) {
    return {
      contentType: declared.contentType,
      confidence: 0.92,
      source: "descriptor",
      evidence: [`表格声明用途：${declared.evidence}`]
    };
  }

  const source = String(text).trim();
  const scores = new Map();
  const evidence = new Map();
  for (const [type, weight, pattern] of RULES) {
    const match = source.match(pattern);
    if (!match) continue;
    scores.set(type, (scores.get(type) ?? 0) + weight);
    evidence.set(type, [...(evidence.get(type) ?? []), match[0].slice(0, 32)]);
  }
  if (source.length <= 12 && !/[。！？]/u.test(source)) {
    scores.set("ui", (scores.get("ui") ?? 0) + 1);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [contentType = "general", score = 0] = ranked[0] ?? [];
  return {
    contentType,
    confidence: score ? Math.min(0.97, 0.55 + score / 20) : 0.42,
    source: "heuristic",
    evidence: evidence.get(contentType) ?? ["未命中专用规则，使用通用语体"]
  };
}
