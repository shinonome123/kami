import http from "node:http";

function mockVector(input) {
  const text = typeof input === "string" ? input : (Array.isArray(input) ? String(input[0] || "") : "");
  const vector = Array.from({ length: 8 }, (_, index) => {
    let sum = 0;
    for (const character of text) sum += character.codePointAt(0) * (index + 1);
    return Math.sin(sum * (index + 1) + index * 0.7);
  });
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return vector.map((value) => value / (norm || 1));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (req.url === "/v1/embeddings") {
    const payload = JSON.stringify({ data: [{ embedding: mockVector(body.input) }] });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const prompt = body.messages?.map((message) => message.content).join("\n") || "";
  const content = prompt.includes("Excel 表格结构分析器")
    ? JSON.stringify({ sheets: [{ sheet: "Delivery", headerRow: 1, confidence: 0.98, reason: "表头和列内容分布明确", columns: [
      { column: 1, label: "位置", role: "context", confidence: 0.99, reason: "投放位置" },
      { column: 2, label: "描述", role: "constraint", confidence: 0.94, reason: "样本为字符限制" },
      { column: 3, label: "DDL", role: "constraint", confidence: 0.99, reason: "交付日期" },
      { column: 4, label: "语种要求", role: "constraint", confidence: 0.99, reason: "语言要求" },
      { column: 5, label: "Chinese Simp.", role: "source_text", confidence: 0.99, reason: "简体中文正文" },
      { column: 6, label: "English", role: "existing_translation", confidence: 0.99, reason: "已有英文译文" }
    ] }] })
    : prompt.includes("术语表结构分析器")
    ? JSON.stringify({ sheets: [{ sheet: "Terms", headerRow: null, sourceColumn: 1, targetColumns: { "ja-JP": 2 }, confidence: 0.96, reason: "两列逐行中日对照" }] })
    : prompt.includes("风格资产编辑")
    ? JSON.stringify({ name: "日语宣发风格", instructions: "使用自然、克制且具有期待感的敬体；保留事实、日期和 CTA。", examples: [{ type: "positive", source: "活动现已开启。", target: "イベントが開始しました。", reason: "自然敬体" }] })
    : prompt.includes("独立于翻译器")
    ? JSON.stringify({ issues: [] })
    : prompt.includes("最终修订译者")
    ? "高級パスが新登場しました。"
    : prompt.includes("游戏本地化资产清洗员")
    ? JSON.stringify({ decisions: [{ index: 0, keep: true, confidence: 0.96, reason: "中日句段对齐" }, { index: 1, keep: true, confidence: 0.95, reason: "中日句段对齐" }] })
    : prompt.includes("术语对齐器")
    ? JSON.stringify({ suggestions: [{ index: 0, currentText: "高級パス", confidence: 0.93, reason: "与疑似源术语语义对应" }] })
    : prompt.includes("本地化翻译流程改进员")
    ? JSON.stringify({ name: "候选技能", reason: "高频术语漏用，建议收紧术语提示", strategyPatch: { prompting: { additionalInstruction: "优先核对强制术语", additionalRules: ["输出前逐项核对强制术语"] }, retrieval: { translationMemory: { limit: 8 } }, qa: { minimumScore: 90, maximumRevisionAttempts: 2 } }, evidenceIds: [] })
    : prompt.includes("双语本地化审校")
      ? "PASS"
      : "高級パスが新登場しました。";
  const payload = JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }
  });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
});

const port = Number(process.env.MOCK_OPENAI_PORT || 11435);
const listener = server.listen(port, "127.0.0.1", () => console.log(`mock OpenAI server: http://127.0.0.1:${port}/v1`));
listener.unref();
