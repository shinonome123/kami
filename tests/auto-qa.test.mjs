import test from "node:test";
import assert from "node:assert/strict";
import { alignSegmentPairs, buildAlignmentIssues, calculateAutoQaScores, createStructuralAlignmentScorer, dedupeIssues, groupIssuesByDimension, isGlossDumpLiteral, normalizeQaInputText, runBasicQa, splitQaSegments, summarizeIssues, validateGlossTokens } from "../src/auto-qa.mjs";
import { parseAutoQaLineResponse, parseGrammarLineResponse, validateAlignmentPlan } from "../src/provider.mjs";

test("基本检查：未翻译的完全相同译文记为阻断", () => {
  const issues = runBasicQa({ source: "全新通行证登场", translation: "全新通行证登场" });
  assert.ok(issues.some((issue) => issue.type === "basic_untranslated" && issue.severity === "error"));
});

test("基本检查：受保护内容缺失仍由硬 QA 检出并归入 basic 维度", () => {
  const issues = runBasicQa({ source: "奖励 {{count}} 枚", translation: "報酬を獲得" });
  const missing = issues.find((issue) => issue.type === "protected_token");
  assert.equal(missing.severity, "error");
  assert.equal(missing.dimension, "basic");
});

test("基本检查：原文品牌名未出现在译文时报警告", () => {
  const issues = runBasicQa({ source: "Vanguard 引擎启动", translation: "エンジンを起動します" });
  assert.ok(issues.some((issue) => issue.type === "basic_brand_missing" && issue.message.includes("Vanguard")));
});

test("基本检查：品牌名原样保留或使用术语库登记译法时不报警", () => {
  const kept = runBasicQa({ source: "Vanguard 引擎启动", translation: "Vanguardエンジンを起動します" });
  assert.ok(!kept.some((issue) => issue.type === "basic_brand_missing"));
  const localized = runBasicQa({
    source: "Vanguard 引擎启动",
    translation: "ヴァンガードエンジンを起動します",
    matches: [{ term: { source: "Vanguard", target: "ヴァンガード", aliases: [] } }]
  });
  assert.ok(!localized.some((issue) => issue.type === "basic_brand_missing"));
});

test("基本检查：英文虚词不误报为品牌名", () => {
  const issues = runBasicQa({ source: "up to 10% 奖励", translation: "最大10%の報酬" });
  assert.ok(!issues.some((issue) => issue.type === "basic_brand_missing" && issue.message.includes("to")));
});

test("基本检查：译文新增拉丁专名与常见缩写白名单", () => {
  const flagged = runBasicQa({ source: "活动开启", translation: "イベント開始 GameMode" });
  assert.ok(flagged.some((issue) => issue.type === "basic_added_latin" && issue.message.includes("GameMode")));
  const allowed = runBasicQa({ source: "活动开启", translation: "イベント開始 DLC配信" });
  assert.ok(!allowed.some((issue) => issue.type === "basic_added_latin"));
});

test("基本检查：法语正常词汇不被当成新增拉丁专名", () => {
  const issues = runBasicQa({
    source: "全新高级通行证现已登场！",
    translation: "Le tout nouveau Pass Premium est disponible dès maintenant !",
    locale: "fr-FR",
    matches: [{ term: { source: "高级通行证", target: "Pass Premium", aliases: [] } }]
  });
  assert.ok(!issues.some((issue) => issue.type === "basic_added_latin"));
});

test("基本检查：连续重复字符、配对标点与语气弱化", () => {
  const repeated = runBasicQa({ source: "新的挑战", translation: "新しぃぃぃ挑戦" });
  assert.ok(repeated.some((issue) => issue.type === "basic_repeated_char"));
  const unbalanced = runBasicQa({ source: "领取奖励", translation: "報酬を受け取る（限定" });
  assert.ok(unbalanced.some((issue) => issue.type === "basic_unbalanced_quote"));
  const softened = runBasicQa({ source: "全新通行证现已登场！", translation: "新しいパスが登場しました。" });
  assert.ok(softened.some((issue) => issue.type === "basic_tone"));
});

test("三层打分：无问题全部满分，权重为 20/50/30", () => {
  const scores = calculateAutoQaScores([]);
  assert.equal(scores.overall, 100);
  assert.deepEqual(scores.dimensions, { basic: 100, fidelity: 100, nuance: 100 });
  assert.equal(scores.blockedSegments, 0);
  const weighted = calculateAutoQaScores([{ dimension: "fidelity", severity: "major", confidence: 0.9 }]);
  assert.equal(weighted.dimensions.fidelity, 88);
  assert.equal(weighted.overall, 94);
});

