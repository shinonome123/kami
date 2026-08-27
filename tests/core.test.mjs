import test from "node:test";
import assert from "node:assert/strict";
import { classifyContent, contentTypeFromDescriptor, descriptorFromContext, inferDomainFromText, resolveDomain } from "../src/classifier.mjs";
import { LOCALES } from "../src/config.mjs";
import { buildContextPack } from "../src/context-pack.mjs";
import { refineCorpus } from "../src/corpus.mjs";
import { matchTerms } from "../src/matcher.mjs";
import { runQa } from "../src/qa.mjs";
import { detectRhymeLike } from "../src/text.mjs";

const jaAssets = {
  locale: "ja-JP",
  terms: [{
    id: "ja-1",
    source: "高级通行证",
    aliases: ["高级战令"],
    target: "プレミアムパス",
    forbidden: ["高級パス"],
    domains: ["game"],
    contentTypes: ["marketing"],
    enforcement: "required",
    status: "approved"
  }]
};

const koAssets = {
  locale: "ko-KR",
  terms: [{
    id: "ko-1",
    source: "高级通行证",
    aliases: [],
    target: "프리미엄 패스",
    forbidden: [],
    domains: ["game"],
    contentTypes: ["marketing"],
    enforcement: "required",
    status: "approved"
  }]
};

test("自动识别公告与游戏道具语体", () => {
  assert.equal(classifyContent("服务器将于8月15日进行停机维护。感谢各位玩家的理解。", "auto").contentType, "announcement");
  assert.equal(classifyContent("使用后提升20%攻击力，持续10秒。", "auto").contentType, "item_description");
});

test("人工指定语体优先于自动规则", () => {
  const result = classifyContent("限时活动现已开启", "announcement");
  assert.equal(result.contentType, "announcement");
  assert.equal(result.source, "manual");
});

test("主分类与细标签能识别诗词、图鉴、商店和教程", () => {
  const verse = classifyContent("威凛凛，气堂堂，花身电目逞凶狂。", "auto");
  assert.equal(verse.contentType, "verse");
  assert.ok(verse.contentTags.includes("rhyme"));

  const codex = classifyContent("相传此妖久居山中。", "auto", { sourceFile: "Portraits 影神图 Chapter 4.xlsx" });
  assert.equal(codex.contentType, "codex");
  assert.ok(codex.contentTags.includes("lore_entry"));

  assert.equal(classifyContent("本版本包含完整游戏本体与追加内容。", "auto").contentType, "store");
  assert.equal(classifyContent("长按按钮即可发动技能。", "auto").contentType, "tutorial");
});

test("跨主分类术语可以参考，但不会成为强制术语", () => {
  const matches = matchTerms("购买高级通行证即可领取奖励", jaAssets, { contentType: "store", domain: "game" });
  assert.equal(matches[0].scopeMismatch, true);
  const pack = buildContextPack({ source: "购买高级通行证即可领取奖励", locale: "ja-JP", classification: classifyContent("购买高级通行证即可领取奖励", "store"), matches, domain: "game" });
  assert.equal(pack.requiredTerms.length, 0);
  assert.equal(pack.preferredTerms.length, 1);
  assert.match(pack.preferredTerms[0].note, /跨场景参考/);
});

test("同一中文源词在不同语言资产库中只返回当前目标语言", () => {
  const jaMatches = matchTerms("全新高级通行证现已登场", jaAssets, { contentType: "marketing", domain: "game" });
  const koMatches = matchTerms("全新高级通行证现已登场", koAssets, { contentType: "marketing", domain: "game" });
  assert.equal(jaMatches[0].locale, "ja-JP");
  assert.equal(jaMatches[0].term.target, "プレミアムパス");
  assert.equal(koMatches[0].locale, "ko-KR");
  assert.equal(koMatches[0].term.target, "프리미엄 패스");
  assert.ok(!JSON.stringify(jaMatches).includes("프리미엄"));
});

test("别名能够命中同一个批准术语", () => {
  const matches = matchTerms("购买高级战令即可领取奖励", jaAssets, { contentType: "marketing", domain: "game" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].variant, "高级战令");
  assert.equal(matches[0].term.target, "プレミアムパス");
});

