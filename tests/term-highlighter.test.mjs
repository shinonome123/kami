import test from "node:test";
import assert from "node:assert/strict";
import { highlightTermMatches, renderTranslationMarkup } from "../public/term-highlighter.js";

test("译文中实际采用的正式译法显示术语标记", () => {
  const result = highlightTermMatches("プレミアムパスが登場。プレミアムパスを獲得しよう。", [{ term: { source: "高级通行证", target: "プレミアムパス" } }]);
  assert.equal(result.count, 2);
  assert.equal((result.html.match(/class="term-highlight"/g) || []).length, 2);
  assert.ok(result.html.includes("术语库命中：高级通行证 → プレミアムパス"));
});

test("未采用的命中术语不高亮，译文 HTML 始终转义", () => {
  const result = highlightTermMatches("別の表現<script>alert(1)</script>", [{ term: { source: "高级通行证", target: "プレミアムパス" } }]);
  assert.equal(result.count, 0);
  assert.ok(!result.html.includes("<script>"));
  assert.ok(result.html.includes("&lt;script&gt;"));
});

test("重叠术语优先标记最长正式译法", () => {
  const result = highlightTermMatches("サーバーメンテナンス", [
    { term: { source: "维护", target: "メンテナンス" } },
    { term: { source: "服务器维护", target: "サーバーメンテナンス" } }
  ]);
  assert.equal(result.count, 1);
  assert.ok(result.html.includes(">サーバーメンテナンス</span>"));
});

test("疑似译法显示可点击蓝色标记，正式译法优先于重叠建议", () => {
  const suggestion = { id: "suggest-1", currentText: "デジタル豪華エディション", replacement: "デジタルデラックス版" };
  const rendered = renderTranslationMarkup("デジタル豪華エディションが登場", [], [suggestion]);
  assert.equal(rendered.officialCount, 0);
  assert.equal(rendered.suggestionCount, 1);
  assert.ok(rendered.html.includes('class="term-suggestion"'));
  assert.ok(rendered.html.includes('data-suggestion-id="suggest-1"'));
});