test("三层打分：基本错误封顶 60，忠实性 critical 封顶 65", () => {
  const basicCapped = calculateAutoQaScores([{ dimension: "basic", severity: "error" }]);
  assert.equal(basicCapped.dimensions.basic, 60);
  const fidelityCapped = calculateAutoQaScores([{ dimension: "fidelity", severity: "critical", confidence: 0.9 }]);
  assert.equal(fidelityCapped.dimensions.fidelity, 65);
  const lowConfidence = calculateAutoQaScores([{ dimension: "fidelity", severity: "critical", confidence: 0.4 }]);
  assert.equal(lowConfidence.dimensions.fidelity, 100);
});

test("打分与分组：旧格式无 dimension 的问题归入 basic", () => {
  const issues = [{ severity: "error", message: "空译文" }];
  assert.deepEqual(groupIssuesByDimension(issues).basic, issues);
  assert.equal(summarizeIssues(issues).basic.error, 1);
});

test("语法专项行式降级解析", () => {
  const issues = parseGrammarLineResponse("ISSUE|major|grammar|모티브 한|缺少助词|改为 모티브로 한");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "grammar");
  assert.equal(issues[0].span, "모티브 한");
  assert.equal(issues[0].suggestion, "改为 모티브로 한");
  assert.deepEqual(parseGrammarLineResponse("PASS"), []);
});

test("多路问题去重：同维度同类别同译文片段只保留一条", () => {
  const issues = dedupeIssues([
    { dimension: "basic", category: "grammar", targetSpan: "모티브 한", message: "缺少助词" },
    { dimension: "basic", category: "grammar", targetSpan: "모티브 한", message: "语法不自然" },
    { dimension: "basic", category: "grammar", targetSpan: "모티브로 한", message: "另一处问题" },
    { dimension: "fidelity", category: "omission", targetSpan: "", message: "漏译" }
  ]);
  assert.equal(issues.length, 3);
  assert.equal(issues[0].message, "缺少助词");
});

test("语素拆解校验：词块拼接必须完整覆盖译文，不允许遗漏或增字", () => {
  const valid = validateGlossTokens({ translation: "新しいパスが登場しました", tokens: [
    { surface: "新しい" }, { surface: "パス" }, { surface: "が" }, { surface: "登場しました" }
  ] });
  assert.equal(valid, true);
  const reordered = validateGlossTokens({ translation: "新しいパスが登場しました", tokens: [
    { surface: "新しい" }, { surface: "パス" }, { surface: "登場しました" }
  ] });
  assert.equal(reordered, false);
  const splitAcross = validateGlossTokens({ translation: "新しいパスが登場しました", tokens: [
    { surface: "新しい" }, { surface: "パス" }, { surface: "が" }, { surface: "登場しまし" }, { surface: "た" }
  ] });
  assert.equal(splitAcross, true);
  assert.equal(validateGlossTokens({ translation: "テスト", tokens: [{ surface: "テスト" }, { surface: "余計" }] }), false);
  assert.equal(validateGlossTokens({ translation: "テスト", tokens: [] }), false);
});

test("直译质量检测：释义拼接与标签字样被识别为不合格", () => {
  assert.equal(isGlossDumpLiteral("最近 游戏 话题助词 《 黑色的 神话 : 钟馗 》 的 15 分钟 分量 游戏内 演示 影像 宾格助词 公开 做了"), true);
  assert.equal(isGlossDumpLiteral("新的 通行证 主格 登场 了"), true);
  assert.equal(isGlossDumpLiteral("黑色神话钟馗的15分钟游戏内演示影像被公开了，这是本作首次"), false);
  assert.equal(isGlossDumpLiteral(""), false);
});

test("模型行式降级解析带 dimension 字段", () => {
  const issues = parseAutoQaLineResponse("ISSUE|fidelity|major|omission|奖励|報酬|漏译了奖励|补上奖励");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].dimension, "fidelity");
  assert.equal(issues[0].suggestion, "补上奖励");
  assert.deepEqual(parseAutoQaLineResponse("PASS"), []);
});

