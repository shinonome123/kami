import test from "node:test";
import assert from "node:assert/strict";
import { aggregateScope, classifyExistingAsset, inferStyleScopeFromText, inferTermScopes } from "../src/content-taxonomy-migration.mjs";

test("历史诗词会从 general 或 dialogue 迁入 verse", () => {
  for (const current of ["general", "dialogue"]) {
    const result = classifyExistingAsset({ source: "威凛凛，气堂堂，花身电目逞凶狂。", content_type: current });
    assert.equal(result.contentType, "verse");
    assert.ok(result.contentTags.includes("rhyme"));
  }
});

test("影神图来源优先迁入图鉴，但普通既有专用分类保持不变", () => {
  assert.equal(classifyExistingAsset({ source: "相传此妖盘踞山中。", content_type: "dialogue", source_file: "Portraits 影神图 Chapter 6.xlsx" }).contentType, "codex");
  assert.equal(classifyExistingAsset({ source: "服务器维护结束。", content_type: "announcement" }).contentType, "announcement");
});

test("术语根据真实出现位置形成多分类作用域", () => {
  const result = inferTermScopes({ source: "高级通行证", content_types: ["general"] }, [
    { source: "购买高级通行证即可领取奖励", contentType: "store", contentTags: ["purchase_flow"] },
    { source: "高级通行证版本包含追加内容", contentType: "store", contentTags: ["edition_description"] },
    { source: "全新高级通行证现已登场", contentType: "marketing", contentTags: ["campaign_copy"] },
    { source: "高级通行证限时开售", contentType: "marketing", contentTags: ["campaign_copy"] }
  ]);
  assert.deepEqual(result.contentTypes, ["marketing", "store"]);
  assert.equal(result.evidenceCount, 4);
  assert.ok(result.contentTags.includes("purchase_flow"));
});

test("没有句段命中时，术语用来源文件兜底分类", () => {
  const codex = inferTermScopes({ source: "大石敢当", content_types: ["general"], provenance: "table-import:Portraits 影神图 Chapter 6.xlsx" }, []);
  assert.deepEqual(codex.contentTypes, ["codex"]);
  assert.deepEqual(codex.contentTags, ["character_codex"]);

  const dialogue = inferTermScopes({ source: "高老庄", content_types: ["general"], provenance: "table-import:Epilogue 结局.xlsx" }, []);
  assert.deepEqual(dialogue.contentTypes, ["dialogue"]);
  assert.deepEqual(dialogue.contentTags, ["cinematic_dialogue"]);
});

test("术语细标签只保留所选主分类下的标签", () => {
  const result = inferTermScopes({ source: "火焰山", content_types: ["general"] }, [
    { source: "火焰山中烈火熊熊", contentType: "codex", contentTags: ["location_codex"] },
    { source: "火焰山中烈火熊熊", contentType: "codex", contentTags: ["location_codex"] },
    { source: "火焰山", contentType: "general", contentTags: ["unclassified"] }
  ]);
  assert.deepEqual(result.contentTypes, ["codex"]);
  assert.deepEqual(result.contentTags, ["location_codex"]);
});

test("风格证据聚合会给出主分类占比与细标签", () => {
  const result = aggregateScope([
    { contentType: "dialogue", contentTags: ["cinematic_dialogue"] },
    { contentType: "dialogue", contentTags: ["combat_bark"] },
    { contentType: "verse", contentTags: ["rhyme"] }
  ]);
  assert.equal(result.dominantType, "dialogue");
  assert.equal(result.dominantShare, 2 / 3);
  assert.ok(result.contentTags.includes("cinematic_dialogue"));
});

test("风格规范正文能区分宣发、商店与混合规则", () => {
  const marketing = inferStyleScopeFromText("促销文案中的折扣需本地化；节庆祝福应改写为自然的宣传文案。版本名保持一致。");
  assert.equal(marketing.dominantType, "marketing");
  assert.ok(marketing.dominantShare >= 0.55);

  const store = inferStyleScopeFromText("游戏商店的商品描述必须区分游戏本体、版本名、升级包和购买入口。");
  assert.equal(store.dominantType, "store");
  assert.ok(store.dominantShare >= 0.55);

  const mixed = inferStyleScopeFromText("公告类文本用礼貌语气；叙事文本保持信息顺序。");
  assert.ok(mixed.dominantShare < 0.55);
});
