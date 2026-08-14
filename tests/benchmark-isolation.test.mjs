import test from "node:test";
import assert from "node:assert/strict";
import { isolateBenchmarkAssets, isSelfDerived, SELF_REFERENCE_SIMILARITY_THRESHOLD } from "../src/benchmark-isolation.mjs";

const CASE_SOURCE = "登录后即可领取每日奖励，请及时查收。";

function memory(id, source, target = "target") {
  return { id, source, target, qualityStatus: "human_approved" };
}

test("同源记忆从评测检索中剔除，其他记忆保留", () => {
  const source = CASE_SOURCE;
  const memories = [
    memory("self-human", source, "人类终稿"),
    memory("self-machine", `  ${source} `, "机器验证稿"),
    memory("other", "充值任意金额即可获得额外奖励", "无关译例"),
    memory("missing-source", undefined)
  ];
  const result = isolateBenchmarkAssets({ source, memories });
  assert.deepEqual(result.memories.map((item) => item.id), ["other", "missing-source"]);
  assert.equal(result.isolation.excludedMemories, 2);
  assert.equal(result.isolation.totalExcluded, 2);
});

test("高度相似（≥阈值）的记忆视为同源自引用并被剔除", () => {
  const long = "这是一段用于评测隔离判定的较长中文文本内容，共二十一个字符";
  assert.ok(isSelfDerived(long, long));
  const variant = `${long.slice(0, long.length - 1)}文`;
  assert.equal(isSelfDerived(long, variant), true, "单字符差异的 21 字长句应达到阈值");
  const dissimilar = "这是一段完全不同的短句";
  assert.equal(isSelfDerived(long, dissimilar), false);
  const source = "这是一条用于测试同源剔除的较长游戏公告文本";
  const memories = [memory("near", source.slice(0, -1) + "稿"), memory("far", "购买月卡可获得每日钻石")];
  const result = isolateBenchmarkAssets({ source, memories });
  assert.deepEqual(result.memories.map((item) => item.id), ["far"]);
  assert.equal(result.isolation.excludedMemories, 1);
});

test("QA 案例同源剔除、异源保留", () => {
  const source = CASE_SOURCE;
  const qaCases = [
    { id: "qa-self", source, rejectedTranslation: "坏", correctedTranslation: "好" },
    { id: "qa-self-2", source: CASE_SOURCE.toUpperCase(), rejectedTranslation: "坏2", correctedTranslation: "好2" },
    { id: "qa-other", source: "另一个句子的原文", rejectedTranslation: "坏3", correctedTranslation: "好3" }
  ];
  const result = isolateBenchmarkAssets({ source, qaCases });
  assert.deepEqual(result.qaCases.map((item) => item.id), ["qa-other"]);
  assert.equal(result.isolation.excludedQaCases, 2);
});

test("风格规范正反例中与留出原文同源的部分被剔除，输入不被修改", () => {
  const source = CASE_SOURCE;
  const profile = {
    id: "style-1",
    name: "风格",
    instruction: "语气亲切",
    examples: [
      { type: "positive", source, target: "泄漏终稿" },
      { type: "negative", source: `  ${source}`, target: "另一个泄漏" },
      { type: "positive", source: "无关例句", target: "保留" }
    ]
  };
  const originalExamples = profile.examples;
  const result = isolateBenchmarkAssets({ source, styleProfile: profile });
  assert.notEqual(result.styleProfile, profile, "有剔除时应返回新对象");
  assert.deepEqual(result.styleProfile.examples.map((item) => item.source), ["无关例句"]);
  assert.deepEqual(profile.examples, originalExamples, "输入 profile 不得被修改");
  assert.equal(result.isolation.excludedStyleExamples, 2);
  assert.equal(result.isolation.excludedUserProfileExamples, 0);
});

test("无同源条目时直接复用原对象引用且不产生剔除计数", () => {
  const source = "全新的一句话";
  const profile = { id: "style-1", examples: [{ source: "其他例句", target: "译" }] };
  const userProfile = { id: "user-1", examples: [{ source: "另一个例句", target: "译" }] };
  const result = isolateBenchmarkAssets({ source, styleProfile: profile, userProfile });
  assert.equal(result.styleProfile, profile);
  assert.equal(result.userProfile, userProfile);
  assert.equal(result.isolation.totalExcluded, 0);
});

test("译者画像同源示例剔除、异源保留", () => {
  const source = CASE_SOURCE;
  const userProfile = {
    id: "user-1",
    instruction: "偏好敬体",
    examples: [
      { source, target: "泄漏终稿" },
      { source: "别的例句", target: "保留译法" }
    ]
  };
  const result = isolateBenchmarkAssets({ source, userProfile });
  assert.deepEqual(result.userProfile.examples.map((item) => item.source), ["别的例句"]);
  assert.equal(result.isolation.excludedUserProfileExamples, 1);
});

test("空输入与空原文安全，不做任何剔除", () => {
  const empty = isolateBenchmarkAssets({ source: "", memories: [memory("m", "任意")] });
  assert.equal(empty.memories.length, 1);
  assert.equal(empty.isolation.totalExcluded, 0);
  const none = isolateBenchmarkAssets({});
  assert.deepEqual(none.memories, []);
  assert.deepEqual(none.qaCases, []);
  assert.equal(none.styleProfile, null);
  assert.equal(none.userProfile, null);
  assert.equal(none.isolation.totalExcluded, 0);
});

test("阈值常量保持在合理区间", () => {
  assert.ok(SELF_REFERENCE_SIMILARITY_THRESHOLD > 0.9 && SELF_REFERENCE_SIMILARITY_THRESHOLD < 1);
});