test("逐句切分：中文句末标点、换行与韩文句界", () => {
  const zh = splitQaSegments("首先，从名字就能看出。\n其次，它依然是一款标准游戏。再次，从实机演示中。");
  assert.equal(zh.length, 3);
  assert.ok(zh[0].endsWith("。"));
  const ko = splitQaSegments("우선, 이름에서 보시다시피. 다음, 여전히 표준적인 게임입니다. 또한, 최신 영상을 통해. ");
  assert.equal(ko.length, 3);
  assert.equal(ko[1], "다음, 여전히 표준적인 게임입니다.");
  // 数字也可以是下一句的开头；不能把发布日期并入上一句，否则整篇双语对齐会从这里错位
  assert.deepEqual(
    splitQaSegments("배경으로 설정했습니다. 2025년 8월 20일, 첫 CG 예고편을 공개했습니다."),
    ["배경으로 설정했습니다.", "2025년 8월 20일, 첫 CG 예고편을 공개했습니다."]
  );
  // 小数与版本号不应被切断
  assert.deepEqual(splitQaSegments("v2.0 버전입니다. 보상 3.5배 증가"), ["v2.0 버전입니다.", "보상 3.5배 증가"]);
});

test("质检文本清理：保留纯文本与 HTML 的段落换行", () => {
  const plain = "ถาม: คำถามแรก?\r\n\r\nตอบ: คำตอบแรก\r\nถาม: คำถามถัดไป?";
  assert.equal(normalizeQaInputText(plain), "ถาม: คำถามแรก?\n\nตอบ: คำตอบแรก\nถาม: คำถามถัดไป?");
  const html = "<p>ถาม: คำถามแรก?</p><p>ตอบ: คำตอบแรก</p><div>ถาม: คำถามถัดไป?</div>";
  assert.deepEqual(splitQaSegments(normalizeQaInputText(html)), [
    "ถาม: คำถามแรก?",
    "ตอบ: คำตอบแรก",
    "ถาม: คำถามถัดไป?"
  ]);
});

test("对齐：句数相同时一一对应", () => {
  const plan = alignSegmentPairs(3, 3, () => 0.9);
  assert.deepEqual(plan, { pairs: [{ sourceIndices: [0], translationIndices: [0] }, { sourceIndices: [1], translationIndices: [1] }, { sourceIndices: [2], translationIndices: [2] }], unmatchedSource: [], unmatchedTranslation: [] });
});

test("对齐：译文拆句时并入对应原文句，不误报增译", () => {
  // 原文 4 句，译文 6 句：第 4 句译文拆成 3 句
  const score = (i, j) => {
    if (i === 3 && j >= 3) return 0.6; // 译文第 4-6 句都属于原文第 4 句
    if (i < 3 && j === i) return 0.9;
    return 0.05;
  };
  const plan = alignSegmentPairs(4, 6, score);
  assert.deepEqual(plan.unmatchedSource, []);
  assert.deepEqual(plan.unmatchedTranslation, []);
  const last = plan.pairs[plan.pairs.length - 1];
  assert.deepEqual(last, { sourceIndices: [3], translationIndices: [3, 4, 5] });
});

test("对齐：译文合句时并入多句原文，不误报漏译", () => {
  // 原文第 2、3 句在泰文中自然合成一句。
  const score = (i, j) => {
    if (i === 0 && j === 0) return 0.9;
    if ((i === 1 || i === 2) && j === 1) return i === 1 ? 0.9 : 0.65;
    if (i === 3 && j === 2) return 0.9;
    return 0.05;
  };
  const plan = alignSegmentPairs(4, 3, score);
  assert.deepEqual(plan, {
    pairs: [
      { sourceIndices: [0], translationIndices: [0] },
      { sourceIndices: [1, 2], translationIndices: [1] },
      { sourceIndices: [3], translationIndices: [2] }
    ],
    unmatchedSource: [],
    unmatchedTranslation: []
  });
});

test("对齐：真漏译与真增译分别标记", () => {
  // 原文 4 句、译文 3 句：原文第 4 句与任何译文都不相似（漏译）
  const omissionScore = (i, j) => (i < 3 && j === i ? 0.9 : i === 3 ? 0.05 : 0.05);
  const omission = alignSegmentPairs(4, 3, omissionScore);
  assert.deepEqual(omission.unmatchedSource, [3]);
  assert.deepEqual(omission.unmatchedTranslation, []);
  // 原文 3 句、译文 4 句：译文第 4 句与任何原文都不相似（增译）
  const additionScore = (i, j) => (j < 3 && i === j ? 0.9 : j === 3 ? 0.05 : 0.05);
  const addition = alignSegmentPairs(3, 4, additionScore);
  assert.deepEqual(addition.unmatchedSource, []);
  assert.deepEqual(addition.unmatchedTranslation, [3]);
});

