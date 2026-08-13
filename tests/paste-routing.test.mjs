import test from "node:test";
import assert from "node:assert/strict";
import { normalizePastedText, shouldRoutePasteToBatch } from "../public/paste-routing.js";

test("粘贴单句和长文都统一进入分句批次", () => {
  assert.equal(shouldRoutePasteToBatch("请先购买游戏本体。"), true);
  assert.equal(shouldRoutePasteToBatch("第一段。\n\n第二段！"), true);
  assert.equal(shouldRoutePasteToBatch("   \n  "), false);
});

test("粘贴文本统一换行但保留正文内部结构", () => {
  assert.equal(normalizePastedText("\r\n第一段。\r\n\r\n第二段！\r\n"), "第一段。\n\n第二段！");
});
