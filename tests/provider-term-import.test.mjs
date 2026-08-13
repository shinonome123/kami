import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { distillBatchStyleLearningWithModel, proposeTranslationSkillWithModel, reviewTermCandidatesWithModel, updateProviderConfig } from "../src/provider.mjs";

let server;
let baseUrl;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = (body.messages || []).map((message) => message.content).join("\n");
    const content = prompt.includes("本地化翻译流程改进员")
      ? JSON.stringify({
        name: "日语对白候选技能",
        reason: "三条轨迹反复出现说明文腔，建议加强口语节奏。",
        strategyPatch: { prompting: { additionalInstruction: "保持对白自然口语节奏。", additionalRules: ["避免说明文腔。"] } },
        evidenceIds: ["trajectory-1", "hallucinated-id"]
      })
      : prompt.includes("游戏本地化风格观察员")
      ? (prompt.includes("格式重试测试") && !prompt.includes("上一个回答不是可解析的严格 JSON")
        ? '{"summary":"未闭合的首轮响应","rules":['
        : JSON.stringify({
        summary: "本批偏向简洁、有力的对白。",
        rules: [{ category: "语气", observation: "使用短促命令句", guidance: "后续同类台词可优先保持简洁", confidence: 0.99 }],
        examples: [
          { source: "跟我来。", target: "ついてこい。", reason: "短促命令句" },
          { source: "模型编造", target: "偽造例", reason: "不存在的证据" }
        ],
        caveat: "当前只有一条例句。",
        confidence: 0.99
      }))
      : JSON.stringify({ decisions: [{ index: 0, keep: true, confidence: 0.96, rowKind: "memory", contentType: "dialogue", domain: "game", enforcement: "preferred", reason: "完整对白", nestedTerms: [] }] });
    const payload = JSON.stringify({ choices: [{ message: { content } }] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  updateProviderConfig({ baseUrl, model: "test-model", persist: false });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("术语审核模型遗漏 decision 时不会虚报整批已审核", async () => {
  const candidates = [
    { assetType: "memory", sheetMode: "dialogue", source: "孙悟空回来了。", target: "孫悟空が戻った。", score: 0.8, reasons: [] },
    { assetType: "memory", sheetMode: "dialogue", source: "八戒也回来了。", target: "八戒も戻った。", score: 0.8, reasons: [] }
  ];
  await assert.rejects(() => reviewTermCandidatesWithModel("ja-JP", candidates), /已覆盖 1\/2 条.*缺少 index 1/u);
});

test("单条批次风格学习保持证据边界并限制置信度", async () => {
  const learned = await distillBatchStyleLearningWithModel({
    batchId: "batch-1",
    filename: "对白.xlsx",
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    examples: [{ source: "跟我来。", target: "ついてこい。", rowNumber: 2 }]
  });
  assert.equal(learned.confidence, 0.65);
  assert.equal(learned.rules[0].confidence, 0.65);
  assert.equal(learned.examples.length, 1);
  assert.equal(learned.examples[0].source, "跟我来。");
  assert.match(learned.caveat, /一条/u);
});

test("批次风格学习首轮 JSON 损坏时自动紧凑重试", async () => {
  const learned = await distillBatchStyleLearningWithModel({
    batchId: "batch-retry",
    filename: "格式重试测试.xlsx",
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    examples: [{ source: "跟我来。", target: "ついてこい。", rowNumber: 2 }]
  });
  assert.equal(learned.summary, "本批偏向简洁、有力的对白。");
  assert.equal(learned.examples.length, 1);
});

test("翻译技能复盘只保留真实轨迹证据并返回隔离策略补丁", async () => {
  const proposed = await proposeTranslationSkillWithModel({
    locale: "ja-JP",
    contentType: "dialogue",
    domain: "game",
    project: "default",
    champion: { id: "champion-v1", version: 1, strategy: {} },
    trajectories: [{ id: "trajectory-1", source: "别怕。", initialTranslation: "恐れるな。", finalTranslation: "怖がるな。", qaBefore: { qaScore: 82 }, qaAfter: { qaScore: 95 } }]
  });
  assert.equal(proposed.name, "日语对白候选技能");
  assert.deepEqual(proposed.evidenceIds, ["trajectory-1"]);
  assert.equal(proposed.strategyPatch.prompting.additionalRules[0], "避免说明文腔。");
});