test("对齐：无向量时按位置比例近似配对", () => {
  const plan = alignSegmentPairs(4, 6, null);
  assert.equal(plan.pairs.length, 4);
  assert.deepEqual(plan.pairs.map((pair) => pair.translationIndices), [[0], [1], [2, 3], [4, 5]]);
});

test("结构对齐：数字与专名锚点把相邻拆句并回正确原句", () => {
  const source = [
    "游戏由虚幻引擎5开发。",
    "这是系列第二部作品。",
    "2025年8月20日发布首支CG宣传片。",
    "公开15分钟实机演示。",
    "TGS PlayStation展台节选镜头，可前往YouTube、X、Twitter搜索Black Myth。",
    "发售时间待确认。"
  ];
  const translation = [
    "언리얼 엔진 5로 개발했습니다.",
    "시리즈의 두 번째 작품입니다.",
    "2025년 8월 20일 첫 CG 예고편을 공개했습니다.",
    "15분 인게임 영상을 공개했습니다.",
    "TGS PlayStation 부스에서는 일부 장면만 상영했습니다.",
    "YouTube, X, Twitter에서 Black Myth를 검색할 수 있습니다.",
    "출시 시기는 아직 확정되지 않았습니다."
  ];
  const plan = alignSegmentPairs(
    source.length,
    translation.length,
    createStructuralAlignmentScorer(source, translation)
  );
  assert.deepEqual(plan, {
    pairs: [
      { sourceIndices: [0], translationIndices: [0] },
      { sourceIndices: [1], translationIndices: [1] },
      { sourceIndices: [2], translationIndices: [2] },
      { sourceIndices: [3], translationIndices: [3] },
      { sourceIndices: [4], translationIndices: [4, 5] },
      { sourceIndices: [5], translationIndices: [6] }
    ],
    unmatchedSource: [],
    unmatchedTranslation: []
  });
});

test("整句级漏译/增译问题生成", () => {
  const issues = buildAlignmentIssues({
    sourceSegments: ["甲", "乙", "丙"],
    translationSegments: ["가", "나", "다"],
    unmatchedSource: [1],
    unmatchedTranslation: [2]
  });
  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, "critical");
  assert.equal(issues[0].category, "omission");
  assert.ok(issues[0].message.includes("第 2 句"));
  assert.equal(issues[0].confidence, 0.8);
  assert.equal(issues[1].severity, "major");
  assert.equal(issues[1].category, "addition");
});

test("模型对齐方案校验：合法方案通过并规范化，索引重复/越界/缺失被拒绝", () => {
  const valid = validateAlignmentPlan({
    pairs: [{ sourceIndices: [1], translationIndices: [3, 4] }, { sourceIndices: [0], translationIndices: [0] }],
    unmatchedSource: [2], unmatchedTranslation: [1, 2]
  }, 3, 5);
  assert.deepEqual(valid, {
    pairs: [{ sourceIndices: [0], translationIndices: [0] }, { sourceIndices: [1], translationIndices: [3, 4] }],
    unmatchedSource: [2], unmatchedTranslation: [1, 2]
  });
  assert.equal(validateAlignmentPlan({ pairs: [{ sourceIndices: [0], translationIndices: [0] }], unmatchedSource: [], unmatchedTranslation: [] }, 2, 1), null);
  assert.equal(validateAlignmentPlan({ pairs: [{ sourceIndices: [0, 0], translationIndices: [0] }], unmatchedSource: [], unmatchedTranslation: [] }, 1, 1), null);
  assert.equal(validateAlignmentPlan({ pairs: [{ sourceIndices: [5], translationIndices: [0] }], unmatchedSource: [], unmatchedTranslation: [] }, 1, 1), null);
  assert.equal(validateAlignmentPlan(null, 1, 1), null);
});

