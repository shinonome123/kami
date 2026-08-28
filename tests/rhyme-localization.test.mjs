import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境先行：空 provider 配置 + 本地记录型 mock。
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-rhyme-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const joined = (body.messages || []).map((item) => item.content).join("\n");
    if (joined.includes("SEED_UNSUPPORTED") && body.seed !== undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unsupported parameter: seed" } }));
      return;
    }
    const content = joined.includes("韵文本地化师")
      ? "とことこ歩いて、ぶらぶら遊んで、銭のためなら馬にも牛にも。"
      : "行け行け行け、さすらえさすらえさすらえ、銭のためなら牛馬にもなろう。";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const port = server.address().port;
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.LLM_MODEL = "rhyme-test-model";

const { translateWithReflection } = await import("../src/provider.mjs");

const rhymePack = { rhymeLike: true, source: "走走走，游游游，甘为铜钱做马牛。", targetLanguage: "日语" };
const plainPack = { rhymeLike: false, source: "全新限定皮肤现已上架。", targetLanguage: "日语" };

test("韵文走专用本地化通道：高温度初译 + 再创作改写", async () => {
  const result = await translateWithReflection(rhymePack, { reflect: false });
  assert.equal(result.translation, "とことこ歩いて、ぶらぶら遊んで、銭のためなら馬にも牛にも。");
  assert.equal(result.reflection, "rhyme-localized");
  assert.equal(requests.length, 2, "初译 + 韵文本地化共两次调用");
  assert.equal(requests[0].temperature, 0.85, "初译使用高温度");
  assert.equal(requests[1].temperature, 0.85, "改写使用高温度");
});

test("普通文本 reflect=false 时只调用一次并使用默认温度", async () => {
  const before = requests.length;
  const result = await translateWithReflection(plainPack, { reflect: false });
  assert.equal(result.translation, "行け行け行け、さすらえさすらえさすらえ、銭のためなら牛馬にもなろう。");
  assert.equal(result.reflection, "");
  assert.equal(requests.length, before + 1);
  assert.equal(requests[before].temperature, 0.6, "普通文本使用创译温度 0.6");
});

test("评测可覆盖生产温度并向兼容上游传递固定 seed", async () => {
  const before = requests.length;
  await translateWithReflection(plainPack, { reflect: false, temperature: 0, seed: 20260828 });
  assert.equal(requests.length, before + 1);
  assert.equal(requests[before].temperature, 0);
  assert.equal(requests[before].seed, 20260828);
});

test("上游不支持 seed 时明确降级并回报可复现性警告", async () => {
  const warnings = [];
  const before = requests.length;
  await translateWithReflection({ ...plainPack, source: "SEED_UNSUPPORTED" }, {
    reflect: false,
    temperature: 0,
    seed: 42,
    onSeedUnsupported: (warning) => warnings.push(warning)
  });
  assert.equal(requests.length, before + 2);
  assert.equal(requests[before].seed, 42);
  assert.equal(requests[before + 1].seed, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不支持固定 seed/);
});
