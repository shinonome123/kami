import test from "node:test";
import assert from "node:assert/strict";
import { chunkDirectusRecords } from "../src/directus-store.mjs";

test("Directus bulk writes are split by UTF-8 byte size and item count", () => {
  const records = Array.from({ length: 1_921 }, (_, index) => ({
    id: index,
    source: `第 ${index + 1} 条中文候选`.repeat(8),
    target: `候補訳文 ${index + 1}`.repeat(8)
  }));
  const chunks = chunkDirectusRecords(records, { maxBytes: 32 * 1024, maxItems: 75 });

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), records);
  assert.ok(chunks.every((chunk) => chunk.length <= 75));
  assert.ok(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 32 * 1024));
});

test("a single oversized record remains intact for a precise Directus error", () => {
  const oversized = { source: "长".repeat(200), target: "訳".repeat(200) };
  const chunks = chunkDirectusRecords([oversized], { maxBytes: 64, maxItems: 10 });

  assert.deepEqual(chunks, [[oversized]]);
});
