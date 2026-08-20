import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境必须在加载 provider 前就绪。
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-probe-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const requests = [];
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    requests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    if (requests.length === 1) {
      res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }));
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
mockServer.unref();
const port = mockServer.address().port;
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.LLM_MODEL = "reasoning-model";

const { probeModelAvailability } = await import("../src/provider.mjs");

test("模型探针为推理输出预留预算，并在长度耗尽时扩大预算重试", async () => {
  await assert.doesNotReject(() => probeModelAvailability({ timeoutMs: 2_000 }));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 64);
  assert.equal(requests[1].max_tokens, 128);
  assert.equal(requests[0].reasoning_effort, "low");
});