test("文档总分：全部句子的问题统一计入并套用封顶", () => {
  const allIssues = [
    { dimension: "fidelity", severity: "critical", confidence: 0.9 },
    { dimension: "basic", severity: "warning" },
    { dimension: "nuance", severity: "major", confidence: 0.8 }
  ];
  const scores = calculateAutoQaScores(allIssues);
  assert.equal(scores.dimensions.fidelity, 65);
  assert.equal(scores.dimensions.basic, 97);
  assert.equal(scores.dimensions.nuance, 88);
  assert.equal(scores.overall, Math.round(97 * 0.2 + 65 * 0.5 + 88 * 0.3));
});

test("按段平均：同样质量的长文档不再因为段多而崩到零分", () => {
  // 16 段，每段一条 major(12)。旧算法累加 192 分直接归零；现在每段各扣 12。
  const issues = Array.from({ length: 16 }, (_, index) => ({
    dimension: "fidelity", severity: "major", confidence: 0.9, segmentIndex: index + 1
  }));
  assert.equal(calculateAutoQaScores(issues, { segmentCount: 16 }).dimensions.fidelity, 88);
  assert.equal(calculateAutoQaScores(issues).dimensions.fidelity, 88, "问题自带段号时按出现过的段号推断段数");
});

test("坏掉一段只影响 1/段数，不会拖垮整份文档", () => {
  const issues = Array.from({ length: 10 }, () => ({
    dimension: "fidelity", severity: "major", confidence: 0.9, segmentIndex: 3
  }));
  const scores = calculateAutoQaScores(issues, { segmentCount: 16 });
  assert.equal(scores.dimensions.fidelity, 94, "该段扣到 0，其余 15 段满分");
  assert.equal(scores.blockedSegments, 0, "major 不算阻断");
});

test("阻断问题让文档封顶 65，坏得越多分数越低", () => {
  const one = calculateAutoQaScores(
    [{ dimension: "fidelity", severity: "critical", confidence: 0.9, segmentIndex: 1 }],
    { segmentCount: 16 }
  );
  const all = calculateAutoQaScores(
    Array.from({ length: 16 }, (_, index) => ({ dimension: "fidelity", severity: "critical", confidence: 0.9, segmentIndex: index + 1 })),
    { segmentCount: 16 }
  );
  assert.equal(one.dimensions.fidelity, 65, "单条 critical 不被平均稀释，仍然封顶");
  assert.equal(all.dimensions.fidelity, 65, "全坏时平均值正好等于封顶");
  assert.equal(one.blockedSegments, 1);
  assert.equal(all.blockedSegments, 16, "单一分数会饱和，靠 blockedSegments 区分坏一段还是全坏");
});

test("每段两条 critical 时平均值压到封顶以下", () => {
  const issues = Array.from({ length: 16 }, (_, index) => index + 1).flatMap((segmentIndex) => [
    { dimension: "fidelity", severity: "critical", confidence: 0.9, segmentIndex },
    { dimension: "fidelity", severity: "critical", confidence: 0.9, segmentIndex }
  ]);
  assert.equal(calculateAutoQaScores(issues, { segmentCount: 16 }).dimensions.fidelity, 30);
});

test("单段文档行为不变，段数缺省与显式传 1 一致", () => {
  const issues = [{ dimension: "basic", severity: "major", confidence: 0.9 }];
  const a = calculateAutoQaScores(issues);
  const b = calculateAutoQaScores(issues, { segmentCount: 1 });
  assert.equal(a.overall, b.overall);
  assert.deepEqual(a.dimensions, b.dimensions);
});

test("整句漏译这类不属于任何段的问题各占一格分母，不会被段内平均吃掉", () => {
  const scores = calculateAutoQaScores([
    { dimension: "fidelity", severity: "critical", confidence: 0.9, segmentIndex: "alignment-0" },
    { dimension: "fidelity", severity: "critical", confidence: 0.9, segmentIndex: "alignment-1" }
  ], { segmentCount: 8 });
  assert.equal(scores.blockedSegments, 2);
  assert.equal(scores.dimensions.fidelity, 65, "8 段满分 + 2 格各 65，平均 93 后被阻断封顶压到 65");
});

test("非法段数回落为 1，不会因为除零产生 NaN", () => {
  const issues = [{ dimension: "nuance", severity: "minor", confidence: 0.9 }];
  for (const segmentCount of [0, -3, NaN, "abc", null]) {
    assert.equal(calculateAutoQaScores(issues, { segmentCount }).dimensions.nuance, 97);
  }
});
