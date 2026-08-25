import test from "node:test";
import assert from "node:assert/strict";
import { buildAdoptedStyleEvidence, buildKnownIssueFeedbackRequest, presentKnownIssue, selectKnownIssues } from "../src/share-feedback.mjs";

const issues = [
  { severity: "critical", category: "omission", message: "遗漏发布时间", suggestion: "补充 2025 年 8 月 20 日" },
  { severity: "minor", type: "tone", message: "语气略显生硬", suggestion: "改用更自然的敬体" }
];

test("已知问题选择只接受服务端存在的索引，并去重", () => {
  assert.deepEqual(selectKnownIssues(issues, [1, 0, 1, -1, 99, "x"]), [
    { issueIndex: 1, severity: "minor", category: "语气", message: "语气略显生硬", suggestion: "改用更自然的敬体" },
    { issueIndex: 0, severity: "critical", category: "漏译", message: "遗漏发布时间", suggestion: "补充 2025 年 8 月 20 日" }
  ]);
});

test("只勾选已知问题也能形成可提交反馈", () => {
  const selected = selectKnownIssues(issues, [0]);
  assert.equal(
    buildKnownIssueFeedbackRequest(selected, ""),
    "复核后仍需处理以下已知问题：\n1. [漏译] 遗漏发布时间；建议：补充 2025 年 8 月 20 日"
  );
});

test("历史泰文问题说明在分享页转换为中文，泰文只保留为证据片段", () => {
  const presented = presentKnownIssue({
    severity: "major",
    category: "date format",
    targetSpan: "วันที่ 820",
    message: "รูปแบบวันที่ไม่ถูกต้องและไม่สอดคล้องกับการเขียนวันที่ในภาษาไทย；建议：แก้ไขรูปแบบวันที่",
    suggestion: "แก้เป็น วันที่ 20 สิงหาคม"
  });
  assert.equal(presented.displayCategory, "日期格式");
  assert.equal(presented.displayMessage, "该处日期或数字表达可能不够明确，或与原文含义不一致。");
  assert.equal(presented.displaySuggestion, "请改为明确、无歧义且与原文含义一致的日期写法。");
  assert.doesNotMatch(presented.displayMessage + presented.displaySuggestion, /[\u0e00-\u0e7f]/u);
  assert.equal(presented.targetSpan, "วันที่ 820");
});

test("已有清晰中文问题说明原样保留，并去掉拼进 message 的重复建议", () => {
  const presented = presentKnownIssue({
    category: "basic",
    message: "译文出现了原文没有的拉丁词 Game；建议：确认是否为专名",
    suggestion: "确认是专名保留还是多余增译"
  });
  assert.equal(presented.displayCategory, "基础检查");
  assert.equal(presented.displayMessage, "译文出现了原文没有的拉丁词 Game");
  assert.equal(presented.displaySuggestion, "确认是专名保留还是多余增译");
});

test("没有勾选时仍可提交新的补充要求", () => {
  assert.equal(buildKnownIssueFeedbackRequest([], "  请统一使用敬语体  "), "补充要求：请统一使用敬语体");
  assert.equal(buildKnownIssueFeedbackRequest([], ""), "");
});

const share = { locale: "ja-JP", contentType: "marketing", domain: "game", batchId: "batch-9" };

test("同事给出改写时：改写为正例，原译文作为被替换的机器初稿一并留存", () => {
  const evidence = buildAdoptedStyleEvidence({
    share,
    feedback: { suggestedTranslation: "プレミアムパスの販売を開始しました。", request: "语气太生硬" },
    segment: { source: "高级通行证现已开放购买", translation: "高級パスが購入可能になりました。" }
  });
  assert.equal(evidence.polarity, "positive");
  assert.equal(evidence.target, "プレミアムパスの販売を開始しました。");
  assert.equal(evidence.machineTranslation, "高級パスが購入可能になりました。", "改动前后都留下来，差异才是风格信号");
  assert.equal(evidence.provenance, "human-accept");
  assert.equal(evidence.note, "");
});

test("同事只提问题没给译法时：被否决的译文只能作反例，绝不能当正例入池", () => {
  const evidence = buildAdoptedStyleEvidence({
    share,
    feedback: { suggestedTranslation: "", request: "这句翻译腔太重，读起来不像日语原生文案" },
    segment: { source: "高级通行证现已开放购买", translation: "高級パスが購入可能になりました。" }
  });
  assert.equal(evidence.polarity, "negative");
  assert.equal(evidence.target, "高級パスが購入可能になりました。");
  assert.equal(evidence.machineTranslation, "", "没有任何人写出更好的版本，不存在被替换关系");
  assert.equal(evidence.provenance, "colleague-reject");
  assert.match(evidence.note, /翻译腔/, "保留否决理由，蒸馏时才知道被否的是什么");
});

test("改写与原译文完全相同时不伪造改动记录", () => {
  const same = "高級パスが購入可能になりました。";
  const evidence = buildAdoptedStyleEvidence({
    share,
    feedback: { suggestedTranslation: same },
    segment: { source: "高级通行证现已开放购买", translation: same }
  });
  assert.equal(evidence.polarity, "positive");
  assert.equal(evidence.machineTranslation, "", "没改就是没改，不能给蒸馏一个空 diff");
});

test("作用域与批次原样透传，反馈理由按上限截断", () => {
  const evidence = buildAdoptedStyleEvidence({
    share,
    feedback: { suggestedTranslation: "", request: "长".repeat(2_000) },
    segment: { source: "原文", translation: "译文" }
  });
  assert.equal(evidence.locale, "ja-JP");
  assert.equal(evidence.contentType, "marketing");
  assert.equal(evidence.domain, "game");
  assert.equal(evidence.batchId, "batch-9");
  assert.equal(evidence.note.length, 800);
});

test("分段丢失时不抛错，产出可被上游校验拦下的空证据", () => {
  const evidence = buildAdoptedStyleEvidence({ share, feedback: { suggestedTranslation: "" }, segment: null });
  assert.equal(evidence.source, "");
  assert.equal(evidence.target, "");
  assert.equal(evidence.polarity, "negative");
});
