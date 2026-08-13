export async function runTaskPool(tasks, worker, { concurrency = 5, onSettled = () => {} } = {}) {
  const items = Array.from(tasks || []);
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      onSettled(results[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
