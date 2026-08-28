import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  requests.push({ method: req.method, url: req.url, body });
  let data;
  if (req.method === "GET" && req.url.startsWith("/items/style_profiles/target")) {
    data = { id: "target", target_locale: "ja-JP", content_type: "dialogue", domain: "game", status: "draft" };
  } else if (req.method === "GET" && req.url.startsWith("/items/style_profiles?")) {
    data = [
      { id: "old-v1", status: "active", domain: "game" },
      { id: "old-v3", status: "active", domain: "game" }
    ];
  } else if (req.method === "PATCH" && req.url === "/items/style_profiles") {
    data = body;
  } else if (req.method === "PATCH" && req.url === "/items/style_profiles/target") {
    data = { id: "target", status: "active" };
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { activateDirectusStyleProfile } = await import("../src/directus-store.mjs");

test("Directus 激活风格版本时按 locale × contentType × domain 退役全部旧 active", async () => {
  const activated = await activateDirectusStyleProfile("target");
  assert.deepEqual(activated, { id: "target", kind: "style_profile", status: "active" });
  const listRequest = requests.find((item) => item.method === "GET" && item.url.startsWith("/items/style_profiles?"));
  const parsed = new URL(`http://directus${listRequest.url}`);
  assert.equal(parsed.searchParams.get("fields"), "id,status,domain");
  assert.equal(parsed.searchParams.get("filter[target_locale][_eq]"), "ja-JP");
  assert.equal(parsed.searchParams.get("filter[content_type][_eq]"), "dialogue");
  assert.equal(parsed.searchParams.get("filter[domain][_eq]"), "game");
  assert.equal(parsed.searchParams.get("filter[status][_eq]"), "active");
  const bulkPatch = requests.find((item) => item.method === "PATCH" && item.url === "/items/style_profiles");
  assert.deepEqual(bulkPatch.body, [
    { id: "old-v1", status: "inactive" },
    { id: "old-v3", status: "inactive" }
  ]);
});
