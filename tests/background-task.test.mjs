import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KAMI_DATA_DIR = mkdtempSync(join(tmpdir(), "kami-background-task-"));
delete process.env.KAMI_STORE;

const {
  deleteBackgroundTask,
  getBackgroundTask,
  initializeStore,
  listBackgroundTasks,
  saveBackgroundTask
} = await import("../src/store.mjs");
await initializeStore();

test("后台任务：创建、进度更新、按状态与搜索筛选、删除", async () => {
  const task = await saveBackgroundTask({ type: "batch_export", title: "导出 · 测试公告.txt", locale: "ja-JP" });
  assert.equal(task.status, "in_progress");
  const updated = await saveBackgroundTask({
    ...task,
    status: "completed",
    progress: { phase: "completed", message: "导出完成", percent: 100, completed: 1, total: 1 },
    payload: { downloadUrl: `/api/export-tasks/${task.id}/download` }
  });
  assert.equal(updated.status, "completed");
  assert.equal(updated.payload.downloadUrl, `/api/export-tasks/${task.id}/download`);
  const fetched = await getBackgroundTask(task.id);
  assert.equal(fetched.progress.percent, 100);
  const completed = await listBackgroundTasks({ status: "completed" });
  assert.ok(completed.some((item) => item.id === task.id));
  const bySearch = await listBackgroundTasks({ search: "测试公告" });
  assert.ok(bySearch.some((item) => item.id === task.id));
  const byLocale = await listBackgroundTasks({ locale: "ja-JP" });
  assert.ok(byLocale.some((item) => item.id === task.id));
  const none = await listBackgroundTasks({ locale: "ko-KR" });
  assert.ok(!none.some((item) => item.id === task.id));
  assert.equal(await deleteBackgroundTask(task.id), true);
  assert.equal(await getBackgroundTask(task.id), null);
  assert.equal(await deleteBackgroundTask(task.id), false);
});