test("字符重排产生智能候选，但不会升级为强制术语", () => {
  const assets = { locale: "ja-JP", terms: [{ id: "smart-1", source: "数字豪华版", aliases: [], target: "デジタルデラックス版", forbidden: [], domains: ["game"], contentTypes: ["marketing"], enforcement: "required", status: "approved" }] };
  const matches = matchTerms("豪华数字版现已推出", assets, { contentType: "marketing", domain: "game" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].mode, "smart");
  assert.equal(matches[0].matchPhrase, "豪华数字版");
  const pack = buildContextPack({ source: "豪华数字版现已推出", locale: "ja-JP", classification: classifyContent("豪华数字版现已推出", "marketing"), matches, domain: "game" });
  assert.equal(pack.requiredTerms.length, 0);
  assert.equal(pack.preferredTerms[0].target, "デジタルデラックス版");
  const issues = runQa({ source: "豪华数字版现已推出", translation: "デジタル豪華エディションが登場", matches });
  assert.ok(issues.some((issue) => issue.type === "potential_term" && issue.severity === "warning"));
  assert.ok(!issues.some((issue) => issue.type === "required_term"));
});

test("Context Pack 强制携带目标 locale 且只注入当前语言译法", () => {
  const classification = classifyContent("全新高级通行证现已登场", "marketing");
  const matches = matchTerms("全新高级通行证现已登场", jaAssets, { contentType: "marketing", domain: "game" });
  const pack = buildContextPack({ source: "全新高级通行证现已登场", locale: "ja-JP", classification, matches, domain: "game" });
  assert.equal(pack.targetLocale, "ja-JP");
  assert.equal(pack.requiredTerms[0].target, "プレミアムパス");
  assert.ok(!JSON.stringify(pack).includes("프리미엄"));
});

test("批次 Context Pack 同时携带结构化上下文、术语和风格配置", () => {
  const source = "全新高级通行证现已登场";
  const classification = classifyContent(source, "marketing");
  const matches = matchTerms(source, jaAssets, { contentType: "marketing", domain: "game" });
  const pack = buildContextPack({
    source,
    locale: "ja-JP",
    classification,
    matches,
    domain: "game",
    neighborContext: { previous: "活动即将开始。", next: "完成任务可领取奖励。", document: "公告.docx", segmentIndex: 2, segmentCount: 3 },
    styleProfile: { id: "launch-copy", name: "版本宣发风格", source: "style-library", instruction: "轻快、有期待感，CTA 克制。" }
  });
  assert.equal(pack.neighborContext.previous, "活动即将开始。");
  assert.equal(pack.neighborContext.next, "完成任务可领取奖励。");
  assert.equal(pack.styleProfile.id, "launch-copy");
  assert.equal(pack.styleProfile.instruction, "轻快、有期待感，CTA 克制。");
  assert.equal(pack.requiredTerms[0].target, "プレミアムパス");
});

test("Context Pack 注入当前范围的翻译技能版本与增量规则", () => {
  const source = "别怕，我在这儿。";
  const pack = buildContextPack({
    source,
    locale: "ja-JP",
    classification: classifyContent(source, "dialogue"),
    matches: [],
    domain: "game",
    translationSkill: {
      id: "skill-ja-dialogue-v2",
      name: "日语对白技能",
      version: 2,
      promptVersion: "kami-translation-v1",
      strategy: {
        prompting: {
          additionalInstruction: "保持角色口语节奏，避免说明文腔。",
          additionalRules: ["称谓必须结合说话人关系判断。"]
        }
      }
    }
  });
  assert.equal(pack.translationSkill.id, "skill-ja-dialogue-v2");
  assert.equal(pack.translationSkill.version, 2);
  assert.deepEqual(pack.translationSkill.additionalRules, ["称谓必须结合说话人关系判断。"]);
});

