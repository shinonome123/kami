import test from "node:test";
import assert from "node:assert/strict";
import { classifyChange, isNegativeEvidence, positiveEvidenceOnly, shapeDistillEvidence } from "../src/style-delta.mjs";

test("按有无机器初稿及是否改动区分证据类型", () => {
  assert.equal(classifyChange({ target: "定稿", machineTranslation: "初稿" }), "revised");
  assert.equal(classifyChange({ target: "同一句", machineTranslation: "同一句" }), "confirmed");
  assert.equal(classifyChange({ target: "导入对照" }), "imported");
  assert.equal(classifyChange({ target: " 定稿 ", machineTranslation: "定稿" }), "confirmed", "前后空白不算改动");
});

test("极性判定只认显式 negative", () => {
  assert.equal(isNegativeEvidence({ polarity: "negative" }), true);
  assert.equal(isNegativeEvidence({ polarity: "positive" }), false);
  assert.equal(isNegativeEvidence({}), false, "缺省按正例处理，兼容历史数据");
});

test("改写证据带上 machineDraft，原样采纳和导入不带", () => {
  const { examples } = shapeDistillEvidence([
    { source: "甲", target: "定稿甲", machineTranslation: "初稿甲" },
    { source: "乙", target: "乙译", machineTranslation: "乙译" },
    { source: "丙", target: "丙译" }
  ]);
  const byChange = Object.fromEntries(examples.map((item) => [item.change, item]));
  assert.equal(byChange.revised.machineDraft, "初稿甲");
  assert.equal(byChange.confirmed.machineDraft, undefined, "没有改动就不要给模型一个假的对照");
  assert.equal(byChange.imported.machineDraft, undefined);
});

test("改写证据优先占用样本额度", () => {
  const evidence = [
    ...Array.from({ length: 40 }, (_, index) => ({ source: `导入${index}`, target: `导入译${index}` })),
    { source: "改写句", target: "人工定稿", machineTranslation: "机器初稿" }
  ];
  const { examples, counts } = shapeDistillEvidence(evidence, { positiveLimit: 30 });
  assert.equal(examples.length, 30);
  assert.equal(counts.revised, 1);
  assert.equal(examples[0].change, "revised", "改写排在最前，不会被大量导入对照挤掉");
});

test("反例单独成列并保留否决理由，不混进正例", () => {
  const { examples, counterExamples, counts } = shapeDistillEvidence([
    { source: "甲", target: "好译法", machineTranslation: "旧译法" },
    { source: "乙", target: "被否决的译文", polarity: "negative", note: "语气太硬" }
  ]);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].target, "好译法");
  assert.deepEqual(counterExamples, [{ source: "乙", rejected: "被否决的译文", reason: "语气太硬" }]);
  assert.equal(counts.negative, 1);
});

test("空原文或空译文的残缺记录被丢弃", () => {
  const { examples, counterExamples } = shapeDistillEvidence([
    { source: "", target: "有译文没原文" },
    { source: "有原文没译文", target: "" },
    { source: "反例也要有内容", target: "", polarity: "negative" }
  ]);
  assert.equal(examples.length, 0);
  assert.equal(counterExamples.length, 0);
});

test("反例的 target 为空时回退到 machineTranslation", () => {
  const { counterExamples } = shapeDistillEvidence([
    { source: "甲", target: "", machineTranslation: "被否决的机器译文", polarity: "negative", note: "翻译腔" }
  ]);
  assert.deepEqual(counterExamples, [{ source: "甲", rejected: "被否决的机器译文", reason: "翻译腔" }]);
});

test("positiveEvidenceOnly 挡住反例，供画像与 Auto QA 使用", () => {
  const kept = positiveEvidenceOnly([
    { source: "甲", target: "好译法" },
    { source: "乙", target: "被否决", polarity: "negative" },
    { source: "丙", target: "" }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, "甲");
});

test("反例数量受独立上限约束", () => {
  const evidence = Array.from({ length: 25 }, (_, index) => ({ source: `否${index}`, target: `否译${index}`, polarity: "negative" }));
  const { counterExamples } = shapeDistillEvidence(evidence, { negativeLimit: 10 });
  assert.equal(counterExamples.length, 10);
});

test("输入不是数组时安全返回空结果", () => {
  const shaped = shapeDistillEvidence(null);
  assert.deepEqual(shaped.examples, []);
  assert.deepEqual(shaped.counterExamples, []);
});
