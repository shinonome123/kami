import http from "node:http";

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const prompt = body.messages?.map((message) => message.content).join("\n") || "";
  const content = prompt.includes("术语对齐器")
    ? JSON.stringify({ suggestions: [{ index: 0, currentText: "高級パス", confidence: 0.93, reason: "与疑似源术语语义对应" }] })
    : prompt.includes("双语本地化审校")
      ? "PASS"
      : "高級パスが新登場しました。";
  const payload = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
});

server.listen(11435, "127.0.0.1", () => console.log("mock OpenAI server: http://127.0.0.1:11435/v1"));