test("各语言本地化示范结构完整且源文一致", () => {
  for (const locale of ["ja-JP", "ko-KR", "zh-Hant-TW", "fr-FR"]) {
    const examples = LOCALES[locale].localizationExamples || [];
    assert.ok(examples.length >= 2, `${locale} 应至少有两组示范`);
    for (const example of examples) {
      assert.ok(example.source && example.literal && example.idiomatic && example.note, "示例字段必须齐全");
      assert.notEqual(example.literal, example.idiomatic, "直译与地道译法必须不同，示范才有意义");
    }
  }
  assert.deepEqual(LOCALES["th-TH"].localizationExamples, []);
});

test("顺口溜/韵文结构检测保守且不误伤普通对话", () => {
  assert.equal(detectRhymeLike("走走走，游游游，甘为铜钱做马牛。"), true, "3+3+7 顺口溜");
  assert.equal(detectRhymeLike("一二三四，五六七八，九十百千万事如意。"), true, "4+4+7 口诀");
  assert.equal(detectRhymeLike("买买买，买买买，买买买"), true, "二字块三连重复");
  assert.equal(detectRhymeLike("你好，朋友，我们一起玩。"), false, "2+2+5 普通对话不误伤");
  assert.equal(detectRhymeLike("全新限定皮肤现已上架。"), false);
  assert.equal(detectRhymeLike(""), false);
  assert.equal(detectRhymeLike("哈哈哈，太有趣了。"), false);
});

test("Context Pack 标记韵律结构供提示词与 AIQA 使用", () => {
  const rhymePack = buildContextPack({ source: "走走走，游游游，甘为铜钱做马牛。", locale: "ja-JP", classification: classifyContent("走走走，游游游，甘为铜钱做马牛。", "dialogue"), matches: [], domain: "game" });
  assert.equal(rhymePack.rhymeLike, true);
  const plainPack = buildContextPack({ source: "别怕，我在这儿。", locale: "ja-JP", classification: classifyContent("别怕，我在这儿。", "dialogue"), matches: [], domain: "game" });
  assert.equal(plainPack.rhymeLike, false);
});

test("QA 检出缺失强制术语、数字和禁用译法", () => {
  const matches = matchTerms("高级通行证提升20%攻击力", jaAssets, { contentType: "marketing", domain: "game" });
  const issues = runQa({ source: "高级通行证提升20%攻击力", translation: "高級パスで攻撃力が上昇します。", matches });
  assert.ok(issues.some((issue) => issue.type === "required_term"));
  assert.ok(issues.some((issue) => issue.type === "forbidden_term"));
  assert.ok(issues.some((issue) => issue.type === "protected_token"));
});

test("疑似术语 QA 保留自动裁决所需的源词和正式译法", () => {
  const issues = runQa({
    source: "追加豪华内容",
    translation: "デラックスコンテンツを追加する",
    matches: [{ mode: "smart", matchPhrase: "豪华内容", term: { source: "数字豪华版", target: "デジタルデラックス版", enforcement: "required", forbidden: [] } }]
  });
  const issue = issues.find((item) => item.type === "potential_term");
  assert.equal(issue.matchedSource, "豪华内容");
  assert.equal(issue.sourceTerm, "数字豪华版");
  assert.equal(issue.targetTerm, "デジタルデラックス版");
});

test("语料炼化保留分段并产生重复短语候选", () => {
  const result = refineCorpus("高级通行证现已登场。购买高级通行证可领取奖励。高级通行证奖励将在活动结束后发放。", { minFrequency: 2 });
  assert.equal(result.segments.length, 3);
  assert.ok(result.candidates.some((candidate) => candidate.term === "高级通行证"));
});

test("需求表声明的用途优先于从正文猜测的语体", () => {
  // 实测样本三行全部猜错：视频标题→general、导航栏文本→item_name、FAQ文本→dialogue
  const cases = [
    ["视频标题", "社媒", "marketing"],
    ["导航栏文本", "B2官网", "ui"],
    ["FAQ文本", "B2官网", "general"],
    ["道具描述", "", "item_description"],
    ["道具名", "", "item_name"],
    ["角色对白", "", "dialogue"],
    ["活动规则", "", "rules"]
  ];
  for (const [descriptor, location, expected] of cases) {
    const result = classifyContent("《黑神话：钟馗》X分钟实机演示", "auto", { descriptor, location });
    assert.equal(result.contentType, expected, `${descriptor} 应判为 ${expected}`);
    assert.equal(result.source, "descriptor");
    assert.ok(result.confidence >= 0.86, "声明用途的置信度要高到不再触发模型兜底");
  }
});

