import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-embedding-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const requests = [];
const mockServer = http.createServer((req, res) => {
  let text = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { text += chunk; });
  req.on("end", () => {
    const body = JSON.parse(text || "{}");
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { "content-type": "application/json" });
    if (body.model === "generic-embed") {
      res.end(JSON.stringify({ data: [{ embedding: [3, 4] }] }));
      return;
    }
    res.end(JSON.stringify({ data: { embedding: [3, 4] } }));
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
mockServer.unref();
const port = mockServer.address().port;

const { embed, updateProviderConfig } = await import("../src/provider.mjs");

test("Embedding 同时兼容豆包多模态完整端点、Base URL 与普通 OpenAI 端点", async () => {
  updateProviderConfig({
    embeddingModel: "doubao-embedding-vision-251215",
    embeddingBaseUrl: `http://127.0.0.1:${port}/api/v3/embeddings/multimodal`,
    embeddingApiKey: "embedding-secret",
    persist: false
  });
  const completeEndpointResult = await embed("完整端点探针");

  updateProviderConfig({
    embeddingModel: "doubao-embedding-vision-251215",
    embeddingBaseUrl: `http://127.0.0.1:${port}/api/v3`,
    persist: false
  });
  await embed("Base URL 探针");

  updateProviderConfig({
    embeddingModel: "generic-embed",
    embeddingBaseUrl: `http://127.0.0.1:${port}/v1/embeddings`,
    persist: false
  });
  const genericResult = await embed("普通端点探针");

  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "/api/v3/embeddings/multimodal");
  assert.equal(requests[1].url, "/api/v3/embeddings/multimodal");
  assert.equal(requests[2].url, "/v1/embeddings");
  assert.equal(requests[0].authorization, "Bearer embedding-secret");
  assert.deepEqual(requests[0].body.input, [{ type: "text", text: "完整端点探针" }]);
  assert.equal(requests[0].body.encoding_format, "float");
  assert.equal(requests[0].body.dimensions, 1024);
  assert.equal(requests[2].body.input, "普通端点探针");
  assert.deepEqual(completeEndpointResult.vector, [0.6, 0.8]);
  assert.deepEqual(genericResult.vector, [0.6, 0.8]);
});
