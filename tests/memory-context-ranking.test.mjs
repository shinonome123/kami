import test from "node:test";
import assert from "node:assert/strict";
import { rankTranslationMemories } from "../src/translation-memory.mjs";

const NOW = new Date("2026-09-03T00:00:00.000Z");

function memory(overrides = {}) {
  return {
    id: "m",
    source: "限时活动将于本周开启",
    target: "期間限定イベントが今週開幕します。",
    qualityStatus: "human_approved",
    contentTags: [],
    dateUpdated: "2026-08-30T00:00:00.000Z",
    ...overrides
  };
}

test("平台不符的译例直接不参与召回", () => {
  const ranked = rankTranslationMemories("限时活动将于本周开启", [
    memory({ id: "other-platform", platform: "steam" }),
    memory({ id: "same-platform", platform: "playstation_store" })
  ], { limit: 5, platform: "playstation_store", now: NOW });
  assert.deepEqual(ranked.map((item) => item.id), ["same-platform"], "标了别的平台的译例应被治理层排除，而不是排后面");
});

test("同样相关时，平台命中的译例排在通用译例前面", () => {
  const ranked = rankTranslationMemories("限时活动将于本周开启", [
    memory({ id: "generic" }),
    memory({ id: "same-platform", platform: "playstation_store" })
  ], { limit: 5, platform: "playstation_store", now: NOW });
  assert.equal(ranked[0].id, "same-platform");
  assert.ok(ranked[0].contextAffinity > ranked[1].contextAffinity);
  assert.equal(ranked[0].similarity, ranked[1].similarity, "相关度本身不应被投放上下文改写");
});

test("活动命中同样参与排序", () => {
  const ranked = rankTranslationMemories("限时活动将于本周开启", [
    memory({ id: "no-campaign" }),
    memory({ id: "same-campaign", campaign: "summer-2026" })
  ], { limit: 5, campaign: "summer-2026", now: NOW });
  assert.equal(ranked[0].id, "same-campaign");
});

test("平台命中不能把不相关的译例推过检索门槛", () => {
  const ranked = rankTranslationMemories("限时活动将于本周开启", [
    memory({ id: "irrelevant", source: "请在设置中绑定手机号", target: "設定で電話番号を登録してください。", platform: "playstation_store" })
  ], { limit: 5, platform: "playstation_store", now: NOW });
  assert.deepEqual(ranked, [], "不相关就是不相关，投放亲和度只排序不放行");
});

test("其余条件相同时，更新的译例优先", () => {
  const ranked = rankTranslationMemories("限时活动将于本周开启", [
    memory({ id: "stale", dateUpdated: "2025-01-01T00:00:00.000Z" }),
    memory({ id: "fresh", dateUpdated: "2026-09-01T00:00:00.000Z" })
  ], { limit: 5, now: NOW });
  assert.equal(ranked[0].id, "fresh");
});

test("不传投放上下文时排序退回原有口径", () => {
  const ranked = rankTranslationMemories("限时活动将于本周开启", [
    memory({ id: "a", platform: "steam", dateUpdated: "2026-08-30T00:00:00.000Z" }),
    memory({ id: "b", platform: "playstation_store", dateUpdated: "2026-08-30T00:00:00.000Z" })
  ], { limit: 5, now: NOW });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].contextAffinity, ranked[1].contextAffinity, "没有投放上下文时两条译例的亲和度应当一致");
});