test("描述列比位置列更具体，冲突时描述赢", () => {
  assert.equal(contentTypeFromDescriptor("视频标题", "社媒").contentType, "marketing");
  assert.equal(contentTypeFromDescriptor("", "社媒").contentType, "social");
});

test("更具体的描述优先：道具描述不会被道具名规则抢走", () => {
  assert.equal(contentTypeFromDescriptor("道具描述").contentType, "item_description");
  assert.equal(contentTypeFromDescriptor("道具名称").contentType, "item_name");
});

test("英文用途词与缩写按完整含义匹配，不会被单词内部误命中", () => {
  assert.equal(contentTypeFromDescriptor("guide 文案").contentType, "tutorial", "guide 现在属于教程分类，而不是误命中 UI");
  assert.equal(contentTypeFromDescriptor("PVP 说明"), null, "PVP 里的 pv 不算预告片");
  assert.equal(contentTypeFromDescriptor("UI 按钮").contentType, "ui");
  assert.equal(contentTypeFromDescriptor("宣传 PV 标题").contentType, "marketing");
  // 只有缩写本身、没有别的关键词的列名：这两条曾因词边界被写坏而永远匹配不上，
  // 上面几例却因为「按钮」「标题」命中了同一条正则的其它分支，把故障盖了过去。
  assert.equal(contentTypeFromDescriptor("UI").contentType, "ui");
  assert.equal(contentTypeFromDescriptor("PV").contentType, "marketing");
  assert.equal(contentTypeFromDescriptor("游戏UI").contentType, "ui", "中文紧邻英文缩写时同样算整词");
  assert.equal(contentTypeFromDescriptor("活动PV脚本").contentType, "marketing");
});

test("人工指定语体仍然压过表格声明", () => {
  const result = classifyContent("任意文本", "dialogue", { descriptor: "导航栏文本" });
  assert.equal(result.contentType, "dialogue");
  assert.equal(result.source, "manual");
});

test("没有可用描述时回落到正文启发式，不改变原有行为", () => {
  const withEmpty = classifyContent("限时活动现已开启", "auto", { descriptor: "", location: "" });
  const without = classifyContent("限时活动现已开启");
  assert.equal(withEmpty.contentType, without.contentType);
  assert.equal(withEmpty.source, "heuristic");
});

test("从 Context Pack 的相邻元数据里认出位置与描述列", () => {
  const picked = descriptorFromContext({
    metadata: [
      { label: "位置", value: "社媒", role: "context" },
      { label: "描述", value: "视频标题", role: "context" },
      { label: "DDL", value: "2026-08-18", role: "constraint" }
    ]
  });
  assert.equal(picked.descriptor, "视频标题");
  assert.equal(picked.location, "社媒");
});

test("没有元数据时返回空串而不是抛错", () => {
  assert.deepEqual(descriptorFromContext(), { descriptor: "", location: "" });
  assert.deepEqual(descriptorFromContext({ metadata: null }), { descriptor: "", location: "" });
});

test("业务领域此前完全没有自动识别，现在与语体同构地判定", () => {
  assert.equal(resolveDomain("任意正文", "auto", { contentType: "marketing" }).source, "content-type");
  assert.equal(resolveDomain("任意正文", "auto", { contentType: "marketing" }).domain, "marketing");
  assert.equal(resolveDomain("任意正文", "auto", { contentType: "social" }).domain, "community");
  assert.equal(resolveDomain("道具与装备说明", "auto", { contentType: "general" }).domain, "game");
  assert.equal(resolveDomain("欢迎关注我们的社媒账号", "auto", { contentType: "general" }).domain, "community");
});

test("人工指定领域压过一切推断", () => {
  const result = resolveDomain("道具与装备说明", "community", { contentType: "marketing" });
  assert.equal(result.domain, "community");
  assert.equal(result.source, "manual");
});

