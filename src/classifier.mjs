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

export function classifyContent(text, hint = "auto") {
  if (hint && hint !== "auto" && Object.hasOwn(CONTENT_TYPES, hint)) {
    return {
      contentType: hint,
      confidence: 1,
      source: "manual",
      evidence: ["用户指定语体"]
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
