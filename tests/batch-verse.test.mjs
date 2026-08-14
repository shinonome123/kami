import test from "node:test";
import assert from "node:assert/strict";
import { detectBatchVerse, normalizeBatchReferences, verseShape } from "../src/batch-verse.mjs";
import { buildContextPack } from "../src/context-pack.mjs";
import { classifyContent } from "../src/classifier.mjs";

const POEM = [
  "不杀生，仇恨永无止息",
  "不偷盗，强弱如我何异",
  "不邪淫，一切有情皆孽",
  "不妄语，梦幻泡影空虚",
  "不馋酒，忧怖涨落无常",
  "不耽乐，芳华刹那而已",
  "不贪眠，苦苦不得解脱",
  "不纵欲，诸行了无生趣"
];

test("verseShape 识别 3+7 等短句+长句结构", () => {
  assert.equal(verseShape("不杀生，仇恨永无止息"), "3+6");
  assert.equal(verseShape("一二三四，五六七八九十"), "4+6");
  assert.equal(verseShape("别怕，我在这儿。"), null, "带句号的两句普通对白不算");
  assert.equal(verseShape("全新限定皮肤现已上架。"), null);
  assert.equal(verseShape(""), null);
});

test("detectBatchVerse 要求至少 3 行同句式且占多数", () => {
  const poemSegments = POEM.map((source, index) => ({ id: `s${index + 1}`, source }));
  const detected = detectBatchVerse(poemSegments);
  assert.equal(detected.active, true);
  assert.equal(detected.shape, "3+6");
  assert.equal(detected.matchingCount, 8);

  const few = detectBatchVerse([{ source: POEM[0] }, { source: POEM[1] }, { source: "普通对话句子，没有排比结构。" }]);
  assert.equal(few, null, "不足 3 行不触发");

  const mixed = detectBatchVerse([
    { source: POEM[0] }, { source: POEM[1] }, { source: POEM[2] },
    { source: "这是普通长句，不属于排比结构。" }, { source: "另一个普通句子也在批次里。" }, { source: "再来一句普通文本凑数。" }
  ]);
  assert.equal(mixed, null, "3/6 未过半数不触发");

  assert.equal(detectBatchVerse([]), null);
});

test("normalizeBatchReferences 截断到 3 条并过滤空值", () => {
  const input = [
    { source: "不杀生，仇恨永无止息", target: "殺さず、恨みは永遠に止まぬ。" },
    { source: "", target: "空源" },
    { source: "不偷盗，强弱如我何异", target: "" },
    { source: "不邪淫，一切有情皆孽", target: "淫せず、すべての有情は業なり。" },
    { source: "不妄语，梦幻泡影空虚", target: "妄語せず、夢幻泡影は空なり。" }
  ];
  const normalized = normalizeBatchReferences(input);
  assert.deepEqual(normalized.map((item) => item.source), [POEM[0], POEM[2], POEM[3]]);
  assert.equal(normalizeBatchReferences("garbage").length, 0);
});

test("Context Pack 携带批次排比模板与锚点译文", () => {
  const pack = buildContextPack({
    source: POEM[3],
    locale: "ja-JP",
    classification: classifyContent(POEM[3], "dialogue"),
    matches: [],
    domain: "game",
    batchVerse: { active: true, shape: "3+6", matchingCount: 8 }
  });
  assert.deepEqual(pack.batchVerse, { active: true, shape: "3+6", matchingCount: 8 });
  assert.deepEqual(pack.batchReferences, []);

  const anchored = buildContextPack({
    source: POEM[3],
    locale: "ja-JP",
    classification: classifyContent(POEM[3], "dialogue"),
    matches: [],
    domain: "game",
    batchVerse: null,
    batchReferences: [{ source: POEM[0], target: "殺さず、恨みは永遠に止まぬ。" }]
  });
  assert.equal(anchored.batchVerse, null);
  assert.deepEqual(anchored.batchReferences, [{ source: POEM[0], target: "殺さず、恨みは永遠に止まぬ。" }]);
});