test("非法领域值不会被当成真实领域存下去", () => {
  for (const bad of ["auto", "", null, undefined, "不存在的领域"]) {
    const result = resolveDomain("无线索文本", bad, { contentType: "ui" });
    assert.ok(["game", "general", "marketing", "community"].includes(result.domain), `${bad} 应回落到合法领域`);
  }
  assert.equal(resolveDomain("无线索文本", "auto", { contentType: "ui" }).source, "fallback");
});

test("翻译与术语导入共用同一份领域规则", () => {
  assert.equal(inferDomainFromText("道具与装备说明", "general", { fallback: "general" }), "game");
  assert.equal(inferDomainFromText("无任何线索", "general", { fallback: "general" }), "general");
  assert.equal(inferDomainFromText("无任何线索", "general", { fallback: "game" }), "game", "导入侧按 assetType 传不同兜底");
});

function scaleAssets(count, extras = []) {
  const terms = Array.from({ length: count }, (_, index) => ({
    id: `bulk-${index}`, source: `无关术语${index}`, aliases: [], target: `T${index}`,
    forbidden: [], domains: ["game"], contentTypes: ["general"], enforcement: "preferred", status: "approved", note: ""
  }));
  return { locale: "ja-JP", terms: [...terms, ...extras], memories: [], styleExamples: [] };
}

test("大术语库不改变匹配结果：命中的仍然命中", () => {
  // 廉价前置筛选只能剔除"字符重合度低到不可能达标"的术语，
  // 不能让真正该命中的漏掉。
  const real = {
    id: "pass", source: "高级通行证", aliases: ["高级战令"], target: "プレミアムパス",
    forbidden: [], domains: ["game"], contentTypes: ["general"], enforcement: "required", status: "approved", note: ""
  };
  const source = "高级通行证现已开放购买";
  const small = matchTerms(source, scaleAssets(5, [real]), { contentType: "general", domain: "game" });
  const large = matchTerms(source, scaleAssets(5_000, [real]), { contentType: "general", domain: "game" });
  assert.equal(small.length, 1);
  assert.deepEqual(
    large.map((item) => [item.term.id, item.mode]),
    small.map((item) => [item.term.id, item.mode]),
    "术语库从 5 条涨到 5000 条，命中集合必须完全一致"
  );
});

test("错字与字符重排在大术语库下仍走模糊/智能路径", () => {
  // 前置筛选只剔除字符重合度过低的候选，必须放行这三类真实命中。
  // 注意阈值是实测出来的：4 字词错 1 字相似度 0.75，低于 0.78 的模糊阈值本就不命中，
  // 所以这里用 5 字词，错 1 字为 0.8 才真正进入模糊路径。
  const term = {
    id: "pass", source: "高级通行证", aliases: [], target: "プレミアムパス",
    forbidden: [], domains: ["game"], contentTypes: ["general"], enforcement: "preferred", status: "approved", note: ""
  };
  for (const [source, expected, label] of [
    ["购买高级通行证", "exact", "精确"],
    ["购买高级通行証", "fuzzy", "错字"],
    ["购买高级行通证", "smart", "字符重排"]
  ]) {
    const small = matchTerms(source, scaleAssets(5, [term]), { contentType: "general", domain: "game" });
    const large = matchTerms(source, scaleAssets(5_000, [term]), { contentType: "general", domain: "game" });
    assert.equal(small[0]?.mode, expected, `${label}情形应走 ${expected} 路径`);
    assert.equal(large[0]?.mode, expected, `${label}情形在 5000 条术语下必须得到同样结果`);
  }
});

test("大术语库在合理时间内完成匹配", () => {
  // 加前置筛选前实测：1 万条术语单句要 10 秒，模型还没开始调用。
  const assets = scaleAssets(10_000);
  const started = Date.now();
  matchTerms("《黑神话：钟馗》高级通行证限时七折，停机维护后可在商城领取道具。", assets, { contentType: "general", domain: "game" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `1 万条术语的单句匹配耗时 ${elapsed}ms，已回到秒级以上，前置筛选可能被破坏`);
});
